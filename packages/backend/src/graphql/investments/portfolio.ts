import assert from "node:assert";

import { and, eq, inArray, sql } from "drizzle-orm";
import type { Float, ID, Int } from "grats";

import { CURRENCIES, HOME_CURRENCY } from "@/config";
import { db } from "@/db";
import { model } from "@/db/drizzle-model";
import { Investments, InvestmentTransactions } from "@/db/schema/investments";
import { assertNoErrors, assertNotError } from "@/errors";
import { solveXirr } from "@/forecast/growth";
import { isNonNullish } from "@/is-truthy";

import type { Context } from "../context";
import type { Date as CalendarDate } from "../date";
import { assertCurrencyCode, Money } from "../money";
import {
  buildConnection,
  type Connection,
  decodeCursor,
  encodeCursor,
} from "../pagination";
import { loadCandlestick } from "./candlestick";
import { Investment } from "./index";
import {
  type InvestmentStats,
  type InvestmentStatsFilter,
  loadInvestmentStats,
} from "./stats";
import { loadTimeseries } from "./timeseries";

/** Anchoring period for `Portfolio.timeseries`. `YTD` spans the start of the current calendar year through today and ignores `length`. @gqlEnum */
export type PortfolioTimePeriod = "YEAR" | "MONTH" | "YTD" | "ALL";

/** Candle width unit for `Portfolio.candlestick`. @gqlEnum */
export type PortfolioCandleUnit = "DAY" | "WEEK" | "MONTH";

/** One line-chart sample: `x` days since the series' `initialDate`, `y` in major units of `currency`. @gqlType */
export type PortfolioTimeseriesPoint = {
  /** @gqlField */
  x: Int;
  /** @gqlField */
  y: Int;
};

/** Daily-valued time series of portfolio total, downsampled to at most 300 points while always preserving the first and last sample. @gqlType */
export type PortfolioTimeseries = {
  /** @gqlField */
  currency: string;
  /** @gqlField */
  initialDate: CalendarDate;
  /** @gqlField */
  points: PortfolioTimeseriesPoint[];
};

/** One OHLC candlestick bucket. `from` / `to` are the portfolio total at the bucket's start / end; `lo` / `hi` are the minimum / maximum across the bucket. All values are in major units of `currency`. @gqlType */
export type PortfolioCandlestickPoint = {
  /** Number of days (at start of candle) since `initialDate` on the parent `PortfolioCandlestick` @gqlField */
  x0: Int;
  /** Number of days (at end of candle) since `initialDate` on the parent `PortfolioCandlestick` @gqlField */
  x1: Int;
  /** Starting Y value in major currency units of the parent `PortfolioCandlestick` `currency` field @gqlField */
  from: Int;
  /** Ending Y value in major currency units of the parent `PortfolioCandlestick` `currency` field @gqlField */
  to: Int;
  /** Lowest Y value in major currency units of the parent `PortfolioCandlestick` `currency` field @gqlField */
  lo: Int;
  /** Highest Y value in major currency units of the parent `PortfolioCandlestick` `currency` field @gqlField */
  hi: Int;
};

/** OHLC-style time series of portfolio total, downsampled to at most 300 buckets while always preserving the first and last bucket. @gqlType */
export type PortfolioCandlestick = {
  /** @gqlField */
  currency: string;
  /** @gqlField */
  initialDate: CalendarDate;
  /** @gqlField */
  points: PortfolioCandlestickPoint[];
};

type Filters = {
  filterAssetIdIn: string[] | null;
  filterInvestmentIdIn: string[] | null;
  currency: string;
};

/** Aggregated view of the portfolio, optionally filtered by wrappers and/or investments. All money values are expressed in `currency`; investments in any other currency are excluded. @gqlType */
export class Portfolio {
  constructor(
    /** ISO-4217 code every aggregate on this `Portfolio` is expressed in. Investments held in other currencies are excluded from these numbers. @gqlField */
    public readonly currency: string,
    private readonly filterAssetIdIn: string[] | null,
    private readonly filterInvestmentIdIn: string[] | null,
    /** When `true`, every live-quote-sensitive field on this instance — `totalValue`, `totalGain`, `percentGain`, `xirr`, `dailyGain*` — falls back to the most recent cached close instead of the live intraday price. One portfolio-wide switch so the client can pin "end-of-last-trading-day" numbers across the whole dashboard without toggling each field. */
    private readonly skipLive: boolean = false,
  ) {}

  /** Synthetic, stable identifier derived from the filters + currency + `skipLive`. Used for client-side cache normalisation; not meaningful as an external key. `skipLive` is part of the id so a page that reads both the cached-close snapshot and the live snapshot keeps them as separate entities — otherwise Apollo would merge them and the first response's values would be clobbered by the second. @gqlField */
  get id(): ID {
    const assets = this.filterAssetIdIn
      ? [...this.filterAssetIdIn].sort().join(",")
      : "*";
    const investments = this.filterInvestmentIdIn
      ? [...this.filterInvestmentIdIn].sort().join(",")
      : "*";
    return `portfolio:${this.currency}:${assets}:${investments}:${this.skipLive ? "cached" : "live"}` as ID;
  }

  private get filters(): Filters {
    return {
      filterAssetIdIn: this.filterAssetIdIn,
      filterInvestmentIdIn: this.filterInvestmentIdIn,
      currency: this.currency,
    };
  }

  private get scale(): number {
    return CURRENCIES[this.currency as keyof typeof CURRENCIES].scale;
  }

  /** When this portfolio is scoped to exactly one investment (as emitted by `Query.portfolios`), the investment it represents. `null` for aggregate portfolios covering multiple investments. @gqlField */
  async investment(): Promise<Investment | null> {
    if (!this.filterInvestmentIdIn || this.filterInvestmentIdIn.length !== 1) {
      return null;
    }
    const row = await model("Investments").findById(
      this.filterInvestmentIdIn[0],
    );
    return Investment.load(row);
  }

  /** Current market value of the filtered portfolio — the today-price value of units currently held. Fully-sold positions contribute nothing; their realised gain is reflected by pulling `totalCost` down. Positions with no known price (neither a live quote nor any `InvestmentPrices` row) contribute zero rather than nulling the whole aggregate — matches the `timeseries` / `dailyGain*` fields' graceful-degradation behaviour so a single stale or unresolvable ticker doesn't wipe the headline. @gqlField */
  async totalValue(ctx: Context): Promise<Money | null> {
    const slices = await this.loadStats(ctx);
    let total = 0;
    for (const s of slices) {
      // `totalValueMinor` is `null` when any contributing held investment is
      // missing a price. Preserve that graceful degradation by treating it
      // as a zero contribution rather than nulling the whole aggregate.
      if (s.totalValueMinor !== null) total += s.totalValueMinor;
    }
    return Money.fromMinorDenomination(total, this.currency);
  }

  /** Net capital at stake: gross buys minus gross sells across every investment, including ones that are now fully sold (whose sell proceeds drag the number down or even negative when realised gains exceed gross bought). Excludes fees and taxes. @gqlField */
  async totalCost(ctx: Context): Promise<Money> {
    const slices = await this.loadStats(ctx);
    let total = 0;
    for (const s of slices) total += s.unitsPriceSum;
    return Money.fromMinorDenomination(total, this.currency);
  }

  /** Total return (realised + unrealised) on the filtered portfolio — `totalValue - totalCost`. @gqlField */
  async totalGain(ctx: Context): Promise<Money | null> {
    const value = await this.totalValue(ctx);
    if (value === null) return null;
    const cost = await this.totalCost(ctx);
    const diffMajor = value.amount - cost.amount;
    return Money.fromMinorDenomination(
      Math.round(diffMajor * 10 ** this.scale),
      this.currency,
    );
  }

  /** Total return as a fraction of `totalCost`. For a more robust performance number that accounts for the timing of deposits and withdrawals, use `xirr`. `null` if `totalValue` is unknown or `totalCost` is zero. @gqlField */
  async percentGain(ctx: Context): Promise<Float | null> {
    const value = await this.totalValue(ctx);
    if (value === null) return null;
    const cost = await this.totalCost(ctx);
    if (cost.amount === 0) return null;
    return ((value.amount - cost.amount) / cost.amount) as Float;
  }

  /** Annualised rate of return on the filtered portfolio computed from the full cash-flow history (every buy as a negative flow, every sell as a positive one) plus today's held market value as the terminal flow. Roughly what a spreadsheet's `XIRR` returns. Expressed as a decimal (`0.08` = 8 % / year). `null` when there aren't enough cash flows to solve or when the solver doesn't converge. Honours the instance-level `skipLive` — with `skipLive`, the terminal flow uses the most recent cached close instead of the live price. @gqlField */
  async xirr(ctx: Context): Promise<Float | null> {
    // Terminal flow = today's total value. Reuse what the stats loader
    // already computed (live-overlaid and currency-scoped); propagate `null`
    // the same way `stats.totalValueMinor` does — any contributing held
    // investment missing a price nulls the whole xirr.
    const slices = await this.loadStats(ctx);
    let todayValueMinor: number | null = 0;
    for (const s of slices) {
      if (s.totalValueMinor === null) {
        todayValueMinor = null;
        break;
      }
      todayValueMinor += s.totalValueMinor;
    }

    const txConditions = [sql`${Investments.currency} = ${this.currency}`];
    if (this.filterAssetIdIn && this.filterAssetIdIn.length > 0) {
      txConditions.push(
        inArray(InvestmentTransactions.assetId, this.filterAssetIdIn),
      );
    }
    if (this.filterInvestmentIdIn && this.filterInvestmentIdIn.length > 0) {
      txConditions.push(
        inArray(InvestmentTransactions.investmentId, this.filterInvestmentIdIn),
      );
    }
    const txRows = await db
      .select({
        date: InvestmentTransactions.date,
        units: InvestmentTransactions.units,
        price: InvestmentTransactions.price,
      })
      .from(InvestmentTransactions)
      .innerJoin(
        Investments,
        eq(Investments.id, InvestmentTransactions.investmentId),
      )
      .where(and(...txConditions));
    if (txRows.length === 0) return null;

    // Each buy is money out (negative), each sell is money in (positive).
    // `t.units` is already signed, so `-t.units × price` gets the right sign
    // in one step.
    const flows: { date: Date; amount: number }[] = txRows.map((t) => ({
      date: t.date,
      amount: -t.units * t.price,
    }));
    if (todayValueMinor === null) return null;
    if (todayValueMinor > 0) {
      flows.push({ date: new Date(), amount: todayValueMinor });
    }
    return solveXirr(flows) as Float | null;
  }

  /** Change in portfolio value over the most recent pricing interval — `Σ (live_price − previousClose) × unitsHeld` over every currently-held position with a live quote. Positions the portfolio no longer holds (`unitsHeld === 0`) and positions without a live quote are excluded, so a lapsed live quote for one ticker doesn't pollute the aggregate. `null` when no position has a live quote or when `skipLive` is set. @gqlField */
  async dailyGainValue(ctx: Context): Promise<Money | null> {
    if (this.skipLive) return null;
    const slices = await this.loadStats(ctx);
    let total: number | null = null;
    for (const s of slices) {
      if (s.dailyGainValueMinor === null) continue;
      total = (total ?? 0) + s.dailyGainValueMinor;
    }
    return total === null
      ? null
      : Money.fromMinorDenomination(total, this.currency);
  }

  /** Fractional change in portfolio value over the most recent pricing interval, computed from the same subset of currently-held, live-priced positions as `dailyGainValue` — `Σ Δ / Σ previousValue`. `null` when no qualifying position exists, when the previous total is zero, or when `skipLive` is set. @gqlField */
  async dailyGainPercent(ctx: Context): Promise<Float | null> {
    if (this.skipLive) return null;
    const slices = await this.loadStats(ctx);
    let gain = 0;
    let prev = 0;
    let any = false;
    for (const s of slices) {
      if (
        s.dailyGainValueMinor === null ||
        s.dailyGainPrevValueMinor === null
      ) {
        continue;
      }
      gain += s.dailyGainValueMinor;
      prev += s.dailyGainPrevValueMinor;
      any = true;
    }
    if (!any || prev === 0) return null;
    return (gain / prev) as Float;
  }

  /**
   * Expand the `Portfolio`'s filters into one stats-loader key per slice and
   * load them all. Keys share a `Context`-level `DataLoader`, so the whole
   * page's expansion — every `Portfolio` × every `filterAssetIdIn` × every
   * `filterInvestmentIdIn` — coalesces into one SQL regardless of how many
   * stats fields are selected or how many `Portfolio` instances the
   * request touches.
   */
  private async loadStats(ctx: Context): Promise<InvestmentStats[]> {
    const assets = this.filterAssetIdIn;
    const investments = this.filterInvestmentIdIn;
    const base = {
      currency: this.currency,
      skipLive: this.skipLive,
    } satisfies InvestmentStatsFilter;
    const keys: InvestmentStatsFilter[] = [];
    if (assets && investments) {
      for (const assetId of assets) {
        for (const investmentId of investments) {
          keys.push({ ...base, assetIds: [assetId], investmentId });
        }
      }
    } else if (assets) {
      for (const assetId of assets) keys.push({ ...base, assetIds: [assetId] });
    } else if (investments) {
      for (const investmentId of investments) {
        keys.push({ ...base, investmentId });
      }
    } else {
      keys.push(base);
    }
    return Promise.all(keys.map((k) => loadInvestmentStats(ctx, k)));
  }

  /** Daily-sampled line series of portfolio total over the requested period. @gqlField */
  async timeseries(
    ctx: Context,
    period: PortfolioTimePeriod,
    length?: Int | null,
  ): Promise<PortfolioTimeseries | null> {
    const loader = loadTimeseries(ctx);
    const options = {
      period,
      length: length ?? 1,
      skipLive: this.skipLive,
    };
    const combineSeries = (all: (PortfolioTimeseries | null | Error)[]) => {
      const series = all.filter(isNonNullish);
      assertNoErrors(series);
      if (!series.length) return null;
      return {
        ...series[0],
        points: series[0].points.map((v, i) => ({
          ...v,
          y: series.slice(1).reduce((a, s) => {
            assertNotError(s);
            return a + s.points[i].y;
          }, v.y),
        })),
      };
    };
    if (this.filterAssetIdIn) {
      if (this.filterInvestmentIdIn) {
        return combineSeries(
          await loader.loadMany(
            this.filterInvestmentIdIn.flatMap((investmentId) =>
              this.filterAssetIdIn!.map((assetId) => ({
                ...options,
                investmentId,
                assetId,
              })),
            ),
          ),
        );
      }
      return combineSeries(
        await loader.loadMany(
          this.filterAssetIdIn!.map((assetId) => ({
            ...options,
            assetId,
          })),
        ),
      );
    }
    if (this.filterInvestmentIdIn) {
      return combineSeries(
        await loader.loadMany(
          this.filterInvestmentIdIn!.map((investmentId) => ({
            ...options,
            investmentId,
          })),
        ),
      );
    }
    return loader.load(options);
  }

  /** Candlestick buckets of portfolio total over the requested period. @gqlField */
  async candlestick(
    ctx: Context,
    unit: PortfolioCandleUnit,
    length: Int = 1,
    /**
     * Maximum number of candle buckets to return. The series ends today and
     * extends backwards by `max × length` `unit`s.
     * @gqlAnnotate constraint(min: 1, max: 100)
     */
    max: Int = 50,
  ): Promise<PortfolioCandlestick> {
    assert(
      !this.filterInvestmentIdIn,
      "Portfolio.candlestick does not support filtering by investment ID",
    );
    const candlestick = await loadCandlestick(ctx).load({
      unit,
      length,
      max,
      assetIds: this.filterAssetIdIn ?? undefined,
      skipLive: this.skipLive,
    });
    assert(candlestick, "No data");
    return candlestick;
  }
}

const DEFAULT_PAGE_SIZE = 50;

/** One portfolio slice per investment held in the matching wrappers. Use this for stacked-per-investment charts: each edge's `node` is a single-investment `Portfolio`, and `node.investment` identifies which investment that slice represents.
 *
 * @gqlQueryField
 * @gqlAnnotate semanticNonNull
 */
export async function portfolios(
  filterAssetIdIn?: ID[] | null,
  /** ISO-4217 code to express all aggregates in. Investments held in any other currency are excluded. Defaults to the server's home currency. */
  currency?: string | null,
  first?: Int | null,
  after?: ID | null,
  /** When `true`, every value field on the returned `Portfolio` nodes (`totalValue`, `totalGain`, `percentGain`, `xirr`, `dailyGain*`) falls back to cached closes instead of the live intraday price. */
  skipLive?: boolean | null,
): Promise<Connection<Portfolio> | null> {
  const target = currency ?? HOME_CURRENCY;
  assertCurrencyCode(target);
  const limit = first ?? DEFAULT_PAGE_SIZE;
  const afterCursor = after ? decodeCursor(after) : null;

  const conditions = [sql`${Investments.currency} = ${target}`];
  if (filterAssetIdIn && filterAssetIdIn.length > 0) {
    const rowsInWrapper = await db
      .selectDistinct({ investmentId: InvestmentTransactions.investmentId })
      .from(InvestmentTransactions)
      .where(
        inArray(InvestmentTransactions.assetId, filterAssetIdIn as string[]),
      );
    const ids = rowsInWrapper.map((r) => r.investmentId);
    if (ids.length === 0) {
      return buildConnection<Portfolio>([], () => "" as ID, {
        hasNextPage: false,
        hasPreviousPage: afterCursor != null,
      });
    }
    conditions.push(inArray(Investments.id, ids));
  }

  const rows = await db
    .select({ id: Investments.id })
    .from(Investments)
    .where(and(...conditions))
    .orderBy(Investments.id);

  let startIndex = 0;
  if (afterCursor) {
    const idx = rows.findIndex((r) => r.id === afterCursor.i);
    if (idx === -1) {
      return buildConnection<Portfolio>([], () => "" as ID, {
        hasNextPage: false,
        hasPreviousPage: true,
      });
    }
    startIndex = idx + 1;
  }
  const slice = rows.slice(startIndex, startIndex + limit + 1);
  const hasNextPage = slice.length > limit;
  const page = hasNextPage ? slice.slice(0, limit) : slice;

  const filterAssets = filterAssetIdIn ? (filterAssetIdIn as string[]) : null;
  const skip = skipLive ?? false;
  const nodes = page.map(
    (r) => new Portfolio(target, filterAssets, [r.id], skip),
  );
  return buildConnection<Portfolio>(
    nodes,
    (node) => {
      const idx = nodes.indexOf(node);
      return encodeCursor(page[idx].id, page[idx].id);
    },
    { hasNextPage, hasPreviousPage: afterCursor != null },
  );
}

/** Aggregated view of the portfolio, optionally filtered by wrappers and/or investments. All money values are in `currency` (defaults to the server's home currency); investments held in any other currency are excluded.
 *
 * @gqlQueryField
 * @gqlAnnotate semanticNonNull
 */
export async function portfolio(
  filterAssetIdIn?: ID[] | null,
  filterInvestmentIdIn?: ID[] | null,
  /** ISO-4217 code to express all aggregates in. Investments held in any other currency are excluded. Defaults to the server's home currency. */
  currency?: string | null,
  /** When `true`, every value field on the returned `Portfolio` (`totalValue`, `totalGain`, `percentGain`, `xirr`, `dailyGain*`) falls back to cached closes instead of the live intraday price. */
  skipLive?: boolean | null,
): Promise<Portfolio | null> {
  const target = currency ?? HOME_CURRENCY;
  assertCurrencyCode(target);
  return new Portfolio(
    target,
    filterAssetIdIn ? (filterAssetIdIn as string[]) : null,
    filterInvestmentIdIn ? (filterInvestmentIdIn as string[]) : null,
    skipLive ?? false,
  );
}

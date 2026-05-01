import assert from "node:assert";

import DataLoader from "dataloader";
import { and, eq, exists, inArray, sql } from "drizzle-orm";
import type { Float, ID, Int } from "grats";

import { CURRENCIES, HOME_CURRENCY } from "@/config";
import { db } from "@/db";
import { model } from "@/db/drizzle-model";
import { Investments, InvestmentTransactions } from "@/db/schema/investments";
import { assertNoErrors, assertNotError } from "@/errors";
import { isNonNullish } from "@/is-truthy";

import { type Context, contextAwareDataLoader } from "../context";
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
import { loadPortfolioCashMinor } from "./portfolio-cash";
import { computePortfolioXirr } from "./portfolio-xirr";
import {
  type InvestmentStats,
  type InvestmentStatsFilter,
  loadInvestmentStats,
} from "./stats";
import { loadTimeseries } from "./timeseries";
import {
  loadInvestmentTransferInScopesForAsset,
  loadInvestmentTransferOutScopeForAsset,
} from "./transfers";

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

/** Share of the parent `Portfolio`'s current market value held in one investment. `fraction` is in `[0, 1]`; values across a `Portfolio.allocations` array sum to `1` (modulo floating-point error). Held investments missing a price are excluded entirely so they don't drag the denominator. @gqlType */
export class PortfolioAllocation {
  constructor(
    private readonly investmentId: string,
    /** Fraction of the `Portfolio`'s total value held in this investment, in `[0, 1]`. @gqlField */
    public readonly fraction: Float,
  ) {}

  /** @gqlField */
  async investment(): Promise<Investment> {
    const row = await model("Investments").findById(this.investmentId);
    return Investment.load(row);
  }
}

type Filters = {
  filterAssetIdIn: string[] | null;
  filterInvestmentIdIn: string[] | null;
  currency: string;
  /** Additional asset ids to include via inbound transfers (sources of `transfersIn` on the destination). When the destination is the only filter, an investment that's only held in a source still counts as in-scope. */
  extraAssetIds?: readonly string[];
};

/** Resolved transfer-aware view of `Portfolio.filterAssetIdIn`:
 *
 * - `effectiveAssetIds`: the user's filter with any asset whose outgoing transfer destination is also in the filter dropped (e.g. `[src, dest]` collapses to `[dest]` so the source's pre-transfer history flows through `dest`'s extras instead of contributing its own series and double-counting).
 * - `extrasByAsset`: for each surviving asset, every inbound transfer's source folded in (capped at the day before the transfer). Sources may include the dropped assets — that's the whole point of dropping them.
 * - `dateCap`: only set when `effectiveAssetIds` resolves to a single transferred-out wrapper whose destination is *not* in the user's filter (the standalone defunct-portfolio view); the wrapper is valued as of the day before the transfer.
 */
type EffectiveFilter = {
  effectiveAssetIds: string[] | null;
  extrasByAsset: Map<
    string,
    ReadonlyArray<{ assetId: string; dateCap: string }>
  >;
  dateCap: string | null;
};

type SoldOutCapKey = { assetId: string; currency: string };

async function fetchSoldOutCaps(
  assetIds: readonly string[],
  currency: string,
): Promise<Map<string, string>> {
  const rows = await db.execute<{ assetId: string; capDate: string }>(sql`
    WITH tx_adj AS (
      SELECT
        "InvestmentTransactions"."assetId",
        "InvestmentTransactions"."investmentId",
        "InvestmentTransactions".date,
        "InvestmentTransactions".units AS units_raw,
        "InvestmentTransactions".units * COALESCE(EXP((
          SELECT SUM(LN(s.ratio))
          FROM "InvestmentStockSplits" s
          WHERE s."investmentId" = "InvestmentTransactions"."investmentId"
            AND s.date > "InvestmentTransactions".date
        )), 1) AS adj_units
      FROM "InvestmentTransactions"
      WHERE ${inArray(InvestmentTransactions.assetId, [...assetIds])}
        AND "InvestmentTransactions".currency = ${currency}
    ),
    per_pos AS (
      SELECT "assetId", "investmentId", SUM(adj_units) AS net
      FROM tx_adj
      GROUP BY "assetId", "investmentId"
    ),
    sold_out AS (
      SELECT "assetId"
      FROM per_pos
      GROUP BY "assetId"
      HAVING BOOL_AND(ABS(net) < 1e-9)
    ),
    last_buy AS (
      SELECT "assetId", MAX(date) AS d
      FROM tx_adj
      WHERE units_raw > 0
      GROUP BY "assetId"
    )
    SELECT
      s."assetId" AS "assetId",
      ((
        SELECT MIN(t.date)
        FROM tx_adj t
        WHERE t."assetId" = s."assetId"
          AND t.units_raw < 0
          AND (lb.d IS NULL OR t.date > lb.d)
      ) - INTERVAL '1 day')::date::text AS "capDate"
    FROM sold_out s
    LEFT JOIN last_buy lb ON lb."assetId" = s."assetId"
  `);
  const out = new Map<string, string>();
  for (const r of rows.rows ?? rows) {
    if (r.capDate) out.set(r.assetId, r.capDate);
  }
  return out;
}

/** Per-request batched loader for sold-out caps. Keys are `(assetId, currency)`; the batch fn buckets by currency (typically just `HOME_CURRENCY`) and runs one SQL per bucket covering every requested asset id. */
const soldOutCapLoader = contextAwareDataLoader(
  () =>
    new DataLoader<SoldOutCapKey, string | null, string>(
      async (keys) => {
        const buckets = new Map<string, string[]>();
        for (const k of keys) {
          const list = buckets.get(k.currency) ?? [];
          list.push(k.assetId);
          buckets.set(k.currency, list);
        }
        const byCurrency = new Map<string, Map<string, string>>();
        await Promise.all(
          [...buckets.entries()].map(async ([currency, ids]) => {
            const caps = await fetchSoldOutCaps([...new Set(ids)], currency);
            byCurrency.set(currency, caps);
          }),
        );
        return keys.map(
          (k) => byCurrency.get(k.currency)?.get(k.assetId) ?? null,
        );
      },
      { cacheKeyFn: (k) => `${k.currency}|${k.assetId}` },
    ),
);

/** Per-asset cap for wrappers that have been wound down — every `(investmentId)` position now nets to zero. The cap lands one day before the *first sell of the closing sell-down sequence* (i.e. the earliest sell that comes after the last buy in the wrapper), not just one day before the final closing tx. That way the last chart bucket shows the wrapper at its pre-wind-down value rather than partway through the closing sells. Wrappers with at least one open position aren't returned. */
export async function loadAssetSoldOutCaps(
  ctx: Context,
  assetIds: readonly string[],
  currency: string,
): Promise<Map<string, string>> {
  if (assetIds.length === 0) return new Map();
  const loader = soldOutCapLoader(ctx);
  const caps = await loader.loadMany(
    assetIds.map((assetId) => ({ assetId, currency })),
  );
  const out = new Map<string, string>();
  for (let i = 0; i < assetIds.length; i++) {
    const c = caps[i];
    if (c instanceof Error) throw c;
    if (c) out.set(assetIds[i], c);
  }
  return out;
}

/** Aggregated view of the portfolio, optionally filtered by wrappers and/or investments. All money values are expressed in `currency`; investments in any other currency are excluded. @gqlType */
export class Portfolio {
  private effectiveFilterPromise: Promise<EffectiveFilter> | null = null;

  constructor(
    /** ISO-4217 code every aggregate on this `Portfolio` is expressed in. Investments held in other currencies are excluded from these numbers. @gqlField */
    public readonly currency: string,
    private readonly filterAssetIdIn: string[] | null,
    private readonly filterInvestmentIdIn: string[] | null,
    /** When `true`, every live-quote-sensitive field on this instance — `totalValue`, `totalGain`, `percentGain`, `xirr`, `dailyGain*` — falls back to the most recent cached close instead of the live intraday price. One portfolio-wide switch so the client can pin "end-of-last-trading-day" numbers across the whole dashboard without toggling each field. */
    private readonly skipLive: boolean = false,
  ) {}

  /** Resolve the transfer-aware filter for this `Portfolio` (see `EffectiveFilter`). Memoised per-instance. */
  private async loadEffectiveFilter(ctx: Context): Promise<EffectiveFilter> {
    this.effectiveFilterPromise ??= (async () => {
      const filter = this.filterAssetIdIn;
      if (!filter || filter.length === 0) {
        return {
          effectiveAssetIds: null,
          extrasByAsset: new Map(),
          dateCap: null,
        };
      }
      const filterSet = new Set(filter);
      // Three round-trips fan out in parallel against the full `filter` set
      // rather than serialising on `effective`: `effective` is always a
      // subset of `filter`, so speculatively fetching transfers-in /
      // sold-out caps for the dropped ids only adds a few rows to a
      // batched query, but collapses three sequential DataLoader trips
      // into one.
      const [outgoing, incomingByFilterIdx, soldOutCaps] = await Promise.all([
        Promise.all(
          filter.map((id) => loadInvestmentTransferOutScopeForAsset(ctx, id)),
        ),
        Promise.all(
          filter.map((id) => loadInvestmentTransferInScopesForAsset(ctx, id)),
        ),
        loadAssetSoldOutCaps(ctx, filter, this.currency),
      ]);
      // Drop any asset whose outgoing-transfer destination is also in the
      // filter — its pre-transfer history will flow through the destination's
      // extras, so keeping it would double-count.
      const effective: string[] = [];
      for (let i = 0; i < filter.length; i++) {
        const t = outgoing[i];
        if (t && filterSet.has(t.assetIdTo)) continue;
        effective.push(filter[i]);
      }
      const effectiveSet = new Set(effective);
      const dayBefore = (date: Date | string): string => {
        const d = new Date(date as unknown as Date);
        d.setUTCDate(d.getUTCDate() - 1);
        return d.toISOString().slice(0, 10);
      };
      const extrasByAsset = new Map<
        string,
        ReadonlyArray<{ assetId: string; dateCap: string }>
      >();
      for (let i = 0; i < filter.length; i++) {
        if (!effectiveSet.has(filter[i])) continue;
        const incoming = incomingByFilterIdx[i];
        if (incoming.length === 0) continue;
        extrasByAsset.set(
          filter[i],
          incoming.map((t) => ({
            assetId: t.assetIdFrom,
            dateCap: dayBefore(t.date),
          })),
        );
      }
      // Per-asset "defunct cap": either an outgoing transfer (cap =
      // transferDate − 1, by construction the destination isn't in the
      // filter) or an entirely sold-out wrapper (every position netted to
      // zero). When *every* effective asset has a cap, freeze the chart at
      // the latest such date so it ends on the last day with non-zero
      // holdings instead of dragging zero candles to today.
      const perAssetCap = (assetId: string): string | null => {
        const t = outgoing[filter.indexOf(assetId)];
        if (t) return dayBefore(t.date);
        return soldOutCaps.get(assetId) ?? null;
      };
      let dateCap: string | null = null;
      if (effective.length >= 1) {
        const caps = effective.flatMap((id) => {
          const c = perAssetCap(id);
          return c ? [c] : [];
        });
        if (caps.length === effective.length) {
          dateCap = caps.reduce((acc, d) => (d > acc ? d : acc));
        }
      }
      return { effectiveAssetIds: effective, extrasByAsset, dateCap };
    })();
    return this.effectiveFilterPromise;
  }

  /** Backwards-compat wrapper: union of all per-asset extras under `loadEffectiveFilter`. Used by single-stats-call resolvers (cash, allocations, scope-resolution helpers) that take one `extraScopes` shape. Per-asset resolvers should consume `extrasByAsset` directly. */
  private async loadExtraScopesUnion(
    ctx: Context,
  ): Promise<ReadonlyArray<{ assetId: string; dateCap: string }>> {
    const { extrasByAsset } = await this.loadEffectiveFilter(ctx);
    const seen = new Set<string>();
    const out: { assetId: string; dateCap: string }[] = [];
    for (const list of extrasByAsset.values()) {
      for (const e of list) {
        const key = `${e.assetId}@${e.dateCap}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(e);
      }
    }
    return out;
  }

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

  private async filtersWithExtras(ctx: Context): Promise<Filters> {
    const { effectiveAssetIds, extrasByAsset } =
      await this.loadEffectiveFilter(ctx);
    const extraAssetIds = new Set<string>();
    for (const list of extrasByAsset.values()) {
      for (const e of list) extraAssetIds.add(e.assetId);
    }
    return {
      filterAssetIdIn: effectiveAssetIds,
      filterInvestmentIdIn: this.filterInvestmentIdIn,
      currency: this.currency,
      extraAssetIds: [...extraAssetIds],
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

  /** Current market value of the held positions in the filtered portfolio — `Σ unitsHeld_in_filter × priceLatest_investment`. Fully-sold positions contribute nothing; their realised gain is reflected by pulling `totalCost` down. Positions with no known price contribute zero rather than nulling the whole aggregate. Cash held in the wrapper is *not* added in here (use `Portfolio.cash` separately) — a holdings + cash combined number conflates investment performance with deposit timing. @gqlField */
  async totalValue(ctx: Context): Promise<Money | null> {
    const invested = await this.totalInvestedMinor(ctx);
    return Money.fromMinorDenomination(invested, this.currency);
  }

  /** Cash sits at the wrapper level; when the portfolio is scoped to specific investments (`filterInvestmentIdIn`) the cash float isn't attributable to any one investment, so we surface zero rather than double-counting it across each investment slice. A transferred-out wrapper also reads zero — its cash moved across with the holdings. A transferred-into wrapper folds in each source's pre-transfer cash flows. */
  private async cashMinor(ctx: Context): Promise<number> {
    if (this.filterInvestmentIdIn) return 0;
    const { effectiveAssetIds, dateCap } = await this.loadEffectiveFilter(ctx);
    if (dateCap) return 0;
    const extraScopes = await this.loadExtraScopesUnion(ctx);
    return loadPortfolioCashMinor(
      ctx,
      effectiveAssetIds,
      this.currency,
      extraScopes,
    );
  }

  private async totalInvestedMinor(ctx: Context): Promise<number> {
    const slices = await this.loadStats(ctx);
    let total = 0;
    for (const s of slices) {
      // `totalValueMinor` is `null` when any contributing held investment is
      // missing a price. Preserve that graceful degradation by treating it
      // as a zero contribution rather than nulling the whole aggregate.
      if (s.totalValueMinor !== null) total += s.totalValueMinor;
    }
    return total;
  }

  /** Uninvested cash held in the wrapper(s) — the per-wrapper cash float aggregated across the portfolio's `filterAssetIdIn` (or every `STOCK` / `PENSION` wrapper when no asset filter is set), restricted to entries denominated in `currency`. Always zero when the portfolio is scoped to specific investments (cash isn't attributable to an investment). Positive values represent cash available to invest; negative values mean recorded buys exceed recorded inflows. @gqlField */
  async cash(ctx: Context): Promise<Money> {
    const minor = await this.cashMinor(ctx);
    return Money.fromMinorDenomination(minor, this.currency);
  }

  /** Net capital at stake: gross buys minus gross sells across every investment, including ones that are now fully sold (whose sell proceeds drag the number down or even negative when realised gains exceed gross bought). Excludes fees and taxes. @gqlField */
  async totalCost(ctx: Context): Promise<Money> {
    const slices = await this.loadStats(ctx);
    let total = 0;
    for (const s of slices) total += s.unitsPriceSum;
    return Money.fromMinorDenomination(total, this.currency);
  }

  /** Total return (realised + unrealised) on the held positions — `totalValue − totalCost`. `totalValue` already excludes cash, so freshly-deposited funds don't read as a gain. @gqlField */
  async totalGain(ctx: Context): Promise<Money | null> {
    const invested = await this.totalInvestedMinor(ctx);
    const cost = await this.totalCost(ctx);
    const costMinor = Math.round(cost.amount * 10 ** this.scale);
    return Money.fromMinorDenomination(invested - costMinor, this.currency);
  }

  /** Total return as a fraction of `totalCost`, computed from invested value only (cash float excluded). For a more robust performance number that accounts for the timing of deposits and withdrawals, use `xirr`. `null` when `totalCost` is zero. @gqlField */
  async percentGain(ctx: Context): Promise<Float | null> {
    const invested = await this.totalInvestedMinor(ctx);
    const cost = await this.totalCost(ctx);
    const costMinor = Math.round(cost.amount * 10 ** this.scale);
    if (costMinor === 0) return null;
    return ((invested - costMinor) / costMinor) as Float;
  }

  /** Annualised rate of return on the filtered portfolio computed from the full cash-flow history (every buy as a negative flow, every sell as a positive one) plus today's held market value as the terminal flow. Roughly what a spreadsheet's `XIRR` returns. Expressed as a decimal (`0.08` = 8 % / year). `null` when there aren't enough cash flows to solve or when the solver doesn't converge. Honours the instance-level `skipLive` — with `skipLive`, the terminal flow uses the most recent cached close instead of the live price. @gqlField */
  async xirr(ctx: Context): Promise<Float | null> {
    const { effectiveAssetIds, dateCap } = await this.loadEffectiveFilter(ctx);
    const extraScopes = await this.loadExtraScopesUnion(ctx);
    return (await computePortfolioXirr(ctx, {
      currency: this.currency,
      assetIds: effectiveAssetIds,
      investmentIds: this.filterInvestmentIdIn,
      skipLive: this.skipLive,
      ...(dateCap ? { dateCap } : {}),
      ...(extraScopes.length > 0 ? { extraScopes } : {}),
    })) as Float | null;
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
    const { effectiveAssetIds, extrasByAsset, dateCap } =
      await this.loadEffectiveFilter(ctx);
    const investments = this.filterInvestmentIdIn;
    const baseCommon = {
      currency: this.currency,
      skipLive: this.skipLive,
    } satisfies InvestmentStatsFilter;
    const perAsset = (assetId: string): InvestmentStatsFilter => {
      const extras = extrasByAsset.get(assetId);
      return {
        ...baseCommon,
        assetIds: [assetId],
        ...(dateCap ? { dateCap } : {}),
        ...(extras && extras.length > 0 ? { extraScopes: extras } : {}),
      };
    };
    const keys: InvestmentStatsFilter[] = [];
    if (effectiveAssetIds && investments) {
      for (const assetId of effectiveAssetIds) {
        for (const investmentId of investments) {
          keys.push({ ...perAsset(assetId), investmentId });
        }
      }
    } else if (effectiveAssetIds) {
      for (const assetId of effectiveAssetIds) keys.push(perAsset(assetId));
    } else if (investments) {
      for (const investmentId of investments) {
        keys.push({ ...baseCommon, investmentId });
      }
    } else {
      keys.push(baseCommon);
    }
    return Promise.all(keys.map((k) => loadInvestmentStats(ctx, k)));
  }

  /** Per-investment breakdown of the filtered portfolio's current market value, expressed as fractions in `[0, 1]` that sum to `1`. Each entry pairs an investment with its share. Investments that contribute zero value (no holdings, fully sold, or missing a price) are excluded; the remaining fractions are renormalised over those that do contribute. Returns an empty array when the portfolio has no positive value. @gqlField */
  async allocations(ctx: Context): Promise<PortfolioAllocation[]> {
    const investmentIds = await loadInvestmentIdsInScope(
      await this.filtersWithExtras(ctx),
    );
    if (investmentIds.length === 0) return [];
    const { effectiveAssetIds, dateCap } = await this.loadEffectiveFilter(ctx);
    const extraScopes = await this.loadExtraScopesUnion(ctx);
    const perInvestment = await Promise.all(
      investmentIds.map(async (investmentId) => {
        const stats = await loadInvestmentStats(ctx, {
          investmentId,
          assetIds: effectiveAssetIds ?? undefined,
          currency: this.currency,
          skipLive: this.skipLive,
          ...(dateCap ? { dateCap } : {}),
          ...(extraScopes.length > 0 ? { extraScopes } : {}),
        });
        return { investmentId, value: stats.totalValueMinor ?? 0 };
      }),
    );
    const total = perInvestment.reduce((a, x) => a + x.value, 0);
    if (total <= 0) return [];
    return perInvestment
      .filter((x) => x.value > 0)
      .map(
        (x) =>
          new PortfolioAllocation(x.investmentId, (x.value / total) as Float),
      )
      .sort((a, b) => b.fraction - a.fraction);
  }

  /** Daily-sampled line series of portfolio total over the requested period. @gqlField */
  async timeseries(
    ctx: Context,
    period: PortfolioTimePeriod,
    length?: Int | null,
  ): Promise<PortfolioTimeseries | null> {
    const loader = loadTimeseries(ctx);
    const { effectiveAssetIds, extrasByAsset, dateCap } =
      await this.loadEffectiveFilter(ctx);
    const baseOptions = {
      period,
      length: length ?? 1,
      skipLive: this.skipLive,
      ...(dateCap ? { dateCap } : {}),
    };
    const optionsForAsset = (assetId: string) => {
      const extras = extrasByAsset.get(assetId);
      return {
        ...baseOptions,
        ...(extras && extras.length > 0 ? { extraScopes: extras } : {}),
      };
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
    if (effectiveAssetIds) {
      if (this.filterInvestmentIdIn) {
        return combineSeries(
          await loader.loadMany(
            this.filterInvestmentIdIn.flatMap((investmentId) =>
              effectiveAssetIds.map((assetId) => ({
                ...optionsForAsset(assetId),
                investmentId,
                assetId,
              })),
            ),
          ),
        );
      }
      return combineSeries(
        await loader.loadMany(
          effectiveAssetIds.map((assetId) => ({
            ...optionsForAsset(assetId),
            assetId,
          })),
        ),
      );
    }
    if (this.filterInvestmentIdIn) {
      return combineSeries(
        await loader.loadMany(
          this.filterInvestmentIdIn.map((investmentId) => ({
            ...baseOptions,
            investmentId,
          })),
        ),
      );
    }
    return loader.load(baseOptions);
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
  ): Promise<PortfolioCandlestick | null> {
    assert(
      !this.filterInvestmentIdIn,
      "Portfolio.candlestick does not support filtering by investment ID",
    );
    const { effectiveAssetIds, dateCap } = await this.loadEffectiveFilter(ctx);
    const extraScopes = await this.loadExtraScopesUnion(ctx);
    return loadCandlestick(ctx).load({
      unit,
      length,
      max,
      assetIds: effectiveAssetIds ?? undefined,
      skipLive: this.skipLive,
      ...(dateCap ? { dateCap } : {}),
      ...(extraScopes.length > 0 ? { extraScopes } : {}),
    });
  }
}

/**
 * Resolve the set of investment IDs that the current `Portfolio` filters
 * narrow down to: investments whose `currency` matches `filters.currency`
 * and (when set) that have at least one transaction in any of the
 * `filterAssetIdIn` wrappers, optionally further constrained by
 * `filterInvestmentIdIn`. Mirrors the visibility rules used by the rest of
 * the `Portfolio` resolvers — anything that wouldn't contribute to
 * `totalValue` is also dropped from `allocations`.
 */
async function loadInvestmentIdsInScope(filters: Filters): Promise<string[]> {
  const conditions = [sql`${Investments.currency} = ${filters.currency}`];
  if (filters.filterInvestmentIdIn && filters.filterInvestmentIdIn.length > 0) {
    conditions.push(inArray(Investments.id, filters.filterInvestmentIdIn));
  }
  if (filters.filterAssetIdIn && filters.filterAssetIdIn.length > 0) {
    const eligibleAssetIds = [
      ...filters.filterAssetIdIn,
      ...(filters.extraAssetIds ?? []),
    ];
    conditions.push(
      exists(
        db
          .select({ one: sql`1` })
          .from(InvestmentTransactions)
          .where(
            and(
              eq(InvestmentTransactions.investmentId, Investments.id),
              inArray(InvestmentTransactions.assetId, eligibleAssetIds),
            ),
          ),
      ),
    );
  }
  const rows = await db
    .select({ id: Investments.id })
    .from(Investments)
    .where(and(...conditions));
  return rows.map((r) => r.id);
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

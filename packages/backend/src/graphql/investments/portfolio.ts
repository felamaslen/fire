import { and, desc, inArray, sql } from "drizzle-orm";
import type { Float, ID, Int } from "grats";

import { CURRENCIES, HOME_CURRENCY } from "@/config";
import { db } from "@/db";
import {
  InvestmentPrices,
  Investments,
  InvestmentTransactions,
} from "@/db/schema/investments";
import { readOrRefresh } from "@/tasks/yahoo";

import type { Date as CalendarDate } from "../date";
import { assertCurrencyCode, Money } from "../money";
import {
  buildConnection,
  type Connection,
  decodeCursor,
  encodeCursor,
} from "../pagination";
import { Investment } from "./index";

/** Anchoring period for `Portfolio.timeseries` / `Portfolio.candlestick`. `YTD` spans the start of the current calendar year through today and ignores `length`. @gqlEnum */
export type PortfolioTimePeriod = "YEAR" | "MONTH" | "YTD";

const MAX_POINTS = 300;

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
  /** @gqlField */
  x: Int;
  /** @gqlField */
  from: Int;
  /** @gqlField */
  to: Int;
  /** @gqlField */
  lo: Int;
  /** @gqlField */
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

type HeldInvestment = {
  id: string;
  currency: string;
  unitsHeld: number;
  unitsPriceSum: number;
  priceLatest: number | null;
  pricePrevious: number | null;
};

async function loadHeldInvestments(
  filters: Filters,
): Promise<HeldInvestment[]> {
  // Restrict to investments whose currency matches the portfolio's currency.
  const matchingInvestments = await db
    .select({ id: Investments.id, stockCode: Investments.stockCode })
    .from(Investments)
    .where(sql`${Investments.currency} = ${filters.currency}`);
  if (matchingInvestments.length === 0) return [];
  const stockCodeById = new Map(
    matchingInvestments.map((r) => [r.id, r.stockCode]),
  );
  let investmentIds = matchingInvestments.map((r) => r.id);
  if (filters.filterInvestmentIdIn && filters.filterInvestmentIdIn.length > 0) {
    const allowed = new Set(filters.filterInvestmentIdIn);
    investmentIds = investmentIds.filter((id) => allowed.has(id));
  }
  if (investmentIds.length === 0) return [];

  const conditions = [
    inArray(InvestmentTransactions.investmentId, investmentIds),
  ];
  if (filters.filterAssetIdIn && filters.filterAssetIdIn.length > 0) {
    conditions.push(
      inArray(InvestmentTransactions.assetId, filters.filterAssetIdIn),
    );
  }

  const txRows = await db
    .select({
      investmentId: InvestmentTransactions.investmentId,
      units: sql<number>`SUM(${InvestmentTransactions.units})`.as("units"),
      unitsPriceSum:
        sql<number>`SUM(${InvestmentTransactions.units} * ${InvestmentTransactions.price})`.as(
          "unitsPriceSum",
        ),
    })
    .from(InvestmentTransactions)
    .where(and(...conditions))
    .groupBy(InvestmentTransactions.investmentId);

  if (txRows.length === 0) return [];

  const heldIds = txRows.map((r) => r.investmentId);
  const priceRows = await db
    .select({
      investmentId: InvestmentPrices.investmentId,
      priceAdjusted: InvestmentPrices.priceAdjusted,
    })
    .from(InvestmentPrices)
    .where(inArray(InvestmentPrices.investmentId, heldIds))
    .orderBy(InvestmentPrices.investmentId, desc(InvestmentPrices.date));
  const pricesByInvestment = new Map<string, number[]>();
  for (const p of priceRows) {
    const list = pricesByInvestment.get(p.investmentId) ?? [];
    list.push(p.priceAdjusted);
    pricesByInvestment.set(p.investmentId, list);
  }

  return txRows.map((r) => {
    const prices = pricesByInvestment.get(r.investmentId) ?? [];
    let priceLatest: number | null = prices[0] ?? null;
    let pricePrevious: number | null = prices[1] ?? null;
    const stockCode = stockCodeById.get(r.investmentId);
    if (stockCode) {
      const live = readOrRefresh(stockCode);
      if (live && live.currency === filters.currency) {
        pricePrevious = priceLatest;
        priceLatest = live.priceMinorUnits;
      }
    }
    return {
      id: r.investmentId,
      currency: filters.currency,
      unitsHeld: Number(r.units),
      unitsPriceSum: Number(r.unitsPriceSum),
      priceLatest,
      pricePrevious,
    };
  });
}

async function loadDailySeriesMinor(
  filters: Filters,
): Promise<Map<string, number>> {
  const held = await loadHeldInvestments(filters);
  if (held.length === 0) return new Map();

  const investmentIds = held.map((h) => h.id);
  const txConditions = [
    inArray(InvestmentTransactions.investmentId, investmentIds),
  ];
  if (filters.filterAssetIdIn && filters.filterAssetIdIn.length > 0) {
    txConditions.push(
      inArray(InvestmentTransactions.assetId, filters.filterAssetIdIn),
    );
  }
  const txRows = await db
    .select({
      investmentId: InvestmentTransactions.investmentId,
      date: InvestmentTransactions.date,
      units: InvestmentTransactions.units,
    })
    .from(InvestmentTransactions)
    .where(and(...txConditions));

  const priceRows = await db
    .select({
      investmentId: InvestmentPrices.investmentId,
      date: InvestmentPrices.date,
      price: InvestmentPrices.price,
    })
    .from(InvestmentPrices)
    .where(inArray(InvestmentPrices.investmentId, investmentIds))
    .orderBy(InvestmentPrices.investmentId, InvestmentPrices.date);

  if (priceRows.length === 0) return new Map();

  const txByInv = new Map<string, { date: Date; unitsCum: number }[]>();
  for (const t of [...txRows].sort(
    (a, b) =>
      a.date.getTime() - b.date.getTime() ||
      a.investmentId.localeCompare(b.investmentId),
  )) {
    const list = txByInv.get(t.investmentId) ?? [];
    const prev = list.length > 0 ? list[list.length - 1].unitsCum : 0;
    list.push({ date: t.date, unitsCum: prev + t.units });
    txByInv.set(t.investmentId, list);
  }
  const priceByInv = new Map<string, { date: Date; price: number }[]>();
  for (const p of priceRows) {
    const list = priceByInv.get(p.investmentId) ?? [];
    list.push(p);
    priceByInv.set(p.investmentId, list);
  }

  let minDate = priceRows[0].date;
  let maxDate = priceRows[0].date;
  for (const p of priceRows) {
    if (p.date < minDate) minDate = p.date;
    if (p.date > maxDate) maxDate = p.date;
  }

  const totals = new Map<string, number>();
  const msDay = 86400 * 1000;
  for (let d = minDate.getTime(); d <= maxDate.getTime(); d += msDay) {
    const day = new Date(d);
    let totalMinor = 0;
    for (const inv of held) {
      const units = lastOnOrBefore(
        txByInv.get(inv.id) ?? [],
        day,
        (x) => x.date,
        (x) => x.unitsCum,
        0,
      );
      const price = lastOnOrBefore(
        priceByInv.get(inv.id) ?? [],
        day,
        (x) => x.date,
        (x) => x.price,
        null,
      );
      if (price === null || units === 0) continue;
      totalMinor += units * price;
    }
    totals.set(day.toISOString().slice(0, 10), totalMinor);
  }
  return totals;
}

function lastOnOrBefore<T, V>(
  sorted: T[],
  day: Date,
  dateOf: (x: T) => Date,
  valueOf: (x: T) => V,
  fallback: V,
): V {
  let result: V = fallback;
  for (const item of sorted) {
    if (dateOf(item).getTime() <= day.getTime()) {
      result = valueOf(item);
    } else {
      break;
    }
  }
  return result;
}

function periodStart(
  today: Date,
  period: PortfolioTimePeriod,
  length: number,
): Date {
  if (period === "YTD") {
    return new Date(Date.UTC(today.getUTCFullYear(), 0, 1));
  }
  const d = new Date(today);
  if (period === "YEAR") d.setUTCFullYear(d.getUTCFullYear() - length);
  else d.setUTCMonth(d.getUTCMonth() - length);
  return d;
}

/** Aggregated view of the portfolio, optionally filtered by wrappers and/or investments. All money values are expressed in `currency`; investments in any other currency are excluded. @gqlType */
export class Portfolio {
  constructor(
    /** ISO-4217 code every aggregate on this `Portfolio` is expressed in. Investments held in other currencies are excluded from these numbers. @gqlField */
    public readonly currency: string,
    private readonly filterAssetIdIn: string[] | null,
    private readonly filterInvestmentIdIn: string[] | null,
  ) {}

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
    const id = this.filterInvestmentIdIn[0];
    const { eq } = await import("drizzle-orm");
    const [row] = await db
      .select()
      .from(Investments)
      .where(eq(Investments.id, id));
    return row ? Investment.load(row) : null;
  }

  /** Current market value of the filtered portfolio. Zero when nothing is held. @gqlField */
  async totalValue(): Promise<Money | null> {
    return this.aggregate((h) =>
      h.priceLatest === null ? null : h.unitsHeld * h.priceLatest,
    );
  }

  /** Net capital-in for currently held units (excluding fees and taxes). Each buy adds its consideration, each sell subtracts it. @gqlField */
  async totalCost(): Promise<Money> {
    const v = await this.aggregate((h) => h.unitsPriceSum);
    return v ?? Money.fromMinorDenomination(0, this.currency);
  }

  /** Unrealised gain on the filtered portfolio — `totalValue - totalCost`. @gqlField */
  async totalGain(): Promise<Money | null> {
    const value = await this.totalValue();
    if (value === null) return null;
    const cost = await this.totalCost();
    const diffMajor = value.amount - cost.amount;
    return Money.fromMinorDenomination(
      Math.round(diffMajor * 10 ** this.scale),
      this.currency,
    );
  }

  /** Unrealised gain as a fraction of `totalCost`. `null` if `totalValue` is unknown or `totalCost` is zero. @gqlField */
  async percentGain(): Promise<Float | null> {
    const value = await this.totalValue();
    if (value === null) return null;
    const cost = await this.totalCost();
    if (cost.amount === 0) return null;
    return ((value.amount - cost.amount) / cost.amount) as Float;
  }

  /** Change in portfolio value over the most recent pricing interval. When live quotes are available they're folded into each holding's latest price so this reflects today's move against yesterday's close. `null` until enough price history exists. @gqlField */
  async dailyGainValue(): Promise<Money | null> {
    return this.aggregate((h) => {
      if (h.priceLatest === null || h.pricePrevious === null) return null;
      return (h.priceLatest - h.pricePrevious) * h.unitsHeld;
    });
  }

  /** Fractional change in portfolio value over the most recent pricing interval. `null` until enough price history exists, or when the previous total is zero. @gqlField */
  async dailyGainPercent(): Promise<Float | null> {
    const [curr, prev] = await Promise.all([
      this.aggregate((h) =>
        h.priceLatest === null ? null : h.unitsHeld * h.priceLatest,
      ),
      this.aggregate((h) =>
        h.pricePrevious === null ? null : h.unitsHeld * h.pricePrevious,
      ),
    ]);
    if (curr === null || prev === null) return null;
    if (prev.amount === 0) return null;
    return ((curr.amount - prev.amount) / prev.amount) as Float;
  }

  /** Daily-sampled line series of portfolio total over the requested period. @gqlField */
  async timeseries(
    period: PortfolioTimePeriod,
    length?: Int | null,
  ): Promise<PortfolioTimeseries> {
    const { days, totals } = await this.buildDaily(period, length ?? 0);
    const picked = downsample(days, MAX_POINTS);
    return {
      currency: this.currency,
      initialDate: days[0] ?? new Date(),
      points: picked.map((d) => ({
        x: daysBetween(days[0], d) as Int,
        y: Math.round((totals.get(isoDate(d)) ?? 0) / 10 ** this.scale) as Int,
      })),
    };
  }

  /** Candlestick buckets of portfolio total over the requested period. @gqlField */
  async candlestick(
    period: PortfolioTimePeriod,
    length?: Int | null,
  ): Promise<PortfolioCandlestick> {
    const { days, totals } = await this.buildDaily(period, length ?? 0);
    const buckets = bucketIndices(days.length, MAX_POINTS);
    const points: PortfolioCandlestickPoint[] = buckets.map((range) => {
      const slice = days.slice(range.start, range.end + 1);
      const values = slice.map(
        (d) => (totals.get(isoDate(d)) ?? 0) / 10 ** this.scale,
      );
      const from = values[0];
      const to = values[values.length - 1];
      const lo = Math.min(...values);
      const hi = Math.max(...values);
      return {
        x: daysBetween(days[0], days[range.start]) as Int,
        from: Math.round(from) as Int,
        to: Math.round(to) as Int,
        lo: Math.round(lo) as Int,
        hi: Math.round(hi) as Int,
      };
    });
    return {
      currency: this.currency,
      initialDate: days[0] ?? new Date(),
      points,
    };
  }

  private async buildDaily(
    period: PortfolioTimePeriod,
    length: number,
  ): Promise<{ days: Date[]; totals: Map<string, number> }> {
    const fullTotals = await loadDailySeriesMinor(this.filters);
    if (fullTotals.size === 0) {
      return { days: [], totals: new Map() };
    }
    const today = new Date();
    const start = periodStart(today, period, length);
    const days: Date[] = [];
    for (const key of [...fullTotals.keys()].sort()) {
      const d = new Date(`${key}T00:00:00Z`);
      if (d >= start && d <= today) days.push(d);
    }
    return { days, totals: fullTotals };
  }

  private async aggregate(
    compute: (h: HeldInvestment) => number | null,
  ): Promise<Money | null> {
    const held = await loadHeldInvestments(this.filters);
    let total = 0;
    for (const h of held) {
      const rawMinor = compute(h);
      if (rawMinor === null) return null;
      total += rawMinor;
    }
    return Money.fromMinorDenomination(total, this.currency);
  }
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / (86400 * 1000));
}

function downsample<T>(xs: T[], max: number): T[] {
  if (xs.length <= max) return xs;
  const out: T[] = [];
  for (let i = 0; i < max - 1; i++) {
    const idx = Math.floor((i * (xs.length - 1)) / (max - 1));
    out.push(xs[idx]);
  }
  out.push(xs[xs.length - 1]);
  return out;
}

function bucketIndices(
  n: number,
  max: number,
): { start: number; end: number }[] {
  if (n === 0) return [];
  if (n <= max)
    return Array.from({ length: n }, (_, i) => ({ start: i, end: i }));
  const out: { start: number; end: number }[] = [];
  for (let i = 0; i < max; i++) {
    const start = Math.floor((i * n) / max);
    const end = Math.min(Math.floor(((i + 1) * n) / max) - 1, n - 1);
    out.push({ start, end: Math.max(end, start) });
  }
  out[out.length - 1].end = n - 1;
  return out;
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
  const nodes = page.map((r) => new Portfolio(target, filterAssets, [r.id]));
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
): Promise<Portfolio | null> {
  const target = currency ?? HOME_CURRENCY;
  assertCurrencyCode(target);
  return new Portfolio(
    target,
    filterAssetIdIn ? (filterAssetIdIn as string[]) : null,
    filterInvestmentIdIn ? (filterInvestmentIdIn as string[]) : null,
  );
}

import { and, desc, inArray, sql } from "drizzle-orm";
import type { Float, ID, Int } from "grats";

import { CURRENCIES, HOME_CURRENCY } from "@/config";
import { db } from "@/db";
import {
  InvestmentPrices,
  Investments,
  InvestmentStockSplits,
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
export type PortfolioTimePeriod = "YEAR" | "MONTH" | "YTD" | "ALL";

const MAX_LINE_POINTS = 300;
const MAX_CANDLE_BUCKETS = 100;
const MIN_CANDLE_BUCKET_DAYS = 3;

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
  /** Split-adjusted units currently held (today's share-count terms). */
  unitsHeld: number;
  /** Gross money ever spent buying this investment (buys only). */
  buyCostSum: number;
  /** Gross money ever received from sells (sells only, as a positive number). */
  sellValueSum: number;
  priceLatest: number | null;
  pricePrevious: number | null;
};

async function computePortfolioXirr(
  filters: Filters,
  opts: { skipLive: boolean },
): Promise<Float | null> {
  const held = await loadHeldInvestments(filters, opts);

  const investmentIds = held.map((h) => h.id);
  if (investmentIds.length === 0) return null;

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
      date: InvestmentTransactions.date,
      units: InvestmentTransactions.units,
      price: InvestmentTransactions.price,
    })
    .from(InvestmentTransactions)
    .where(and(...txConditions));

  // Cash flows: each buy is money out (negative), each sell is money in
  // (positive). `t.units` is already signed, so `-t.units × price` gets the
  // right sign in one step.
  const flows: { date: Date; amount: number }[] = txRows.map((t) => ({
    date: t.date,
    amount: -t.units * t.price,
  }));

  const today = new Date();
  let todayValue = 0;
  for (const h of held) {
    if (h.unitsHeld === 0) continue;
    if (h.priceLatest === null) return null;
    todayValue += h.unitsHeld * h.priceLatest;
  }
  if (todayValue > 0) flows.push({ date: today, amount: todayValue });

  return solveXirr(flows) as Float | null;
}

/** Newton-Raphson with a bisection fallback. `flows` must contain at least one positive and one negative entry. Returns the annualised rate as a decimal, or `null` when no sensible root is found. */
function solveXirr(flows: { date: Date; amount: number }[]): number | null {
  if (flows.length < 2) return null;
  const hasPos = flows.some((f) => f.amount > 0);
  const hasNeg = flows.some((f) => f.amount < 0);
  if (!hasPos || !hasNeg) return null;

  // Reference = earliest date; ages in fractional years since then.
  let refMs = flows[0].date.getTime();
  for (const f of flows) refMs = Math.min(refMs, f.date.getTime());
  const msPerYear = 365.25 * 24 * 60 * 60 * 1000;
  const ages = flows.map((f) => (f.date.getTime() - refMs) / msPerYear);

  const npv = (r: number): number => {
    let s = 0;
    for (let i = 0; i < flows.length; i++) {
      s += flows[i].amount / Math.pow(1 + r, ages[i]);
    }
    return s;
  };
  const dnpv = (r: number): number => {
    let s = 0;
    for (let i = 0; i < flows.length; i++) {
      if (ages[i] === 0) continue;
      s += (-ages[i] * flows[i].amount) / Math.pow(1 + r, ages[i] + 1);
    }
    return s;
  };

  // Newton-Raphson.
  let r = 0.1;
  for (let i = 0; i < 100; i++) {
    const v = npv(r);
    if (Math.abs(v) < 1e-7) return r;
    const d = dnpv(r);
    if (d === 0) break;
    const next = r - v / d;
    if (!Number.isFinite(next) || next <= -0.999) break;
    if (Math.abs(next - r) < 1e-9) return next;
    r = next;
  }

  // Bisection fallback over a wide bracket.
  let lo = -0.999;
  let hi = 10;
  let fLo = npv(lo);
  if (fLo * npv(hi) > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fMid = npv(mid);
    if (Math.abs(fMid) < 1e-7 || hi - lo < 1e-9) return mid;
    if (fLo * fMid < 0) {
      hi = mid;
    } else {
      lo = mid;
      fLo = fMid;
    }
  }
  return null;
}

async function loadHeldInvestments(
  filters: Filters,
  opts: { skipLive?: boolean } = {},
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

  // Pull raw transactions + splits so we can fold later splits into each
  // transaction's unit count. A pre-split buy of 100 units at a 10:1 ratio is
  // really 1000 of today's shares; the SQL `SUM(units)` alone would undercount.
  const [txRows, splitRows] = await Promise.all([
    db
      .select({
        investmentId: InvestmentTransactions.investmentId,
        date: InvestmentTransactions.date,
        units: InvestmentTransactions.units,
        price: InvestmentTransactions.price,
      })
      .from(InvestmentTransactions)
      .where(and(...conditions)),
    db
      .select({
        investmentId: InvestmentStockSplits.investmentId,
        date: InvestmentStockSplits.date,
        ratio: InvestmentStockSplits.ratio,
      })
      .from(InvestmentStockSplits)
      .where(inArray(InvestmentStockSplits.investmentId, investmentIds)),
  ]);

  if (txRows.length === 0) return [];

  const splitsByInvestment = new Map<string, { date: Date; ratio: number }[]>();
  for (const s of splitRows) {
    const list = splitsByInvestment.get(s.investmentId) ?? [];
    list.push({ date: s.date, ratio: Number(s.ratio) });
    splitsByInvestment.set(s.investmentId, list);
  }

  type Agg = {
    unitsHeld: number;
    buyCostSum: number;
    sellValueSum: number;
  };
  const aggByInvestment = new Map<string, Agg>();
  for (const t of txRows) {
    const splits = splitsByInvestment.get(t.investmentId) ?? [];
    let mult = 1;
    for (const s of splits) {
      if (s.date.getTime() > t.date.getTime()) mult *= s.ratio;
    }
    const agg = aggByInvestment.get(t.investmentId) ?? {
      unitsHeld: 0,
      buyCostSum: 0,
      sellValueSum: 0,
    };
    agg.unitsHeld += t.units * mult;
    if (t.units > 0) agg.buyCostSum += t.units * t.price;
    else if (t.units < 0) agg.sellValueSum += Math.abs(t.units) * t.price;
    aggByInvestment.set(t.investmentId, agg);
  }

  const heldIds = [...aggByInvestment.keys()];
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

  return [...aggByInvestment.entries()].map(([investmentId, agg]) => {
    const prices = pricesByInvestment.get(investmentId) ?? [];
    let priceLatest: number | null = prices[0] ?? null;
    let pricePrevious: number | null = prices[1] ?? null;
    const stockCode = stockCodeById.get(investmentId);
    if (stockCode && !opts.skipLive) {
      const live = readOrRefresh(stockCode);
      if (live && live.currency === filters.currency) {
        pricePrevious = priceLatest;
        priceLatest = live.priceMinorUnits;
      }
    }
    return {
      id: investmentId,
      currency: filters.currency,
      unitsHeld: agg.unitsHeld,
      buyCostSum: agg.buyCostSum,
      sellValueSum: agg.sellValueSum,
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
  const [txRows, splitRowsAll] = await Promise.all([
    db
      .select({
        investmentId: InvestmentTransactions.investmentId,
        date: InvestmentTransactions.date,
        units: InvestmentTransactions.units,
      })
      .from(InvestmentTransactions)
      .where(and(...txConditions)),
    db
      .select({
        investmentId: InvestmentStockSplits.investmentId,
        date: InvestmentStockSplits.date,
        ratio: InvestmentStockSplits.ratio,
      })
      .from(InvestmentStockSplits)
      .where(inArray(InvestmentStockSplits.investmentId, investmentIds)),
  ]);

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

  const splitsByInv = new Map<string, { date: Date; ratio: number }[]>();
  for (const s of splitRowsAll) {
    const list = splitsByInv.get(s.investmentId) ?? [];
    list.push({ date: s.date, ratio: Number(s.ratio) });
    splitsByInv.set(s.investmentId, list);
  }
  const txByInv = new Map<string, { date: Date; units: number }[]>();
  for (const t of [...txRows].sort(
    (a, b) =>
      a.date.getTime() - b.date.getTime() ||
      a.investmentId.localeCompare(b.investmentId),
  )) {
    const list = txByInv.get(t.investmentId) ?? [];
    list.push({ date: t.date, units: t.units });
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

  // Units-on-day for (investment, d) = Σ (tx.units × product(splits where
  // tx.date < split.date ≤ d)). Accumulates each transaction's share count
  // into today's share-count terms as of day `d`.
  const unitsOn = (investmentId: string, day: Date): number => {
    const txs = txByInv.get(investmentId) ?? [];
    const splits = splitsByInv.get(investmentId) ?? [];
    const dayMs = day.getTime();
    let total = 0;
    for (const t of txs) {
      if (t.date.getTime() > dayMs) break;
      let mult = 1;
      const txMs = t.date.getTime();
      for (const s of splits) {
        const sMs = s.date.getTime();
        if (sMs > txMs && sMs <= dayMs) mult *= s.ratio;
      }
      total += t.units * mult;
    }
    return total;
  };

  const totals = new Map<string, number>();
  const msDay = 86400 * 1000;
  for (let d = minDate.getTime(); d <= maxDate.getTime(); d += msDay) {
    const day = new Date(d);
    let totalMinor = 0;
    for (const inv of held) {
      const units = unitsOn(inv.id, day);
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

  // Always emit a final point for today using the same live-quote-aware
  // `priceLatest` the headline's aggregates use. Without this, the chart's
  // last point trails the headline (which folds in live quotes) and chart
  // days between the last cached `InvestmentPrices.date` and today are blank.
  const today = new Date();
  const todayKey = today.toISOString().slice(0, 10);
  let todayTotal = 0;
  for (const inv of held) {
    if (inv.unitsHeld === 0 || inv.priceLatest === null) continue;
    todayTotal += inv.unitsHeld * inv.priceLatest;
  }
  if (todayTotal > 0) {
    // Forward-fill every missing day between `maxDate` and today with the
    // cached per-day total, so the chart doesn't flatline from day N to today
    // while waiting for the live quote to re-anchor things.
    const lastKey = maxDate.toISOString().slice(0, 10);
    const lastValue = totals.get(lastKey) ?? 0;
    for (let d = maxDate.getTime() + msDay; d < today.getTime(); d += msDay) {
      const key = new Date(d).toISOString().slice(0, 10);
      if (!totals.has(key)) totals.set(key, lastValue);
    }
    totals.set(todayKey, todayTotal);
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
): Date | null {
  if (period === "ALL") return null;
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

  /** Synthetic, stable identifier derived from the filters + currency. Used for client-side cache normalisation; not meaningful as an external key. @gqlField */
  get id(): ID {
    const assets = this.filterAssetIdIn
      ? [...this.filterAssetIdIn].sort().join(",")
      : "*";
    const investments = this.filterInvestmentIdIn
      ? [...this.filterInvestmentIdIn].sort().join(",")
      : "*";
    return `portfolio:${this.currency}:${assets}:${investments}` as ID;
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
    const id = this.filterInvestmentIdIn[0];
    const { eq } = await import("drizzle-orm");
    const [row] = await db
      .select()
      .from(Investments)
      .where(eq(Investments.id, id));
    return row ? Investment.load(row) : null;
  }

  /** Current market value of the filtered portfolio — the today-price value of units currently held. Fully-sold positions contribute nothing; their realised gain is reflected by pulling `totalCost` down. @gqlField */
  async totalValue(): Promise<Money | null> {
    return this.aggregate((h) => {
      if (h.unitsHeld === 0) return 0;
      if (h.priceLatest === null) return null;
      return h.unitsHeld * h.priceLatest;
    });
  }

  /** Net capital at stake: gross buys minus gross sells across every investment, including ones that are now fully sold (whose sell proceeds drag the number down or even negative when realised gains exceed gross bought). Excludes fees and taxes. @gqlField */
  async totalCost(): Promise<Money> {
    const v = await this.aggregate((h) => h.buyCostSum - h.sellValueSum);
    return v ?? Money.fromMinorDenomination(0, this.currency);
  }

  /** Total return (realised + unrealised) on the filtered portfolio — `totalValue - totalCost`. @gqlField */
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

  /** Total return as a fraction of `totalCost`. For a more robust performance number that accounts for the timing of deposits and withdrawals, use `xirr`. `null` if `totalValue` is unknown or `totalCost` is zero. @gqlField */
  async percentGain(): Promise<Float | null> {
    const value = await this.totalValue();
    if (value === null) return null;
    const cost = await this.totalCost();
    if (cost.amount === 0) return null;
    return ((value.amount - cost.amount) / cost.amount) as Float;
  }

  /** Annualised rate of return on the filtered portfolio computed from the full cash-flow history (every buy as a negative flow, every sell as a positive one) plus today's held market value as the terminal flow. Roughly what a spreadsheet's `XIRR` returns. Expressed as a decimal (`0.08` = 8 % / year). `null` when there aren't enough cash flows to solve or when the solver doesn't converge. @gqlField */
  async xirr(
    /** When `true`, ignore any live quote and terminate against the most recent cached close instead. */
    skipLive?: boolean | null,
  ): Promise<Float | null> {
    return computePortfolioXirr(this.filters, { skipLive: skipLive ?? false });
  }

  /** Change in portfolio value over the most recent pricing interval. When live quotes are available they're folded into each holding's latest price so this reflects today's move against yesterday's close. Pass `skipLive: true` to compare the two most recent cached closes only. `null` until enough price history exists. @gqlField */
  async dailyGainValue(
    /** When `true`, ignore any live quote and compare the two most recent cached closes. */
    skipLive?: boolean | null,
  ): Promise<Money | null> {
    return this.aggregate(
      (h) => {
        if (h.priceLatest === null || h.pricePrevious === null) return null;
        return (h.priceLatest - h.pricePrevious) * h.unitsHeld;
      },
      { skipLive: skipLive ?? false },
    );
  }

  /** Fractional change in portfolio value over the most recent pricing interval. Pass `skipLive: true` to compare the two most recent cached closes only. `null` until enough price history exists, or when the previous total is zero. @gqlField */
  async dailyGainPercent(
    /** When `true`, ignore any live quote and compare the two most recent cached closes. */
    skipLive?: boolean | null,
  ): Promise<Float | null> {
    const opts = { skipLive: skipLive ?? false };
    const [curr, prev] = await Promise.all([
      this.aggregate(
        (h) => (h.priceLatest === null ? null : h.unitsHeld * h.priceLatest),
        opts,
      ),
      this.aggregate(
        (h) =>
          h.pricePrevious === null ? null : h.unitsHeld * h.pricePrevious,
        opts,
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
    const picked = downsample(days, MAX_LINE_POINTS);
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
    // Cap the bucket count by both the overall `MAX_CANDLE_BUCKETS` ceiling
    // and a minimum per-bucket width (in days) so dense ranges don't turn into
    // single-day candles that read as noise.
    const maxBucketsByWidth = Math.max(
      1,
      Math.ceil(days.length / MIN_CANDLE_BUCKET_DAYS),
    );
    const buckets = bucketIndices(
      days.length,
      Math.min(MAX_CANDLE_BUCKETS, maxBucketsByWidth),
    );
    // `from` carries over from the previous bucket's `to` so successive candles
    // line up visually (no gap between bucket N's close and bucket N+1's open).
    let prevTo: number | null = null;
    const points: PortfolioCandlestickPoint[] = buckets.map((range) => {
      const slice = days.slice(range.start, range.end + 1);
      const values = slice.map(
        (d) => (totals.get(isoDate(d)) ?? 0) / 10 ** this.scale,
      );
      const to = values[values.length - 1];
      const from = prevTo ?? values[0];
      const lo = Math.min(from, ...values);
      const hi = Math.max(from, ...values);
      prevTo = to;
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
      if (d <= today && (start === null || d >= start)) days.push(d);
    }
    return { days, totals: fullTotals };
  }

  private async aggregate(
    compute: (h: HeldInvestment) => number | null,
    opts: { skipLive?: boolean } = {},
  ): Promise<Money | null> {
    const held = await loadHeldInvestments(this.filters, opts);
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

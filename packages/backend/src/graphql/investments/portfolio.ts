import { and, inArray, sql } from "drizzle-orm";
import type { Float, ID, Int } from "grats";

import { CURRENCIES, HOME_CURRENCY } from "@/config";
import { db } from "@/db";
import { model } from "@/db/drizzle-model";
import {
  InvestmentPrices,
  Investments,
  InvestmentStockSplits,
  InvestmentTransactions,
} from "@/db/schema/investments";
import { solveXirr } from "@/forecast/growth";
import { readCachedQuote, readOrRefresh } from "@/tasks/yahoo";

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
  held: HeldInvestment[],
  filters: Filters,
): Promise<Float | null> {
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

/**
 * Canonical cache key for the portfolio-scope loaders, ignoring `filterInvestmentIdIn` — per-investment filtering is applied in memory on the shared result so a single underlying load answers both `portfolio()` (which spans all matching investments) and `portfolios()` (which paginates one Portfolio per investment). Live-quote state is *not* in the key either; the cached value only holds the slow DB-derived pieces (units held, cost basis, cached close prices) and the live quote is overlaid on every read via `readOrRefresh`, so an intraday quote refresh is always reflected in the next `Portfolio.totalValue` / `dailyGain*` call.
 */
function portfolioCacheKey(
  currency: string,
  filterAssetIdIn: string[] | null,
): string {
  const assets = filterAssetIdIn ? [...filterAssetIdIn].sort().join(",") : "*";
  return `${currency}|${assets}`;
}

type HeldCore = {
  id: string;
  currency: string;
  unitsHeld: number;
  buyCostSum: number;
  sellValueSum: number;
  priceLatestCached: number | null;
  pricePreviousCached: number | null;
  stockCode: string | null;
};

const heldCoreCache = new Map<string, Promise<HeldCore[]>>();
const dailyCache = new Map<string, Promise<Map<string, Map<string, number>>>>();

/** Drop every memoised held / daily-series result. Call from any mutation that changes InvestmentTransactions / InvestmentStockSplits / InvestmentPrices / Investments. The backend owns every mutation on these tables so stale reads never leak further than one mutation boundary. Live-quote drift is handled separately — the live overlay is applied at read time and doesn't depend on this cache. */
export function invalidatePortfolioCaches(): void {
  heldCoreCache.clear();
  dailyCache.clear();
}

async function loadHeldInvestments(
  filters: Filters,
  opts: { skipLive?: boolean } = {},
): Promise<HeldInvestment[]> {
  const skipLive = !!opts.skipLive;
  const key = portfolioCacheKey(filters.currency, filters.filterAssetIdIn);
  let p = heldCoreCache.get(key);
  if (!p) {
    p = loadHeldInvestmentsUncached({
      currency: filters.currency,
      filterAssetIdIn: filters.filterAssetIdIn,
      filterInvestmentIdIn: null,
    });
    heldCoreCache.set(key, p);
  }
  const core = await p;
  // Apply the live-quote overlay on every read so intraday quote refreshes
  // immediately surface in `Portfolio.totalValue` / `dailyGain*` without
  // needing to invalidate `heldCoreCache`. Skipping live keeps `priceLatest`
  // on the cached close for callers that want close-to-close comparisons.
  const overlaid = core.map((c) => overlayLive(c, filters.currency, skipLive));
  if (
    !filters.filterInvestmentIdIn ||
    filters.filterInvestmentIdIn.length === 0
  ) {
    return overlaid;
  }
  const allowed = new Set(filters.filterInvestmentIdIn);
  return overlaid.filter((h) => allowed.has(h.id));
}

function overlayLive(
  core: HeldCore,
  portfolioCurrency: string,
  skipLive: boolean,
): HeldInvestment {
  let priceLatest = core.priceLatestCached;
  let pricePrevious = core.pricePreviousCached;
  // `skipLive` controls *network* behaviour — it gates the stale-refresh
  // fetch, not the use of the live-quote LRU. Both modes read the cached
  // quote; the difference is which side of the day they report:
  //
  // - `skipLive: false` → `priceLatest = live`, `pricePrevious = previousClose`.
  //   `totalValue` = today's value, `dailyGain = live − previousClose`.
  // - `skipLive: true`  → `priceLatest = previousClose` for both sides.
  //   `totalValue` = yesterday's close value, `dailyGain = 0`.
  //
  // Sourcing yesterday's number from the live quote (rather than the DB's
  // `priceAdjusted`) keeps `totalValue(skipLive=true)` and
  // `totalValue(skipLive=false)` on the same measurement scale, so the
  // difference between the two matches `dailyGainValue` (which always
  // compares live vs. Yahoo's `previousClose`). The DB close is used only
  // as a last-resort fallback when the live LRU has never seen the ticker.
  if (core.stockCode && core.unitsHeld > 0) {
    const live = skipLive
      ? readCachedQuote(core.stockCode)
      : readOrRefresh(core.stockCode);
    if (live && live.currency === portfolioCurrency) {
      const prevClose = live.previousClosePriceMinorUnits;
      priceLatest = skipLive
        ? (prevClose ?? live.priceMinorUnits)
        : live.priceMinorUnits;
      pricePrevious = prevClose;
    }
  }
  return {
    id: core.id,
    currency: core.currency,
    unitsHeld: core.unitsHeld,
    buyCostSum: core.buyCostSum,
    sellValueSum: core.sellValueSum,
    priceLatest,
    pricePrevious,
  };
}

async function loadHeldInvestmentsUncached(
  filters: Filters,
): Promise<HeldCore[]> {
  // Restrict to investments whose currency matches the portfolio's currency.
  const matchingInvestments = await db
    .select({ id: Investments.id, stockCode: Investments.stockCode })
    .from(Investments)
    .where(sql`${Investments.currency} = ${filters.currency}`);
  if (matchingInvestments.length === 0) return [];
  const stockCodeById = new Map(
    matchingInvestments.map((r) => [r.id, r.stockCode]),
  );
  const investmentIds = matchingInvestments.map((r) => r.id);
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
  // Only the two most-recent `priceAdjusted` per investment are consumed
  // below (for `priceLatest` / `pricePrevious`). A `ROW_NUMBER()` window
  // narrows it to 2 rows per investment before the driver even sees the
  // data — still a seq-scan on the seed DB but we only pay for it once per
  // unique cache key (see `heldCache`).
  const recentPrice = db.$with("recent_price").as(
    db
      .select({
        investmentId: InvestmentPrices.investmentId,
        priceAdjusted: InvestmentPrices.priceAdjusted,
        rn: sql<number>`ROW_NUMBER() OVER (PARTITION BY ${InvestmentPrices.investmentId} ORDER BY ${InvestmentPrices.date} DESC)`.as(
          "rn",
        ),
      })
      .from(InvestmentPrices)
      .where(inArray(InvestmentPrices.investmentId, heldIds)),
  );
  const priceRows = await db
    .with(recentPrice)
    .select({
      investmentId: recentPrice.investmentId,
      priceAdjusted: recentPrice.priceAdjusted,
    })
    .from(recentPrice)
    .where(sql`${recentPrice.rn} <= 2`)
    .orderBy(recentPrice.investmentId, recentPrice.rn);
  const pricesByInvestment = new Map<string, number[]>();
  for (const p of priceRows) {
    const list = pricesByInvestment.get(p.investmentId) ?? [];
    list.push(p.priceAdjusted);
    pricesByInvestment.set(p.investmentId, list);
  }

  // Return the "core" (DB-derived, live-independent) shape. Live-quote
  // overlay is applied in `loadHeldInvestments` → `overlayLive` on every
  // read, so intraday quote refreshes don't require invalidating this cache.
  return [...aggByInvestment.entries()].map(([investmentId, agg]) => {
    const prices = pricesByInvestment.get(investmentId) ?? [];
    return {
      id: investmentId,
      currency: filters.currency,
      unitsHeld: agg.unitsHeld,
      buyCostSum: agg.buyCostSum,
      sellValueSum: agg.sellValueSum,
      priceLatestCached: prices[0] ?? null,
      pricePreviousCached: prices[1] ?? null,
      stockCode: stockCodeById.get(investmentId) ?? null,
    };
  });
}

/**
 * Returns each investment's daily contributions separately, memoised by `(currency, filterAssetIdIn)` — the expensive per-day iteration runs once per unique filter scope and is shared across `portfolio.buildDaily` (sums every investment) and `portfolios()` (one Portfolio per investment, each takes its own slice).
 *
 * Always computes for every investment matching `(currency, filterAssetIdIn)` regardless of `filterInvestmentIdIn` — callers are expected to aggregate only the investments they care about via `sumDailySeriesMinor` with an `investmentIds` filter.
 */
async function loadDailySeriesMinorByInvestment(
  filters: Filters,
): Promise<Map<string, Map<string, number>>> {
  const key = portfolioCacheKey(filters.currency, filters.filterAssetIdIn);
  let p = dailyCache.get(key);
  if (!p) {
    p = computeDailySeriesMinorByInvestment(filters);
    dailyCache.set(key, p);
  }
  return p;
}

async function computeDailySeriesMinorByInvestment(
  filters: Filters,
): Promise<Map<string, Map<string, number>>> {
  const held = await loadHeldInvestments({
    ...filters,
    filterInvestmentIdIn: null,
  });
  const perInv = new Map<string, Map<string, number>>();
  if (held.length === 0) return perInv;

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

  if (priceRows.length === 0) return perInv;

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
  for (const p of priceRows) {
    if (p.date < minDate) minDate = p.date;
  }

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

  const msDay = 86400 * 1000;
  const now = new Date();
  const today = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const todayMs = today.getTime();
  const todayKey = today.toISOString().slice(0, 10);

  for (const inv of held) {
    const invSplitMs = new Set(
      (splitsByInv.get(inv.id) ?? []).map((s) => s.date.getTime()),
    );
    const invPrices = priceByInv.get(inv.id) ?? [];
    const totals = new Map<string, number>();
    let lastValue = 0;
    for (let d = minDate.getTime(); d < todayMs; d += msDay) {
      const day = new Date(d);
      let v: number;
      if (invSplitMs.has(d)) {
        v = lastValue;
      } else {
        const units = unitsOn(inv.id, day);
        const price = lastOnOrBefore(
          invPrices,
          day,
          (x) => x.date,
          (x) => x.price,
          null,
        );
        v = price === null || units === 0 ? 0 : units * price;
      }
      const key = day.toISOString().slice(0, 10);
      totals.set(key, v);
      lastValue = v;
    }
    const todayV =
      inv.unitsHeld === 0 || inv.priceLatest === null
        ? 0
        : inv.unitsHeld * inv.priceLatest;
    totals.set(todayKey, todayV);
    perInv.set(inv.id, totals);
  }

  return perInv;
}

function sumDailySeriesMinor(
  perInv: Map<string, Map<string, number>>,
  investmentIds?: Iterable<string>,
): Map<string, number> {
  const ids = investmentIds !== undefined ? new Set(investmentIds) : null;
  const out = new Map<string, number>();
  for (const [id, totals] of perInv) {
    if (ids !== null && !ids.has(id)) continue;
    for (const [key, v] of totals) {
      out.set(key, (out.get(key) ?? 0) + v);
    }
  }
  return out;
}

async function loadDailySeriesMinor(
  filters: Filters,
): Promise<Map<string, number>> {
  const perInv = await loadDailySeriesMinorByInvestment(filters);
  const includeIds =
    filters.filterInvestmentIdIn && filters.filterInvestmentIdIn.length > 0
      ? filters.filterInvestmentIdIn
      : undefined;
  return sumDailySeriesMinor(perInv, includeIds);
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

/**
 * Optional pre-computed data used by `Portfolio` to avoid refetching when a single batch (e.g. `portfolios()`) has already loaded the full held + daily-series set for a shared `(currency, filterAssetIdIn)` scope. Only the `skipLive=false` `held` variant is preloaded; requesting `skipLive=true` (only `xirr` / `dailyGain*` do) falls back to a fresh fetch.
 */
export type PortfolioPreload = {
  held: HeldInvestment[];
  dailySeriesMinor: Map<string, number>;
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
    private readonly preload?: PortfolioPreload,
  ) {
    if (preload) this.heldCache = Promise.resolve(preload.held);
  }

  /** Per-instance memo of `loadHeldInvestments`. The live / skip-live choice is fixed at construction (via the `skipLive` arg on `Query.portfolio` / `Query.portfolios`), so a single fetch covers every Portfolio field the caller selected. */
  private heldCache: Promise<HeldInvestment[]> | null = null;

  private loadHeld(): Promise<HeldInvestment[]> {
    this.heldCache ??= loadHeldInvestments(this.filters, {
      skipLive: this.skipLive,
    });
    return this.heldCache;
  }

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
    const row = await model("Investments").findById(
      this.filterInvestmentIdIn[0],
    );
    return Investment.load(row);
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

  /** Annualised rate of return on the filtered portfolio computed from the full cash-flow history (every buy as a negative flow, every sell as a positive one) plus today's held market value as the terminal flow. Roughly what a spreadsheet's `XIRR` returns. Expressed as a decimal (`0.08` = 8 % / year). `null` when there aren't enough cash flows to solve or when the solver doesn't converge. Honours the instance-level `skipLive` — with `skipLive`, the terminal flow uses the most recent cached close instead of the live price. @gqlField */
  async xirr(): Promise<Float | null> {
    const held = await this.loadHeld();
    return computePortfolioXirr(held, this.filters);
  }

  /** Change in portfolio value over the most recent pricing interval — `Σ (live_price − previousClose) × unitsHeld` over every currently-held position with a live quote. Positions the portfolio no longer holds (`unitsHeld === 0`) and positions without a live quote (`pricePrevious === null`) are excluded, so a lapsed price history for one ticker doesn't pollute the aggregate. `null` when no position has a live quote or when `skipLive` is set. @gqlField */
  async dailyGainValue(): Promise<Money | null> {
    const totalMinor = await this.sumDailyGainMinor();
    if (totalMinor === null) return null;
    return Money.fromMinorDenomination(totalMinor, this.currency);
  }

  /** Fractional change in portfolio value over the most recent pricing interval, computed from the same subset of currently-held, live-priced positions as `dailyGainValue` — `Σ Δ / Σ previousValue`. `null` when no qualifying position exists, when the previous total is zero, or when `skipLive` is set. @gqlField */
  async dailyGainPercent(): Promise<Float | null> {
    if (this.skipLive) return null;
    const held = await this.loadHeld();
    let gain = 0;
    let prev = 0;
    let any = false;
    for (const h of held) {
      if (
        h.unitsHeld === 0 ||
        h.priceLatest === null ||
        h.pricePrevious === null
      ) {
        continue;
      }
      any = true;
      gain += (h.priceLatest - h.pricePrevious) * h.unitsHeld;
      prev += h.pricePrevious * h.unitsHeld;
    }
    if (!any || prev === 0) return null;
    return (gain / prev) as Float;
  }

  private async sumDailyGainMinor(): Promise<number | null> {
    if (this.skipLive) return null;
    const held = await this.loadHeld();
    let total = 0;
    let any = false;
    for (const h of held) {
      if (
        h.unitsHeld === 0 ||
        h.priceLatest === null ||
        h.pricePrevious === null
      ) {
        continue;
      }
      any = true;
      total += (h.priceLatest - h.pricePrevious) * h.unitsHeld;
    }
    return any ? total : null;
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
    const fullTotals =
      this.preload?.dailySeriesMinor ??
      (await loadDailySeriesMinor(this.filters));
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
  ): Promise<Money | null> {
    const held = await this.loadHeld();
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

  // Precompute held + per-investment daily series once for the whole page
  // instead of fanning out N independent loads — one `Portfolio` per
  // investment then receives its own single-investment slice via `preload`,
  // so building 100 nodes costs the same DB work as building one.
  const baseFilters = {
    filterAssetIdIn: filterAssets,
    filterInvestmentIdIn: null,
    currency: target,
  };
  const skip = skipLive ?? false;
  const [heldAll, seriesByInv] = await Promise.all([
    loadHeldInvestments(baseFilters, { skipLive: skip }),
    loadDailySeriesMinorByInvestment(baseFilters),
  ]);
  const heldById = new Map(heldAll.map((h) => [h.id, h]));
  const emptySeries = new Map<string, number>();

  const nodes = page.map((r) => {
    const held = heldById.get(r.id);
    return new Portfolio(target, filterAssets, [r.id], skip, {
      held: held ? [held] : [],
      dailySeriesMinor: seriesByInv.get(r.id) ?? emptySeries,
    });
  });
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

import { asc, desc, inArray } from "drizzle-orm";

import { db } from "@/db";
import {
  InvestmentPrices,
  Investments,
  InvestmentStockSplits,
  InvestmentTransactions,
} from "@/db/schema/investments";
import { readOrRefresh } from "@/tasks/yahoo";

import type { Context } from "../context";

/**
 * Aggregated numbers for an investment (optionally scoped to a single wrapper), computed from the raw transactions and the cached price history.
 *
 * All money values are in the investment's currency, in fractional units (e.g. pence for GBP).
 *
 * When a live Yahoo quote is cached for the investment's ticker, it is treated as `priceLatest` and the most recent cached close is shifted into `pricePrevious` so `dailyGainValue` reflects today's move against yesterday's close.
 */
export type InvestmentStats = {
  currency: string;
  /** Net units held = Σ units across all transactions (optionally filtered by `assetId`). */
  unitsHeld: number;
  /** Units acquired via DRIP (drip = true, units > 0). */
  reinvestedUnits: number;
  /** Σ (units × price) across all transactions. Buys add, sells subtract. Negative when realised gains exceed capital still invested. */
  unitsPriceSum: number;
  /** Σ (units × price) across DRIP buys only. */
  reinvestedCostSum: number;
  /** Σ (units × price) across buys only (units > 0). */
  buyCostSum: number;
  /** Σ (|units| × price) across sells only (units < 0). */
  sellValueSum: number;
  /** Σ taxes across all transactions (always non-negative). */
  taxesSum: number;
  /** Σ fees across all transactions (always non-negative). */
  feesSum: number;
  /** Most recent adjusted unit price, or `null` if no prices recorded. */
  priceLatest: number | null;
  /** Second-most-recent adjusted unit price, or `null` if fewer than two prices recorded. */
  pricePrevious: number | null;
};

/**
 * Load the raw stats for an investment (and optionally a wrapper). Caller combines them into `Money` / `Float` fields.
 *
 * Batched per `Context`: every `loadInvestmentStats` call issued in the same microtask is coalesced into four `IN (...)` selects (one each for `Investments`, `InvestmentTransactions`, `InvestmentStockSplits`, `InvestmentPrices`). Repeated calls for the same `(investmentId, assetId)` within the same request share the resolved promise, so `Investment.position`, `investments()`'s sort key, and any per-wrapper slice all key into the same fetch.
 */
export function loadInvestmentStats(
  ctx: Context,
  investmentId: string,
  assetId?: string,
): Promise<InvestmentStats> {
  const batcher = getBatcher(ctx);
  const key = `${investmentId}|${assetId ?? ""}`;

  const cached = batcher.cache.get(key);
  if (cached) return cached;

  let entry = batcher.pending.get(key);
  if (!entry) {
    entry = { investmentId, assetId, deferred: defer<InvestmentStats>() };
    batcher.pending.set(key, entry);
    if (!batcher.scheduled) {
      batcher.scheduled = true;
      queueMicrotask(() => {
        void flush(batcher);
      });
    }
  }
  batcher.cache.set(key, entry.deferred.promise);
  return entry.deferred.promise;
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
};

function defer<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type PendingEntry = {
  investmentId: string;
  assetId: string | undefined;
  deferred: Deferred<InvestmentStats>;
};

type Batcher = {
  pending: Map<string, PendingEntry>;
  cache: Map<string, Promise<InvestmentStats>>;
  scheduled: boolean;
};

const batchersByCtx = new WeakMap<Context, Batcher>();

function getBatcher(ctx: Context): Batcher {
  let b = batchersByCtx.get(ctx);
  if (!b) {
    b = { pending: new Map(), cache: new Map(), scheduled: false };
    batchersByCtx.set(ctx, b);
  }
  return b;
}

async function flush(batcher: Batcher): Promise<void> {
  const entries = [...batcher.pending.values()];
  batcher.pending.clear();
  batcher.scheduled = false;

  const ids = [...new Set(entries.map((e) => e.investmentId))];

  try {
    const [invRows, txRows, splitRows, priceRows] = await Promise.all([
      db
        .select({
          id: Investments.id,
          currency: Investments.currency,
          stockCode: Investments.stockCode,
        })
        .from(Investments)
        .where(inArray(Investments.id, ids)),
      db
        .select()
        .from(InvestmentTransactions)
        .where(inArray(InvestmentTransactions.investmentId, ids)),
      db
        .select({
          investmentId: InvestmentStockSplits.investmentId,
          date: InvestmentStockSplits.date,
          ratio: InvestmentStockSplits.ratio,
        })
        .from(InvestmentStockSplits)
        .where(inArray(InvestmentStockSplits.investmentId, ids))
        .orderBy(asc(InvestmentStockSplits.date)),
      db
        .select({
          investmentId: InvestmentPrices.investmentId,
          priceAdjusted: InvestmentPrices.priceAdjusted,
        })
        .from(InvestmentPrices)
        .where(inArray(InvestmentPrices.investmentId, ids))
        .orderBy(desc(InvestmentPrices.date)),
    ]);

    const invById = new Map(invRows.map((r) => [r.id, r]));
    const txByInv = groupBy(txRows, (r) => r.investmentId);
    const splitsByInv = groupBy(splitRows, (r) => r.investmentId);
    // Prices are already date-desc; `pricesByInv.get(id)[0..1]` is latest + previous.
    const pricesByInv = groupBy(priceRows, (r) => r.investmentId);

    for (const entry of entries) {
      try {
        const inv = invById.get(entry.investmentId);
        if (!inv) {
          throw new Error(`Investment ${entry.investmentId} not found`);
        }
        const txs = txByInv.get(entry.investmentId) ?? [];
        const splits = splitsByInv.get(entry.investmentId) ?? [];
        const prices = pricesByInv.get(entry.investmentId) ?? [];
        entry.deferred.resolve(
          computeStats(
            entry.assetId,
            inv.currency,
            inv.stockCode,
            txs,
            splits,
            prices,
          ),
        );
      } catch (err) {
        entry.deferred.reject(err);
      }
    }
  } catch (err) {
    for (const entry of entries) entry.deferred.reject(err);
  }
}

function groupBy<T, K>(xs: T[], key: (x: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const x of xs) {
    const k = key(x);
    const arr = m.get(k);
    if (arr) arr.push(x);
    else m.set(k, [x]);
  }
  return m;
}

function computeStats(
  assetId: string | undefined,
  currency: string,
  stockCode: string | null,
  txRows: (typeof InvestmentTransactions.$inferSelect)[],
  splitRows: { date: Date; ratio: string }[],
  priceRows: { priceAdjusted: number }[],
): InvestmentStats {
  const filteredTxs =
    assetId === undefined
      ? txRows
      : txRows.filter((r) => r.assetId === assetId);

  // Multiplier for a transaction dated `d`: product of every split's ratio
  // whose `date > d`. A pre-split buy of 100 units at a 10:1 ratio therefore
  // counts as 1000 of today's shares.
  const splitMultiplier = (txDate: Date): number => {
    let m = 1;
    for (const s of splitRows) {
      if (s.date.getTime() > txDate.getTime()) m *= Number(s.ratio);
    }
    return m;
  };

  let unitsHeld = 0;
  let reinvestedUnits = 0;
  let unitsPriceSum = 0;
  let reinvestedCostSum = 0;
  let buyCostSum = 0;
  let sellValueSum = 0;
  let taxesSum = 0;
  let feesSum = 0;
  for (const r of filteredTxs) {
    const mult = splitMultiplier(r.date);
    const adjustedUnits = r.units * mult;
    unitsHeld += adjustedUnits;
    // `unitsPriceSum` tracks cash in/out, which is not affected by splits —
    // the user paid `units × price` at the time regardless of later splits.
    unitsPriceSum += r.units * r.price;
    taxesSum += r.taxes;
    feesSum += r.fees;
    if (r.units > 0) buyCostSum += r.units * r.price;
    else if (r.units < 0) sellValueSum += Math.abs(r.units) * r.price;
    if (r.drip && r.units > 0) {
      reinvestedUnits += adjustedUnits;
      reinvestedCostSum += r.units * r.price;
    }
  }

  let priceLatest = priceRows[0]?.priceAdjusted ?? null;
  let pricePrevious = priceRows[1]?.priceAdjusted ?? null;

  // When a live quote is cached for a stock investment, treat it as the latest
  // price and shift the most recent cached close into the "previous" slot so
  // `dailyGain*` tracks today's move against yesterday's close.
  if (stockCode) {
    const live = readOrRefresh(stockCode);
    if (live && live.currency === currency) {
      pricePrevious = priceLatest;
      priceLatest = live.priceMinorUnits;
    }
  }

  return {
    currency,
    unitsHeld,
    reinvestedUnits,
    unitsPriceSum,
    reinvestedCostSum,
    buyCostSum,
    sellValueSum,
    taxesSum,
    feesSum,
    priceLatest,
    pricePrevious,
  };
}

/** True when transactions exist but no units are currently held (fully sold out). */
export function isFullySold(s: InvestmentStats): boolean {
  return s.unitsHeld === 0 && (s.buyCostSum > 0 || s.sellValueSum > 0);
}

/**
 * `cost basis = (Σ units × price) / units_held`, per the spec — "average price paid per share owned", adjusted by realised sales. Returns null when no units are held.
 */
export function costBasis(s: InvestmentStats): number | null {
  if (s.unitsHeld === 0) return null;
  return s.unitsPriceSum / s.unitsHeld;
}

/** Same as `costBasis` but also factoring in taxes + fees paid across every transaction. */
export function costBasisWithFees(s: InvestmentStats): number | null {
  if (s.unitsHeld === 0) return null;
  return (s.unitsPriceSum + s.taxesSum + s.feesSum) / s.unitsHeld;
}

/** Current market value of the position. For a fully-sold position this is the total realised sell proceeds; otherwise it's `unitsHeld × priceLatest`. `null` when no price is available for a held position. */
export function totalValue(s: InvestmentStats): number | null {
  if (isFullySold(s)) return s.sellValueSum;
  if (s.priceLatest === null) return null;
  return s.unitsHeld * s.priceLatest;
}

/** Capital deployed into the position. For a fully-sold position this is the gross sum spent on buys; otherwise it's the net capital in for the units currently held (`Σ signed_units × price`). */
export function totalCost(s: InvestmentStats): number {
  if (isFullySold(s)) return s.buyCostSum;
  return s.unitsPriceSum;
}

export function totalGain(s: InvestmentStats): number | null {
  const v = totalValue(s);
  if (v === null) return null;
  return v - totalCost(s);
}

export function percentGain(s: InvestmentStats): number | null {
  const g = totalGain(s);
  if (g === null) return null;
  const c = totalCost(s);
  if (c === 0) return null;
  return g / c;
}

/** `(latest_price - previous_price) × units_held`. `null` when fewer than two prices are known. */
export function dailyGainValue(s: InvestmentStats): number | null {
  if (s.priceLatest === null || s.pricePrevious === null) return null;
  return (s.priceLatest - s.pricePrevious) * s.unitsHeld;
}

export function dailyGainPercent(s: InvestmentStats): number | null {
  if (s.priceLatest === null || s.pricePrevious === null) return null;
  if (s.pricePrevious === 0) return null;
  return s.priceLatest / s.pricePrevious - 1;
}

/** Value of reinvested (DRIP) units at the latest adjusted price. */
export function reinvestedValue(s: InvestmentStats): number | null {
  if (s.priceLatest === null) return null;
  return s.reinvestedUnits * s.priceLatest;
}

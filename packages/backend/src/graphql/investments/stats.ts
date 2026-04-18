import { and, asc, desc, eq } from "drizzle-orm";

import { db } from "@/db";
import {
  InvestmentPrices,
  Investments,
  InvestmentStockSplits,
  InvestmentTransactions,
} from "@/db/schema/investments";
import { readOrRefresh } from "@/tasks/yahoo";

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
 */
export async function loadInvestmentStats(
  investmentId: string,
  assetId?: string,
): Promise<InvestmentStats> {
  const [investmentRow] = await db
    .select({
      currency: Investments.currency,
      stockCode: Investments.stockCode,
    })
    .from(Investments)
    .where(eq(Investments.id, investmentId));
  if (!investmentRow) {
    throw new Error(`Investment ${investmentId} not found`);
  }

  const where =
    assetId === undefined
      ? eq(InvestmentTransactions.investmentId, investmentId)
      : and(
          eq(InvestmentTransactions.investmentId, investmentId),
          eq(InvestmentTransactions.assetId, assetId),
        );

  const [txRows, splitRows] = await Promise.all([
    db.select().from(InvestmentTransactions).where(where),
    db
      .select({
        date: InvestmentStockSplits.date,
        ratio: InvestmentStockSplits.ratio,
      })
      .from(InvestmentStockSplits)
      .where(eq(InvestmentStockSplits.investmentId, investmentId))
      .orderBy(asc(InvestmentStockSplits.date)),
  ]);

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
  for (const r of txRows) {
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

  const priceRows = await db
    .select({ priceAdjusted: InvestmentPrices.priceAdjusted })
    .from(InvestmentPrices)
    .where(eq(InvestmentPrices.investmentId, investmentId))
    .orderBy(desc(InvestmentPrices.date))
    .limit(2);

  let priceLatest = priceRows[0]?.priceAdjusted ?? null;
  let pricePrevious = priceRows[1]?.priceAdjusted ?? null;

  // When a live quote is cached for a stock investment, treat it as the latest
  // price and shift the most recent cached close into the "previous" slot so
  // `dailyGain*` tracks today's move against yesterday's close.
  if (investmentRow.stockCode) {
    const live = readOrRefresh(investmentRow.stockCode);
    if (live && live.currency === investmentRow.currency) {
      pricePrevious = priceLatest;
      priceLatest = live.priceMinorUnits;
    }
  }

  return {
    currency: investmentRow.currency,
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

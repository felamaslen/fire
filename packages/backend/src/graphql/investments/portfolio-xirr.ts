/**
 * Shared annualised-XIRR computation for a portfolio slice. Used by `Portfolio.xirr` (the investment-page resolver) and by the net-worth-forecast workings, so both surfaces agree exactly on the rate they show for the same wrapper.
 */

import { and, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/db";
import { Investments, InvestmentTransactions } from "@/db/schema/investments";
import { solveXirr } from "@/forecast/growth";

import type { Context } from "../context";
import { type InvestmentStatsFilter, loadInvestmentStats } from "./stats";

export type PortfolioXirrFilter = {
  /** ISO-4217 currency the slice is expressed in. Investments held in any other currency are excluded from both the cash flows and the terminal value. */
  currency: string;
  /** Asset wrappers in scope, or `null` for "every wrapper". */
  assetIds: readonly string[] | null;
  /** Investments in scope, or `null` for "every investment". */
  investmentIds: readonly string[] | null;
  /** When `true`, the terminal flow uses the most recent cached close instead of the live intraday quote. */
  skipLive: boolean;
};

/**
 * Solve XIRR over the slice's full transaction history (each buy as a negative flow, each sell as a positive flow) plus today's live-overlaid market value as the terminal flow at "now". Returns `null` when there are no transactions, when any contributing held investment is missing a price (matching `Portfolio.totalValue`'s graceful-degradation rule), or when the solver doesn't converge.
 */
export async function computePortfolioXirr(
  ctx: Context,
  { currency, assetIds, investmentIds, skipLive }: PortfolioXirrFilter,
): Promise<number | null> {
  const todayValueMinor = await loadTodayValueMinor(ctx, {
    currency,
    assetIds,
    investmentIds,
    skipLive,
  });
  if (todayValueMinor === null) return null;

  const txConditions = [sql`${Investments.currency} = ${currency}`];
  if (assetIds && assetIds.length > 0) {
    txConditions.push(
      inArray(InvestmentTransactions.assetId, assetIds as string[]),
    );
  }
  if (investmentIds && investmentIds.length > 0) {
    txConditions.push(
      inArray(InvestmentTransactions.investmentId, investmentIds as string[]),
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
  if (todayValueMinor > 0) {
    flows.push({ date: new Date(), amount: todayValueMinor });
  }
  return solveXirr(flows);
}

/**
 * Sum `InvestmentStats.totalValueMinor` across the per-slice expansion of the filter, propagating `null` the same way `Portfolio.totalValue` does (any contributing held investment missing a price nulls the whole aggregate). Mirrors `Portfolio.loadStats` so both callers see the same DataLoader batch.
 */
async function loadTodayValueMinor(
  ctx: Context,
  { currency, assetIds, investmentIds, skipLive }: PortfolioXirrFilter,
): Promise<number | null> {
  const base = { currency, skipLive } satisfies InvestmentStatsFilter;
  const keys: InvestmentStatsFilter[] = [];
  if (assetIds && investmentIds) {
    for (const assetId of assetIds) {
      for (const investmentId of investmentIds) {
        keys.push({ ...base, assetIds: [assetId], investmentId });
      }
    }
  } else if (assetIds) {
    for (const assetId of assetIds) keys.push({ ...base, assetIds: [assetId] });
  } else if (investmentIds) {
    for (const investmentId of investmentIds) {
      keys.push({ ...base, investmentId });
    }
  } else {
    keys.push(base);
  }
  const slices = await Promise.all(
    keys.map((k) => loadInvestmentStats(ctx, k)),
  );
  let total = 0;
  for (const s of slices) {
    if (s.totalValueMinor === null) return null;
    total += s.totalValueMinor;
  }
  return total;
}

import { desc, eq, inArray } from "drizzle-orm";
import type { Float } from "grats";

import { HOME_CURRENCY } from "@/config";
import { db } from "@/db";
import {
  NetWorthCurrencyRates,
  NetWorthEntries,
  NetWorthValueAmounts,
  NetWorthValues,
} from "@/db/schema/net-worth";

import type { Context } from "../context";
import type { Date as CalendarDate } from "../date";
import { Money } from "../money";
import { NetWorthCategoryLiability } from "./categories";
import { netWorthForecast, NetWorthForecastLoan } from "./forecast";
import { buildRateToHome, convertToHomeMinor } from "./index";

/** One home-currency balance point on a loan's recorded history — one entry per `NetWorthEntry` that includes a value for the loan. @gqlType */
export type LoanHistoryPoint = {
  /** Date of the underlying `NetWorthEntry`. @gqlField */
  date: CalendarDate;
  /** Recorded balance in the home currency, as a positive magnitude. @gqlField */
  balance: Money;
};

/** Per-loan inputs the loan-overpayment calculator needs in one shot: a default `startingBalance` / `monthlyRepayment` / `interestRate` for the projection, plus the home-currency balance history. The default starting balance and monthly repayment are derived from the loan's actual historic repayments — clients let users override either one. @gqlType */
export type LoanCalculatorRow = {
  /** The loan liability — exposes `id`, `name`, etc. @gqlField */
  liability: NetWorthCategoryLiability;
  /** Default starting balance for the projection (home currency, positive magnitude), derived from the latest recorded balance. @gqlField */
  startingBalance: Money;
  /** Default monthly repayment for the projection (home currency), derived from actual historic repayments against the loan. @gqlField */
  monthlyRepayment: Money;
  /** Annual interest rate (decimal, e.g. `0.045` = 4.5%/yr). @gqlField */
  interestRate: Float;
  /** Recorded balances at every `NetWorthEntry` that includes a value for this loan, in chronological order. @gqlField */
  history: LoanHistoryPoint[];
};

/**
 * Per-loan inputs for the loan-overpayment calculator on the home page. Returns one row per `LOAN` liability that has a value in the latest `NetWorthEntry` AND that has enough recorded history to derive a default monthly repayment, alongside the loan's full home-currency balance history.
 *
 * @gqlQueryField
 * @gqlAnnotate semanticNonNull
 */
export async function loanCalculator(
  ctx: Context,
): Promise<LoanCalculatorRow[] | null> {
  // `years: 1, limit: 5` is the cheapest valid horizon — the calculator only
  // reads per-loan engine inputs (`startingBalance` / `monthlyRepayment` /
  // `interestRate`), never `projectedBalance`.
  const forecast = await netWorthForecast(ctx, 1, 5);
  if (!forecast) return [];
  const loans: NetWorthForecastLoan[] = [];
  for (const c of forecast.workings.categories) {
    if (c instanceof NetWorthForecastLoan) loans.push(c);
  }
  if (loans.length === 0) return [];

  const liabilityIds = loans.map((l) => l.category.id);

  const [latestEntry] = await db
    .select({ id: NetWorthEntries.id })
    .from(NetWorthEntries)
    .orderBy(desc(NetWorthEntries.date), desc(NetWorthEntries.id))
    .limit(1);
  if (!latestEntry) return [];

  const historyRows = await db
    .select({
      liabilityId: NetWorthValues.categoryLiabilityId,
      entryId: NetWorthValues.entryId,
      date: NetWorthEntries.date,
      amount: NetWorthValueAmounts.amount,
      currency: NetWorthValueAmounts.currency,
    })
    .from(NetWorthValues)
    .innerJoin(NetWorthEntries, eq(NetWorthEntries.id, NetWorthValues.entryId))
    .innerJoin(
      NetWorthValueAmounts,
      eq(NetWorthValueAmounts.valueId, NetWorthValues.id),
    )
    .where(inArray(NetWorthValues.categoryLiabilityId, liabilityIds));

  const entryIds = [...new Set(historyRows.map((r) => r.entryId))];
  const rateRows = entryIds.length
    ? await db
        .select()
        .from(NetWorthCurrencyRates)
        .where(inArray(NetWorthCurrencyRates.entryId, entryIds))
    : [];
  const ratesByEntry = new Map<
    string,
    (typeof NetWorthCurrencyRates.$inferSelect)[]
  >();
  for (const r of rateRows) {
    const list = ratesByEntry.get(r.entryId) ?? [];
    list.push(r);
    ratesByEntry.set(r.entryId, list);
  }
  const rateMapByEntry = new Map<string, Map<string, number>>();
  for (const [entryId, rows] of ratesByEntry) {
    rateMapByEntry.set(entryId, buildRateToHome(rows));
  }

  type HistoryEntry = { date: Date; minor: number };
  const byLiability = new Map<string, Map<string, HistoryEntry>>();
  const activeLiabilityIds = new Set<string>();
  for (const r of historyRows) {
    if (!r.liabilityId) continue;
    if (r.entryId === latestEntry.id) activeLiabilityIds.add(r.liabilityId);
    const rateMap =
      rateMapByEntry.get(r.entryId) ?? new Map([[HOME_CURRENCY, 1]]);
    const homeMinor = convertToHomeMinor(r.amount, r.currency, rateMap);
    let perLiability = byLiability.get(r.liabilityId);
    if (!perLiability) {
      perLiability = new Map();
      byLiability.set(r.liabilityId, perLiability);
    }
    const existing = perLiability.get(r.entryId);
    if (existing) existing.minor += homeMinor;
    else perLiability.set(r.entryId, { date: r.date, minor: homeMinor });
  }

  const out: LoanCalculatorRow[] = [];
  for (const l of loans) {
    if (!activeLiabilityIds.has(l.category.id)) continue;
    const entries = [...(byLiability.get(l.category.id)?.values() ?? [])];
    entries.sort((a, b) => a.date.getTime() - b.date.getTime());
    const history: LoanHistoryPoint[] = entries.map((e) => ({
      date: e.date as CalendarDate,
      balance: Money.fromMinorDenomination(Math.abs(e.minor), HOME_CURRENCY),
    }));
    out.push({
      liability: l.category,
      startingBalance: l.startingBalance,
      monthlyRepayment: l.monthlyRepayment,
      interestRate: l.interestRate,
      history,
    });
  }
  out.sort(
    (a, b) =>
      Number(b.startingBalance.amount) - Number(a.startingBalance.amount),
  );
  return out;
}

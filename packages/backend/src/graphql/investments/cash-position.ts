import { and, desc, eq, inArray } from "drizzle-orm";

import { HOME_CURRENCY } from "@/config";
import { db } from "@/db";
import {
  NetWorthEntries,
  NetWorthValueAmounts,
  NetWorthValues,
} from "@/db/schema/net-worth";

import { Money } from "../money";
import {
  collectionDayInMonth,
  loadPlanningAccountInfos,
  loadPlanningYearData,
} from "../planning/balance";
import { planningMonthKey, startOfMonthUTC } from "../planning/months";

/** Current cash position: the sum of cash balances across every planning account (net-worth assets of type `CASH` that back a `PlanningAccount`) taken from the latest net-worth entry, minus projected and recorded outflows for the current month up to today. Cash assets that aren't wired up as planning accounts are ignored — those don't show up on the planning page and aren't part of the day-to-day cash float this field is meant to represent.
 *
 * @gqlQueryField
 * @gqlAnnotate semanticNonNull
 */
export async function cashPosition(): Promise<Money | null> {
  const today = new Date();
  const monthStart = startOfMonthUTC(today);

  const planningAccounts = await loadPlanningAccountInfos();
  const cashAccounts = planningAccounts.filter((a) => a.asset.type === "CASH");
  if (cashAccounts.length === 0) {
    return Money.fromMinorDenomination(0, HOME_CURRENCY);
  }
  const cashIds = cashAccounts.map((a) => a.assetId);
  const cashIdSet = new Set(cashIds);

  // Latest net-worth entry's cash assets (restricted to the planning cash set).
  const [latest] = await db
    .select({ id: NetWorthEntries.id })
    .from(NetWorthEntries)
    .orderBy(desc(NetWorthEntries.date))
    .limit(1);

  let cashMinor = 0;
  if (latest) {
    const rows = await db
      .select({ amount: NetWorthValueAmounts.amount })
      .from(NetWorthValues)
      .innerJoin(
        NetWorthValueAmounts,
        eq(NetWorthValueAmounts.valueId, NetWorthValues.id),
      )
      .where(
        and(
          eq(NetWorthValues.entryId, latest.id),
          inArray(NetWorthValues.categoryAssetId, cashIds),
        ),
      );
    for (const r of rows) cashMinor += r.amount;
  }

  // Fold every month-to-date planning event into a signed delta applied on
  // top of the snapshotted cash: explicit transactions and payslips keep
  // their sign (outflow tx & deductions subtract, payslip gross & ad-hoc
  // inflows add), bills subtract once their collection day has passed, and
  // internal transfers between two planning cash accounts cancel out.
  const fyYear = planningMonthKey(today).year;
  const data = await loadPlanningYearData(fyYear, cashAccounts);
  const monthEnd = new Date(
    Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 1),
  );

  let netDeltaMinor = 0;
  for (const tx of data.transactions) {
    if (tx.date.getTime() < monthStart.getTime()) continue;
    if (tx.date.getTime() >= monthEnd.getTime()) continue;
    if (cashIdSet.has(tx.accountId)) netDeltaMinor += tx.amount;
    if (tx.toAccountId && cashIdSet.has(tx.toAccountId)) {
      netDeltaMinor += -tx.amount;
    }
  }
  for (const { payslip, adjustments } of data.payslips) {
    if (!cashIdSet.has(payslip.toAccountId)) continue;
    if (payslip.date.getTime() < monthStart.getTime()) continue;
    if (payslip.date.getTime() >= monthEnd.getTime()) continue;
    netDeltaMinor += payslip.amountGross;
    for (const adj of adjustments) netDeltaMinor += adj.amount;
  }
  for (const { bill, overridesByMonthStartIso } of data.bills) {
    if (!cashIdSet.has(bill.fromAccountId)) continue;
    const day = collectionDayInMonth(
      bill.frequency,
      bill.collectionDate,
      monthStart,
    );
    if (day == null) continue;
    const collectionOn = new Date(
      Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth(), day),
    );
    if (collectionOn.getTime() < monthStart.getTime()) continue;
    if (collectionOn.getTime() > today.getTime()) continue;
    if (collectionOn.getTime() < bill.start.getTime()) continue;
    if (bill.end && collectionOn.getTime() > bill.end.getTime()) continue;
    const override = overridesByMonthStartIso.get(monthStart.toISOString());
    if (override) {
      if (override.amount == null) continue;
      netDeltaMinor -= override.amount;
    } else {
      netDeltaMinor -= bill.amount;
    }
  }

  return Money.fromMinorDenomination(cashMinor + netDeltaMinor, HOME_CURRENCY);
}

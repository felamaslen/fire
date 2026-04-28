import { and, desc, eq, gte, inArray, isNull, lt, lte, or } from "drizzle-orm";

import { HOME_CURRENCY } from "@/config";
import { db } from "@/db";
import {
  NetWorthCategoryAssets,
  NetWorthEntries,
  NetWorthValueAmounts,
  NetWorthValues,
} from "@/db/schema/net-worth";
import {
  PlanningAccounts,
  PlanningBills,
  PlanningMonthBills,
  PlanningPayslipAdjustments,
  PlanningPayslips,
  PlanningTransactions,
} from "@/db/schema/planning";

import { Money } from "../money";
import { collectionDayInMonth } from "../planning/balance";
import { addMonthsUTC, startOfMonthUTC } from "../planning/months";

/** Current cash position: the sum of cash balances across every planning account (net-worth assets of type `CASH` that back a `PlanningAccount`) taken from the latest net-worth entry, minus projected and recorded outflows for the current month up to today. Cash assets that aren't wired up as planning accounts are ignored — those don't show up on the planning page and aren't part of the day-to-day cash float this field is meant to represent.
 *
 * @gqlQueryField
 * @gqlAnnotate semanticNonNull
 */
export async function cashPosition(): Promise<Money | null> {
  const today = new Date();
  const monthStart = startOfMonthUTC(today);
  const monthEnd = addMonthsUTC(monthStart, 1);

  // Subselect every cash planning account id once, reused inline by the four
  // parallel SQL queries below — folds what was a preflight round-trip into
  // the same batch as the data fetches. The same SQL also resolves to the JS
  // `cashIdSet` so the in-memory transfer-leg detection still has its lookup.
  const cashIdsSubq = db
    .select({ id: PlanningAccounts.accountId })
    .from(PlanningAccounts)
    .innerJoin(
      NetWorthCategoryAssets,
      eq(NetWorthCategoryAssets.id, PlanningAccounts.accountId),
    )
    .where(eq(NetWorthCategoryAssets.type, "CASH"));

  const latestEntryIdSubq = db
    .select({ id: NetWorthEntries.id })
    .from(NetWorthEntries)
    .orderBy(desc(NetWorthEntries.date))
    .limit(1);

  const [cashIdRows, cashAmountRows, txs, payslipJoin, billJoin] =
    await Promise.all([
      cashIdsSubq,
      db
        .select({ amount: NetWorthValueAmounts.amount })
        .from(NetWorthValues)
        .innerJoin(
          NetWorthValueAmounts,
          eq(NetWorthValueAmounts.valueId, NetWorthValues.id),
        )
        .where(
          and(
            eq(NetWorthValues.entryId, latestEntryIdSubq),
            inArray(NetWorthValues.categoryAssetId, cashIdsSubq),
          ),
        ),
      db
        .select({
          amount: PlanningTransactions.amount,
          accountId: PlanningTransactions.accountId,
          toAccountId: PlanningTransactions.toAccountId,
        })
        .from(PlanningTransactions)
        .where(
          and(
            gte(PlanningTransactions.date, monthStart),
            lt(PlanningTransactions.date, monthEnd),
            or(
              inArray(PlanningTransactions.accountId, cashIdsSubq),
              inArray(PlanningTransactions.toAccountId, cashIdsSubq),
            ),
          ),
        ),
      db
        .select({
          payslipId: PlanningPayslips.id,
          amountGross: PlanningPayslips.amountGross,
          adjustmentAmount: PlanningPayslipAdjustments.amount,
        })
        .from(PlanningPayslips)
        .leftJoin(
          PlanningPayslipAdjustments,
          eq(PlanningPayslipAdjustments.payslipId, PlanningPayslips.id),
        )
        .where(
          and(
            inArray(PlanningPayslips.toAccountId, cashIdsSubq),
            gte(PlanningPayslips.date, monthStart),
            lt(PlanningPayslips.date, monthEnd),
          ),
        ),
      db
        .select({
          start: PlanningBills.start,
          end: PlanningBills.end,
          frequency: PlanningBills.frequency,
          collectionDate: PlanningBills.collectionDate,
          amount: PlanningBills.amount,
          // `overrideBillId` distinguishes "no override row" (LEFT JOIN miss
          // → both columns null) from "override row exists with NULL amount"
          // (id non-null, amount null), which is the schema's convention for
          // "skip this month".
          overrideBillId: PlanningMonthBills.billId,
          overrideAmount: PlanningMonthBills.amount,
        })
        .from(PlanningBills)
        .leftJoin(
          PlanningMonthBills,
          and(
            eq(PlanningMonthBills.billId, PlanningBills.id),
            eq(PlanningMonthBills.date, monthStart),
          ),
        )
        .where(
          and(
            inArray(PlanningBills.fromAccountId, cashIdsSubq),
            lte(PlanningBills.start, monthEnd),
            or(isNull(PlanningBills.end), gte(PlanningBills.end, monthStart)),
          ),
        ),
    ]);

  const cashIdSet = new Set(cashIdRows.map((r) => r.id));
  if (cashIdSet.size === 0) {
    return Money.fromMinorDenomination(0, HOME_CURRENCY);
  }

  let cashMinor = 0;
  for (const r of cashAmountRows) cashMinor += r.amount;

  let netDeltaMinor = 0;
  for (const tx of txs) {
    if (cashIdSet.has(tx.accountId)) netDeltaMinor += tx.amount;
    // Internal transfer between two cash accounts: the credit side cancels
    // the debit so the float is unchanged.
    if (tx.toAccountId && cashIdSet.has(tx.toAccountId)) {
      netDeltaMinor -= tx.amount;
    }
  }

  const seenPayslip = new Set<string>();
  for (const r of payslipJoin) {
    if (!seenPayslip.has(r.payslipId)) {
      seenPayslip.add(r.payslipId);
      netDeltaMinor += r.amountGross;
    }
    if (r.adjustmentAmount != null) netDeltaMinor += r.adjustmentAmount;
  }

  for (const bill of billJoin) {
    const day = collectionDayInMonth(
      bill.frequency,
      bill.collectionDate,
      monthStart,
    );
    if (day == null) continue;
    const collectionOn = new Date(
      Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth(), day),
    );
    if (collectionOn.getTime() > today.getTime()) continue;
    if (collectionOn.getTime() < bill.start.getTime()) continue;
    if (bill.end && collectionOn.getTime() > bill.end.getTime()) continue;
    if (bill.overrideBillId != null) {
      if (bill.overrideAmount == null) continue;
      netDeltaMinor -= bill.overrideAmount;
    } else {
      netDeltaMinor -= bill.amount;
    }
  }

  return Money.fromMinorDenomination(cashMinor + netDeltaMinor, HOME_CURRENCY);
}

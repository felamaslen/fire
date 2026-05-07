import DataLoader from "dataloader";
import { addMonths, startOfMonth } from "date-fns";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import type { Float } from "grats";

import { HOME_CURRENCY } from "@/config";
import { db } from "@/db";
import {
  NetWorthCurrencyRates,
  NetWorthEntries,
  NetWorthValueAmounts,
  NetWorthValues,
} from "@/db/schema/net-worth";
import {
  PlanningBills,
  PlanningMonthBills,
  PlanningPayslipAdjustments,
  PlanningPayslips,
  PlanningTransactions,
} from "@/db/schema/planning";

import { type Context, contextAwareDataLoader } from "../context";
import type { Date as CalendarDate } from "../date";
import { Money } from "../money";
import { collectionDayInMonth } from "../planning/balance";
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

/** Total payments made against a loan during a single calendar month — the sum of every recorded `PlanningTransaction` (with this loan as `liabilityId`) and every payslip deduction tagged to this loan that fell in that month. @gqlType */
export type LoanPaymentMonth = {
  /** First day of the month. @gqlField */
  month: CalendarDate;
  /** Total magnitude of payments made against the loan that month, in the home currency. @gqlField */
  amount: Money;
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
  /** Per-month aggregated payments that have been made against this loan to date — every `PlanningTransaction` and payslip deduction with this loan as `liabilityId`, summed by calendar month and ordered chronologically. Months with no payments are omitted. @gqlField */
  paymentHistory: LoanPaymentMonth[];
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

  const loader = paymentsByMonthLoader(ctx);
  const activeLoans = loans.filter((l) =>
    activeLiabilityIds.has(l.category.id),
  );
  const paymentsPerActiveLoan = await Promise.all(
    activeLoans.map((l) => loader.load(l.category.id)),
  );

  const out: LoanCalculatorRow[] = [];
  for (const [i, l] of activeLoans.entries()) {
    const entries = [...(byLiability.get(l.category.id)?.values() ?? [])];
    entries.sort((a, b) => a.date.getTime() - b.date.getTime());
    const history: LoanHistoryPoint[] = entries.map((e) => ({
      date: e.date as CalendarDate,
      balance: Money.fromMinorDenomination(Math.abs(e.minor), HOME_CURRENCY),
    }));
    const paymentHistory: LoanPaymentMonth[] = paymentsPerActiveLoan[i].map(
      ({ month, minor }) => ({
        month: month as CalendarDate,
        amount: Money.fromMinorDenomination(minor, HOME_CURRENCY),
      }),
    );
    out.push({
      liability: l.category,
      startingBalance: l.startingBalance,
      monthlyRepayment: l.monthlyRepayment,
      interestRate: l.interestRate,
      history,
      paymentHistory,
    });
  }
  out.sort(
    (a, b) =>
      Number(b.startingBalance.amount) - Number(a.startingBalance.amount),
  );
  return out;
}

type LoanMonthPayment = { month: Date; minor: number };

/** Per-request batched loader for `LoanCalculatorRow.paymentHistory`. Loan payments come from three places — direct `PlanningTransactions` and `PlanningPayslipAdjustments` (e.g. student-loan deductions) tagged with the loan as `liabilityId`, plus `PlanningBills` (recurring direct-debits, e.g. mortgages) linked to it. The two transaction sources are merged in a single SQL via `unionAll`; bills are loaded with their `PlanningMonthBills` overrides and expanded month-by-month in JS up to the most recent firing on or before today. All three are aggregated per (liabilityId, month); magnitudes only (`Math.abs`); home-currency rows only. */
const paymentsByMonthLoader = contextAwareDataLoader(
  () =>
    new DataLoader<string, LoanMonthPayment[]>(async (liabilityIds) => {
      const ids = [...liabilityIds];
      // Both branches project the same `(liabilityId, date, amount)` shape so
      // the union is type-aligned. `Math.abs` happens client-side after the
      // rows come back — `unionAll` here is purely about merging the two
      // sources in one round-trip, not pre-aggregating.
      const txBranch = db
        .select({
          liabilityId: PlanningTransactions.liabilityId,
          date: PlanningTransactions.date,
          amount: PlanningTransactions.amount,
        })
        .from(PlanningTransactions)
        .where(
          and(
            isNotNull(PlanningTransactions.liabilityId),
            inArray(PlanningTransactions.liabilityId, ids),
            eq(PlanningTransactions.currency, HOME_CURRENCY),
          ),
        );
      const adjBranch = db
        .select({
          liabilityId: PlanningPayslipAdjustments.liabilityId,
          date: PlanningPayslips.date,
          amount: PlanningPayslipAdjustments.amount,
        })
        .from(PlanningPayslipAdjustments)
        .innerJoin(
          PlanningPayslips,
          eq(PlanningPayslips.id, PlanningPayslipAdjustments.payslipId),
        )
        .where(
          and(
            isNotNull(PlanningPayslipAdjustments.liabilityId),
            inArray(PlanningPayslipAdjustments.liabilityId, ids),
            eq(PlanningPayslips.currency, HOME_CURRENCY),
          ),
        );
      const [rows, billRows] = await Promise.all([
        unionAll(txBranch, adjBranch),
        db
          .select({ bill: PlanningBills, override: PlanningMonthBills })
          .from(PlanningBills)
          .leftJoin(
            PlanningMonthBills,
            eq(PlanningMonthBills.billId, PlanningBills.id),
          )
          .where(
            and(
              isNotNull(PlanningBills.liabilityId),
              inArray(PlanningBills.liabilityId, ids),
              eq(PlanningBills.currency, HOME_CURRENCY),
            ),
          ),
      ]);

      // (liabilityId, monthTimestamp) -> aggregated minor magnitude.
      const buckets = new Map<string, Map<number, number>>();
      const accumulate = (
        liabilityId: string,
        monthTs: number,
        minor: number,
      ) => {
        let perLiability = buckets.get(liabilityId);
        if (!perLiability) {
          perLiability = new Map();
          buckets.set(liabilityId, perLiability);
        }
        perLiability.set(monthTs, (perLiability.get(monthTs) ?? 0) + minor);
      };
      for (const r of rows) {
        if (!r.liabilityId) continue;
        const date = r.date instanceof Date ? r.date : new Date(r.date);
        const monthTs = startOfMonth(date).getTime();
        accumulate(r.liabilityId, monthTs, Math.abs(Number(r.amount)));
      }

      // Recurring bills: enumerate every past collection month per bill,
      // applying `PlanningMonthBills` overrides where present (a row with
      // `amount === null` means the bill was skipped that month).
      type BillSpec = (typeof billRows)[number]["bill"];
      const billsById = new Map<string, BillSpec>();
      // billId -> monthTs -> override.amount (may be null = skipped).
      const overridesByBill = new Map<string, Map<number, number | null>>();
      for (const r of billRows) {
        if (!r.bill.liabilityId) continue;
        billsById.set(r.bill.id, r.bill);
        if (r.override) {
          const ts = startOfMonth(r.override.date).getTime();
          let m = overridesByBill.get(r.bill.id);
          if (!m) {
            m = new Map();
            overridesByBill.set(r.bill.id, m);
          }
          m.set(ts, r.override.amount);
        }
      }
      const today = new Date();
      const todayMonthStart = startOfMonth(today);
      for (const bill of billsById.values()) {
        if (!bill.liabilityId) continue;
        const overrides = overridesByBill.get(bill.id);
        const lastMonthStart = bill.end
          ? startOfMonth(
              bill.end.getTime() < todayMonthStart.getTime()
                ? bill.end
                : todayMonthStart,
            )
          : todayMonthStart;
        for (
          let m = startOfMonth(bill.start);
          m.getTime() <= lastMonthStart.getTime();
          m = addMonths(m, 1)
        ) {
          const day = collectionDayInMonth(
            bill.frequency,
            bill.collectionDate,
            m,
          );
          if (day == null) continue;
          const collectionDate = new Date(
            Date.UTC(m.getUTCFullYear(), m.getUTCMonth(), day),
          );
          if (collectionDate < bill.start) continue;
          if (bill.end != null && collectionDate > bill.end) continue;
          if (collectionDate > today) continue;
          const ts = m.getTime();
          // An override row exists → use its amount (null = skipped).
          // Otherwise fall back to the bill's scheduled amount.
          const override = overrides?.has(ts)
            ? (overrides.get(ts) ?? null)
            : undefined;
          const amount = override === undefined ? bill.amount : override;
          if (amount == null || amount === 0) continue;
          accumulate(bill.liabilityId, ts, Math.abs(amount));
        }
      }

      return ids.map((id) => {
        const perMonth = buckets.get(id);
        if (!perMonth) return [];
        return [...perMonth.entries()]
          .sort(([a], [b]) => a - b)
          .map(([ts, minor]) => ({ month: new Date(ts), minor }));
      });
    }),
);

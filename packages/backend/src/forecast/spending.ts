/**
 * Spending / cashflow projection — currently **unused**.
 *
 * TODO: wire this back in for retirement-age prediction. The net-worth forecast deliberately doesn't model cash flow: empirically, ongoing investment contributions plus loan repayments already sum to the user's post-spending surplus, so holding cash flat is a good enough approximation for the headline projection. Retirement modelling is a different question — it needs an explicit picture of monthly spend so we can simulate drawing down assets once income stops — and this module is the scaffolding for that.
 *
 * Loaders and the `computeCashflow` helper live together here, detached from the active engine, so they don't bit-rot silently. When we pick this back up: build `loadSpendingInputs`, feed it through `computeCashflow`, and simulate monthly cash deltas against a configurable income stream (probably zero post-retirement).
 */

import { addMonths, startOfMonth } from "date-fns";
import { and, eq, gte, inArray, isNotNull, isNull, lte, or } from "drizzle-orm";

import { HOME_CURRENCY } from "@/config";
import { db } from "@/db";
import { NetWorthCategoryLiabilities } from "@/db/schema/net-worth";
import {
  PlanningAccounts,
  PlanningBills,
  PlanningPayslipAdjustments,
  PlanningPayslips,
  PlanningTransactions,
} from "@/db/schema/planning";

import type { ForecastCategory, ForecastCategoryWorkings } from "./engine";
import {
  creditCardEwmaSpend,
  ewmaPayslipNet,
  type LiabilityBill,
  type LiabilityTx,
  type Payslip,
} from "./growth";

const EWMA_LOOKBACK_MONTHS = 36;

export type SpendingInputs = {
  asOfMonthStart: Date;
  categories: ForecastCategory[];
  /** `PlanningTransactions` grouped by credit-card liability id — feeds the card-spend EWMA. */
  creditCardTxs: Map<string, readonly LiabilityTx[]>;
  /** All historical payslips — `ewmaPayslipNet` filters by `toAccountId`. */
  payslips: readonly Payslip[];
  /** Cash accounts we should EWMA income for (usually every `PlanningAccount`). */
  accountIds: readonly string[];
  /** Scheduled bills **not** tagged to a liability — pure cash-out expenses. */
  nonLiabilityBills: readonly LiabilityBill[];
};

/** Monthly cashflow component breakdown — each amount in home-currency minor units. */
export type ForecastCashflow = {
  monthlyIncome: number;
  monthlyBills: number;
  monthlyCreditCardPayoff: number;
  monthlyLoanRepayment: number;
  monthlyInvestmentContribution: number;
  monthlyCashOut: number;
  monthlyNetCashFlow: number;
};

function billMonthlyEquivalent(bill: LiabilityBill): number {
  switch (bill.frequency) {
    case "MONTHLY":
      return bill.amount;
    case "QUARTERLY":
      return bill.amount / 3;
    case "YEARLY":
      return bill.amount / 12;
  }
}

/** Collapse loaded spending inputs + per-category forecast workings into a single monthly cashflow snapshot. */
export function computeCashflow(
  inputs: SpendingInputs,
  engineWorkings: Map<string, ForecastCategoryWorkings>,
): ForecastCashflow {
  let monthlyIncome = 0;
  for (const acc of inputs.accountIds) {
    monthlyIncome += ewmaPayslipNet(inputs.payslips, acc);
  }

  let monthlyBills = 0;
  for (const b of inputs.nonLiabilityBills) {
    monthlyBills += billMonthlyEquivalent(b);
  }

  let monthlyCreditCardPayoff = 0;
  let monthlyLoanRepayment = 0;
  let monthlyInvestmentContribution = 0;
  for (const cat of inputs.categories) {
    if (cat.kind === "liability" && !cat.skip) {
      if (cat.liabilityType === "CREDIT_CARD") {
        monthlyCreditCardPayoff += creditCardEwmaSpend(
          inputs.creditCardTxs.get(cat.id) ?? [],
          inputs.asOfMonthStart,
        );
      } else if (cat.liabilityType === "LOAN") {
        monthlyLoanRepayment +=
          engineWorkings.get(cat.id)?.monthlyRepayment ?? 0;
      }
    } else if (
      cat.kind === "asset" &&
      (cat.assetType === "STOCK" || cat.assetType === "PENSION")
    ) {
      monthlyInvestmentContribution +=
        engineWorkings.get(cat.id)?.monthlyContribution ?? 0;
    }
  }

  const monthlyCashOut =
    monthlyBills +
    monthlyCreditCardPayoff +
    monthlyLoanRepayment +
    monthlyInvestmentContribution;
  return {
    monthlyIncome,
    monthlyBills,
    monthlyCreditCardPayoff,
    monthlyLoanRepayment,
    monthlyInvestmentContribution,
    monthlyCashOut,
    monthlyNetCashFlow: monthlyIncome - monthlyCashOut,
  };
}

/** Load everything `computeCashflow` needs — payslip history, scheduled non-liability bills, planning accounts, and credit-card transactions for the spend EWMA. Home-currency rows only. */
export async function loadSpendingInputs(
  asOfDate: Date,
  categories: ForecastCategory[],
): Promise<SpendingInputs> {
  const asOfMonthStart = startOfMonth(asOfDate);
  const ewmaCutoff = addMonths(asOfMonthStart, -EWMA_LOOKBACK_MONTHS);

  const [creditCardTxs, nonLiabilityBills, payslips, accountIds] =
    await Promise.all([
      loadCreditCardTxs(ewmaCutoff),
      loadNonLiabilityBills(asOfDate),
      loadPayslips(ewmaCutoff),
      loadAccountIds(),
    ]);

  return {
    asOfMonthStart,
    categories,
    creditCardTxs,
    payslips,
    accountIds,
    nonLiabilityBills,
  };
}

async function loadCreditCardTxs(
  cutoff: Date,
): Promise<Map<string, LiabilityTx[]>> {
  const rows = await db
    .select({
      liabilityId: PlanningTransactions.liabilityId,
      date: PlanningTransactions.date,
      amount: PlanningTransactions.amount,
    })
    .from(PlanningTransactions)
    .innerJoin(
      NetWorthCategoryLiabilities,
      eq(NetWorthCategoryLiabilities.id, PlanningTransactions.liabilityId),
    )
    .where(
      and(
        isNotNull(PlanningTransactions.liabilityId),
        eq(NetWorthCategoryLiabilities.type, "CREDIT_CARD"),
        gte(PlanningTransactions.date, cutoff),
        eq(PlanningTransactions.currency, HOME_CURRENCY),
      ),
    );
  const out = new Map<string, LiabilityTx[]>();
  for (const r of rows) {
    if (!r.liabilityId) continue;
    const arr = out.get(r.liabilityId) ?? [];
    arr.push({ date: r.date, amount: r.amount });
    out.set(r.liabilityId, arr);
  }
  return out;
}

async function loadNonLiabilityBills(asOfDate: Date): Promise<LiabilityBill[]> {
  const rows = await db
    .select({
      start: PlanningBills.start,
      end: PlanningBills.end,
      frequency: PlanningBills.frequency,
      collectionDate: PlanningBills.collectionDate,
      amount: PlanningBills.amount,
    })
    .from(PlanningBills)
    .where(
      and(
        isNull(PlanningBills.liabilityId),
        eq(PlanningBills.currency, HOME_CURRENCY),
        lte(PlanningBills.start, asOfDate),
        or(isNull(PlanningBills.end), gte(PlanningBills.end, asOfDate)),
      ),
    );
  return rows;
}

async function loadPayslips(cutoff: Date): Promise<Payslip[]> {
  const slips = await db
    .select({
      id: PlanningPayslips.id,
      date: PlanningPayslips.date,
      toAccountId: PlanningPayslips.toAccountId,
      amountGross: PlanningPayslips.amountGross,
    })
    .from(PlanningPayslips)
    .where(
      and(
        gte(PlanningPayslips.date, cutoff),
        eq(PlanningPayslips.currency, HOME_CURRENCY),
      ),
    );
  if (slips.length === 0) return [];
  const adjRows = await db
    .select({
      payslipId: PlanningPayslipAdjustments.payslipId,
      amount: PlanningPayslipAdjustments.amount,
    })
    .from(PlanningPayslipAdjustments)
    .where(
      inArray(
        PlanningPayslipAdjustments.payslipId,
        slips.map((s) => s.id),
      ),
    );
  const adjByPayslip = new Map<string, number>();
  for (const a of adjRows) {
    adjByPayslip.set(
      a.payslipId,
      (adjByPayslip.get(a.payslipId) ?? 0) + a.amount,
    );
  }
  return slips.map((s) => ({
    date: s.date,
    toAccountId: s.toAccountId,
    netAmount: s.amountGross + (adjByPayslip.get(s.id) ?? 0),
  }));
}

async function loadAccountIds(): Promise<string[]> {
  const rows = await db
    .select({ accountId: PlanningAccounts.accountId })
    .from(PlanningAccounts);
  return rows.map((r) => r.accountId);
}

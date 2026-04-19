/**
 * Monthly net-worth forecast engine. Pure — takes a pre-loaded snapshot of today's category balances plus the historical rows the EWMA helpers need, and projects forward. Returns both the per-month aggregate points and the "workings" (per-category per-month balances, monthly-cashflow components, derived EWMA figures) so clients can show their reasoning, not just the bottom line.
 *
 * DB loading lives in a separate module so this stays unit-testable.
 */

import { addMonths } from "date-fns";

import {
  creditCardEwmaSpend,
  ewmaMonthlyContribution,
  ewmaPayslipNet,
  type InvestmentTx,
  type LiabilityBill,
  type LiabilityTx,
  loanEwmaRepayment,
  type Payslip,
  projectLoanBalance,
  projectMonthlyGrowth,
} from "./growth";

type AssetType =
  | "CASH"
  | "STOCK"
  | "PENSION"
  | "PROPERTY"
  | "VEHICLE"
  | "OPTION"
  | "MISC";

/** Shape the engine consumes — one entry per `NetWorthCategory*` row the user cares about. */
export type ForecastCategory =
  | {
      id: string;
      kind: "asset";
      assetType: AssetType;
      /** Percentage annual rate for `PROPERTY` / `VEHICLE` only. */
      growthRate?: number | null;
      /** Annualised return as a decimal (e.g. `0.08` = 8%/yr) for `STOCK` / `PENSION` portfolio wrappers. */
      xirr?: number | null;
    }
  | {
      id: string;
      kind: "liability";
      liabilityType: "CREDIT_CARD" | "LOAN" | "MISC";
      /** Percentage annual interest for `LOAN` only. */
      interestRate?: number | null;
      skip?: boolean;
    }
  | {
      id: string;
      kind: "option";
    };

export type ForecastInputs = {
  /** Midnight-UTC 1st of the starting month — all projection dates are `addMonths(asOfMonthStart, i)`. */
  asOfMonthStart: Date;
  /** Forecast horizon in months. The output has `months + 1` points (inclusive of the starting point). */
  months: number;
  categories: ForecastCategory[];
  /** Starting balance per category id, home-currency minor units. */
  startingBalance: Map<string, number>;
  /** `PlanningTransactions` grouped by liability id. */
  liabilityTxs: Map<string, readonly LiabilityTx[]>;
  /** `PlanningBills` grouped by loan liability id. */
  loanBills: Map<string, readonly LiabilityBill[]>;
  /** `InvestmentTransactions` grouped by `STOCK` / `PENSION` wrapper asset id. */
  portfolioTxs: Map<string, readonly InvestmentTx[]>;
  /** All historical payslips — `ewmaPayslipNet` filters by `toAccountId`. */
  payslips: readonly Payslip[];
  /** Cash accounts we should EWMA income for (usually every `PlanningAccount`). */
  accountIds: readonly string[];
  /** Scheduled bills **not** tagged to a liability — pure cash-out expenses. */
  nonLiabilityBills: readonly LiabilityBill[];
};

export type ForecastPoint = {
  date: Date;
  assetsByType: { type: AssetType; amount: number }[];
  assets: number;
  liabilities: number;
  net: number;
};

/** Per-category per-month projection plus the derived inputs the engine used. */
export type ForecastCategoryWorkings = {
  categoryId: string;
  /** Home-currency minor units at month 0. */
  startingBalance: number;
  /** `PROPERTY` / `VEHICLE` only — percentage annual rate carried through from the category. */
  growthRate: number | null;
  /** `STOCK` / `PENSION` only — decimal annualised return fed into the monthly compounding. */
  xirr: number | null;
  /** `STOCK` / `PENSION` only — EWMA monthly contribution added to the balance each month. */
  monthlyContribution: number;
  /** `CREDIT_CARD` only — EWMA of the past year's monthly spend. Since cards are treated as paid off in full each month, this value only feeds the cashflow breakdown — it never touches the card's balance. */
  monthlySpend: number;
  /** `LOAN` only — EWMA monthly repayment subtracted from the balance after interest. */
  monthlyRepayment: number;
  /** `LOAN` only — percentage annual interest carried through from the category. */
  interestRate: number | null;
  /** Projected balance, length `months + 1`, home-currency minor units. */
  projectedBalance: number[];
};

export type ForecastCashflow = {
  /** Sum across cash accounts of EWMA payslip net. */
  monthlyIncome: number;
  /** Sum of monthly-equivalent amounts across non-liability bills. */
  monthlyBills: number;
  /** Sum of credit-card EWMA spend across every card (every card is assumed paid off in full each month — see README). */
  monthlyCreditCardPayoff: number;
  /** Sum of EWMA repayments across all active loans. */
  monthlyLoanRepayment: number;
  /** Sum of EWMA contributions across all `STOCK` / `PENSION` portfolios. */
  monthlyInvestmentContribution: number;
  /** `monthlyBills + monthlyCreditCardPayoff + monthlyLoanRepayment + monthlyInvestmentContribution`. */
  monthlyCashOut: number;
  /** `monthlyIncome − monthlyCashOut`. */
  monthlyNetCashFlow: number;
};

export type ForecastResult = {
  points: ForecastPoint[];
  workings: {
    /** Aggregated starting cash across all `CASH` assets, home-currency minor. */
    cashStart: number;
    /** Monthly cash balance, length `months + 1`. */
    cashBalance: number[];
    cashflow: ForecastCashflow;
    categories: ForecastCategoryWorkings[];
  };
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

function projectOne(
  cat: ForecastCategory,
  start: number,
  inputs: ForecastInputs,
): ForecastCategoryWorkings {
  const months = inputs.months;
  const base: ForecastCategoryWorkings = {
    categoryId: cat.id,
    startingBalance: start,
    growthRate: null,
    xirr: null,
    monthlyContribution: 0,
    monthlySpend: 0,
    monthlyRepayment: 0,
    interestRate: null,
    projectedBalance: new Array<number>(months + 1).fill(start),
  };

  if (cat.kind === "asset") {
    switch (cat.assetType) {
      case "PROPERTY":
      case "VEHICLE":
        base.growthRate = cat.growthRate ?? null;
        base.projectedBalance = projectMonthlyGrowth(
          start,
          cat.growthRate ?? null,
          months,
        );
        return base;
      case "STOCK":
      case "PENSION": {
        const xirr = cat.xirr ?? null;
        const monthlyFactor = xirr == null ? 1 : Math.pow(1 + xirr, 1 / 12);
        const contribution = ewmaMonthlyContribution(
          inputs.portfolioTxs.get(cat.id) ?? [],
          inputs.asOfMonthStart,
        );
        const series = new Array<number>(months + 1);
        series[0] = start;
        for (let i = 1; i <= months; i++) {
          series[i] = series[i - 1] * monthlyFactor + contribution;
        }
        base.xirr = xirr;
        base.monthlyContribution = contribution;
        base.projectedBalance = series;
        return base;
      }
      case "CASH":
        // Cash is aggregated globally; the per-category series is
        // unused but kept for shape-consistency.
        return base;
      case "OPTION":
      case "MISC":
        return base;
    }
  }
  if (cat.kind === "liability") {
    switch (cat.liabilityType) {
      case "CREDIT_CARD": {
        // Cards are assumed paid off in full each month, so the balance
        // stays flat at `start`. Spend feeds the cashflow breakdown via
        // `monthlyCreditCardPayoff`.
        base.monthlySpend = creditCardEwmaSpend(
          inputs.liabilityTxs.get(cat.id) ?? [],
          inputs.asOfMonthStart,
        );
        return base;
      }
      case "LOAN": {
        const repayment = loanEwmaRepayment(
          inputs.liabilityTxs.get(cat.id) ?? [],
          inputs.loanBills.get(cat.id) ?? [],
          inputs.asOfMonthStart,
        );
        base.monthlyRepayment = repayment;
        base.interestRate = cat.interestRate ?? null;
        base.projectedBalance = projectLoanBalance(
          start,
          repayment,
          cat.interestRate ?? 0,
          months,
        );
        return base;
      }
      case "MISC":
        return base;
    }
  }
  return base;
}

function computeCashflow(
  inputs: ForecastInputs,
  workings: Map<string, ForecastCategoryWorkings>,
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
    const w = workings.get(cat.id);
    if (!w) continue;
    if (cat.kind === "liability" && !cat.skip) {
      if (cat.liabilityType === "CREDIT_CARD") {
        monthlyCreditCardPayoff += w.monthlySpend;
      } else if (cat.liabilityType === "LOAN") {
        monthlyLoanRepayment += w.monthlyRepayment;
      }
    } else if (
      cat.kind === "asset" &&
      (cat.assetType === "STOCK" || cat.assetType === "PENSION")
    ) {
      monthlyInvestmentContribution += w.monthlyContribution;
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

/**
 * Project monthly net worth forward from a pre-loaded snapshot. Skipped liabilities drop out entirely. Cash is modelled as a single aggregate bucket whose monthly delta is `(income EWMA) − (bills + CC payoff + loan repayment + investment contributions)`. Returns both the aggregate per-month points and the per-category / per-cashflow-component workings used to derive them.
 */
export function runForecast(inputs: ForecastInputs): ForecastResult {
  const { months, categories, startingBalance, asOfMonthStart } = inputs;

  let cashStart = 0;
  const workingsById = new Map<string, ForecastCategoryWorkings>();
  for (const cat of categories) {
    if (cat.kind === "liability" && cat.skip) continue;
    const start = startingBalance.get(cat.id) ?? 0;
    if (cat.kind === "asset" && cat.assetType === "CASH") {
      cashStart += start;
      continue;
    }
    workingsById.set(cat.id, projectOne(cat, start, inputs));
  }

  const cashflow = computeCashflow(inputs, workingsById);
  const cashBalance: number[] = new Array(months + 1);
  cashBalance[0] = cashStart;
  for (let i = 1; i <= months; i++) {
    cashBalance[i] = cashBalance[i - 1] + cashflow.monthlyNetCashFlow;
  }

  const points: ForecastPoint[] = [];
  for (let m = 0; m <= months; m++) {
    const byType = new Map<AssetType, number>();
    if (cashBalance[m] !== 0) byType.set("CASH", cashBalance[m]);
    let assets = cashBalance[m];
    let liabilities = 0;

    for (const cat of categories) {
      if (cat.kind === "liability" && cat.skip) continue;
      if (cat.kind === "asset" && cat.assetType === "CASH") continue;
      const w = workingsById.get(cat.id);
      if (!w) continue;
      const bal = w.projectedBalance[m];
      if (cat.kind === "asset") {
        byType.set(cat.assetType, (byType.get(cat.assetType) ?? 0) + bal);
        assets += bal;
      } else if (cat.kind === "liability") {
        liabilities += bal;
      } else {
        byType.set("OPTION", (byType.get("OPTION") ?? 0) + bal);
        assets += bal;
      }
    }

    points.push({
      date: addMonths(asOfMonthStart, m),
      assetsByType: [...byType.entries()]
        .filter(([, v]) => v !== 0)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([type, amount]) => ({ type, amount })),
      assets,
      liabilities,
      net: assets - liabilities,
    });
  }

  return {
    points,
    workings: {
      cashStart,
      cashBalance,
      cashflow,
      categories: [...workingsById.values()],
    },
  };
}

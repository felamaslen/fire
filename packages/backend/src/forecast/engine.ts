/**
 * Monthly net-worth forecast engine. Pure — takes a pre-loaded snapshot of today's category balances plus the historical rows the EWMA helpers need, and projects forward. Returns both the per-month aggregate points and the "workings" (per-category per-month balances, derived EWMA figures) so clients can show their reasoning, not just the bottom line.
 *
 * Cash is held flat at its current value across the forecast horizon — the model does not simulate income or spending. Growth assets compound at their configured rate; portfolios compound at XIRR plus an EWMA monthly contribution; loans accrue interest and are paid down by an EWMA monthly repayment; flat assets, flat liabilities, credit cards, options, and misc categories all stay at their present value.
 *
 * DB loading lives in a separate module so this stays unit-testable.
 */

import { addMonths } from "date-fns";

import {
  ewmaMonthlyContribution,
  type LiabilityBill,
  type LiabilityTx,
  loanEwmaRepayment,
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
  /** `PlanningTransactions` grouped by loan liability id — feeds the loan repayment EWMA. */
  liabilityTxs: Map<string, readonly LiabilityTx[]>;
  /** `PlanningBills` grouped by loan liability id — fallback for months with no loan transactions. */
  loanBills: Map<string, readonly LiabilityBill[]>;
  /** `PlanningTransactions` with an `assetId` set, grouped by that wrapper asset's id — the per-month contribution EWMA into each `STOCK` / `PENSION` portfolio. */
  portfolioContributionTxs: Map<string, readonly LiabilityTx[]>;
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
  /** `LOAN` only — EWMA monthly repayment subtracted from the balance after interest. */
  monthlyRepayment: number;
  /** `LOAN` only — percentage annual interest carried through from the category. */
  interestRate: number | null;
  /** Projected balance, length `months + 1`, home-currency minor units. */
  projectedBalance: number[];
};

export type ForecastResult = {
  points: ForecastPoint[];
  workings: {
    categories: ForecastCategoryWorkings[];
  };
};

function flatProjection(start: number, months: number): number[] {
  return new Array<number>(months + 1).fill(start);
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
    monthlyRepayment: 0,
    interestRate: null,
    projectedBalance: flatProjection(start, months),
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
          inputs.portfolioContributionTxs.get(cat.id) ?? [],
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
      case "OPTION":
      case "MISC":
        return base;
    }
  }
  if (cat.kind === "liability") {
    switch (cat.liabilityType) {
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
      case "CREDIT_CARD":
      case "MISC":
        return base;
    }
  }
  return base;
}

/**
 * Project monthly net worth forward from a pre-loaded snapshot. Skipped liabilities drop out entirely. Cash, credit cards, options, misc, and anything without growth data stay flat. Growth assets compound at their configured rate; portfolios at XIRR plus EWMA contributions; loans accrue interest and are paid down by EWMA repayments.
 */
export function runForecast(inputs: ForecastInputs): ForecastResult {
  const { months, categories, startingBalance, asOfMonthStart } = inputs;

  const workingsById = new Map<string, ForecastCategoryWorkings>();
  for (const cat of categories) {
    if (cat.kind === "liability" && cat.skip) continue;
    const start = startingBalance.get(cat.id) ?? 0;
    workingsById.set(cat.id, projectOne(cat, start, inputs));
  }

  const points: ForecastPoint[] = [];
  for (let m = 0; m <= months; m++) {
    const byType = new Map<AssetType, number>();
    let assets = 0;
    let liabilities = 0;

    for (const cat of categories) {
      if (cat.kind === "liability" && cat.skip) continue;
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
      categories: [...workingsById.values()],
    },
  };
}

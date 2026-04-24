/**
 * Monthly net-worth forecast engine. Pure — takes a pre-loaded snapshot of today's category balances plus the historical rows the EWMA helpers need, and projects forward. Returns both the per-month aggregate points and the "workings" (per-category per-month balances, derived EWMA figures) so clients can show their reasoning, not just the bottom line.
 *
 * Pre-retirement (or always, when no retirement year is set): cash is held flat across the forecast horizon — the model does not simulate income or spending. Growth assets compound at their configured rate; portfolios compound at XIRR plus an EWMA monthly contribution; loans accrue interest and are paid down by an EWMA monthly repayment; flat assets, flat liabilities, credit cards, options, and misc categories all stay at their present value.
 *
 * Post-retirement (once the first day of `retirementYear` is reached): income drops to zero — portfolio contributions and payslip-funded loan repayments stop. Portfolios continue to grow at XIRR but get drawn down at `RETIREMENT_DRAWDOWN_RATE/12` of their running balance each month. Bill-funded loan repayments continue. Cash absorbs the net of drawdown inflow minus inflation-adjusted spending and bill-funded loan repayments.
 *
 * DB loading lives in a separate module so this stays unit-testable.
 */

import { addMonths } from "date-fns";

import { ANNUAL_INFLATION_RATE, RETIREMENT_DRAWDOWN_RATE } from "@/config";

import {
  ewmaMonthlyContribution,
  type LiabilityBill,
  type LiabilityTx,
  loanEwmaRepayment,
  monthlyGrowthFactor,
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
      /** Date from which a `PENSION` can be drawn down. When set, the post-retirement drawdown skips this pot until the month containing the date. Null or absent means "accessible now". */
      accessibleFrom?: Date | null;
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
  /** `PlanningTransactions` grouped by loan liability id — feeds the loan repayment EWMA from direct liability transactions. */
  liabilityTxs: Map<string, readonly LiabilityTx[]>;
  /** `PlanningBills` grouped by loan liability id — fallback for months with no loan transactions. */
  loanBills: Map<string, readonly LiabilityBill[]>;
  /** `PlanningPayslipAdjustments` with a loan `liabilityId` set, grouped by that liability's id — feeds the payslip-deduction loan-repayment EWMA, and identifies which loans stop paying down post-retirement. */
  loanPayslipAdjustments: Map<string, readonly LiabilityTx[]>;
  /** `PlanningTransactions` with an `assetId` set, grouped by that wrapper asset's id — the per-month contribution EWMA into each `STOCK` / `PENSION` portfolio. */
  portfolioContributionTxs: Map<string, readonly LiabilityTx[]>;
  /** Calendar year of planned retirement, or `null` for no retirement transition. The first day of this year starts the post-retirement phase. */
  retirementYear?: number | null;
  /** EWMA of monthly net payslip income across accounts, home-currency minor units. Informational: pre-retirement cash is held flat, so this does not shift projected balances. */
  monthlyIncome?: number;
  /** EWMA of monthly spending (credit-card EWMA + non-liability bills, monthlified) in home-currency minor units. Drives the post-retirement cash drawdown; inflated at `ANNUAL_INFLATION_RATE` per year after retirement. */
  monthlySpending?: number;
  /** Annual HMRC self-assessment refund from higher/additional-rate pension-relief claims — lands as a lump sum in the earner's cash account once per year. Applied at months 12, 24, ... pre-retirement; skipped at / after the retirement month (no income, no refund). */
  annualSelfAssessmentRefund?: number;
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
  /** `STOCK` / `PENSION` only — EWMA monthly contribution added to the balance each month (pre-retirement only). */
  monthlyContribution: number;
  /** `LOAN` only — EWMA monthly repayment from direct liability transactions plus scheduled bills. Continues post-retirement (funded from cash). */
  monthlyBillRepayment: number;
  /** `LOAN` only — EWMA monthly repayment from payslip deductions. Stops post-retirement (no more payslips). */
  monthlyPayslipRepayment: number;
  /** `LOAN` only — the combined monthly repayment used pre-retirement (`monthlyBillRepayment + monthlyPayslipRepayment`). */
  monthlyRepayment: number;
  /** `LOAN` only — percentage annual interest carried through from the category. */
  interestRate: number | null;
  /** Projected balance, length `months + 1`, home-currency minor units. */
  projectedBalance: number[];
};

/** A single point-in-time event the forecast can surface on the chart — loan paid off, pension becomes accessible, etc. Milestones that land on the same month + kind are grouped into a single entry with multiple `categoryIds`. */
export type ForecastMilestone = {
  kind: "LOAN_PAID_OFF" | "PENSION_ACCESSIBLE";
  /** 0-based month index into `points`. */
  monthIndex: number;
  /** Ids of the categories this milestone applies to — multiple when several pay off / become accessible on the same month. */
  categoryIds: string[];
};

export type ForecastResult = {
  points: ForecastPoint[];
  workings: {
    categories: ForecastCategoryWorkings[];
    /** Index (0-based) into `points` at which the retirement transition takes effect, or `null` if no retirement year is set or it falls outside the horizon. Month `retirementMonthIndex` is the first post-retirement month. */
    retirementMonthIndex: number | null;
    /** EWMA-derived monthly net income pre-retirement (zero after). Informational; pre-retirement cash is held flat. */
    monthlyIncome: number;
    /** EWMA-derived monthly spending in the starting month. Inflated at `ANNUAL_INFLATION_RATE` per year after retirement. */
    monthlySpending: number;
    /** Assumed annual inflation rate applied to spending post-retirement, as a decimal. */
    inflationRate: number;
    /** Assumed annual drawdown rate from the portfolio post-retirement, as a decimal. */
    drawdownRate: number;
    /** Notable events inside the forecast horizon — e.g. loans paid off, pensions becoming accessible. Sorted by `monthIndex` ascending. */
    milestones: ForecastMilestone[];
  };
};

function flatProjection(start: number, months: number): number[] {
  return new Array<number>(months + 1).fill(start);
}

/**
 * Month-offset from `asOfMonthStart` to the 1st of the month containing `date`. Returns `null` when `date` is null/undefined; returns `0` when the date is already in the past (treat as "accessible now"). Capping at the forecast horizon is the caller's job.
 */
function monthIndexForDate(
  date: Date | null | undefined,
  asOfMonthStart: Date,
): number | null {
  if (date == null) return null;
  const diff =
    (date.getUTCFullYear() - asOfMonthStart.getUTCFullYear()) * 12 +
    (date.getUTCMonth() - asOfMonthStart.getUTCMonth());
  return Math.max(0, diff);
}

/**
 * Compute the first post-retirement month index into a monthly series starting at `asOfMonthStart`. Returns `null` when no retirement year is set, when retirement is already in the past at the start of the forecast (treated as "already retired" — index 0), or when it falls beyond the horizon.
 */
function computeRetirementMonthIndex(
  asOfMonthStart: Date,
  months: number,
  retirementYear: number | null | undefined,
): number | null {
  if (retirementYear == null) return null;
  const startYear = asOfMonthStart.getUTCFullYear();
  const startMonth = asOfMonthStart.getUTCMonth();
  // Months from asOfMonthStart to January of retirementYear.
  const diff = (retirementYear - startYear) * 12 - startMonth;
  if (diff <= 0) return 0;
  if (diff > months) return null;
  return diff;
}

/**
 * Project monthly net worth forward from a pre-loaded snapshot. Skipped liabilities drop out entirely. Cash, credit cards, options, misc, and anything without growth data stay flat pre-retirement. Growth assets compound at their configured rate; portfolios at XIRR plus EWMA contributions (stopped post-retirement, replaced by drawdown); loans accrue interest and are paid down by EWMA repayments (payslip-funded portion stops post-retirement). Post-retirement cash absorbs drawdown minus inflated spending and bill-funded loan repayments.
 */
export function runForecast(inputs: ForecastInputs): ForecastResult {
  const { months, categories, startingBalance, asOfMonthStart } = inputs;
  const retirementIndex = computeRetirementMonthIndex(
    asOfMonthStart,
    months,
    inputs.retirementYear,
  );
  const monthlyIncome = inputs.monthlyIncome ?? 0;
  const monthlySpending = inputs.monthlySpending ?? 0;

  const workingsById = new Map<string, ForecastCategoryWorkings>();
  const cashIds: string[] = [];

  for (const cat of categories) {
    // Project every category — even `skip`ped liabilities — so downstream
    // consumers (e.g. the milestone builder) can still see when a loan
    // would be paid off. `skip` only affects aggregation and cash drift,
    // handled in the loops below.
    const start = startingBalance.get(cat.id) ?? 0;
    const w = projectNonCash(cat, start, inputs, retirementIndex);
    workingsById.set(cat.id, w);
    if (cat.kind === "asset" && cat.assetType === "CASH") {
      cashIds.push(cat.id);
    }
  }

  // Cash drift combines:
  //   - Pre-retirement: an annual lump-sum bump on each 12-month anniversary
  //     representing the self-assessment refund landing in the bank.
  //   - Post-retirement: portfolio drawdown minus inflation-adjusted
  //     spending minus ongoing bill-funded loan repayments.
  // Distributed across CASH categories in proportion to their starting
  // balance (or onto the first one if every cash balance is zero).
  const cashDrift = buildCashDrift(
    inputs,
    workingsById,
    retirementIndex,
    monthlySpending,
  );
  distributeDriftAcrossCash(cashIds, workingsById, cashDrift);

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

  const milestones = buildMilestones(inputs, workingsById);

  return {
    points,
    workings: {
      categories: [...workingsById.values()],
      retirementMonthIndex: retirementIndex,
      monthlyIncome,
      monthlySpending,
      inflationRate: ANNUAL_INFLATION_RATE,
      drawdownRate: RETIREMENT_DRAWDOWN_RATE,
      milestones,
    },
  };
}

/**
 * Scan the projected workings for notable events worth pinning to the chart: loans paid off, pension pots becoming accessible. Entries on the same `(kind, monthIndex)` are grouped so a chart marker for "3 pensions unlocked Jan 2040" doesn't stack three near-identical vertical lines.
 */
function buildMilestones(
  inputs: ForecastInputs,
  workings: Map<string, ForecastCategoryWorkings>,
): ForecastMilestone[] {
  const byKey = new Map<string, ForecastMilestone>();
  const push = (
    kind: ForecastMilestone["kind"],
    monthIndex: number,
    categoryId: string,
  ) => {
    const key = `${kind}|${monthIndex}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.categoryIds.push(categoryId);
    } else {
      byKey.set(key, { kind, monthIndex, categoryIds: [categoryId] });
    }
  };

  for (const cat of inputs.categories) {
    if (cat.kind === "liability" && cat.liabilityType === "LOAN") {
      // Milestones include `skip`ped loans — the user may have hidden them
      // from aggregates but still wants to see "loan paid off" on the chart.
      const w = workings.get(cat.id);
      if (!w) continue;
      const series = w.projectedBalance;
      if (series[0] <= 0) continue;
      for (let m = 1; m < series.length; m++) {
        if (series[m] <= 0 && series[m - 1] > 0) {
          push("LOAN_PAID_OFF", m, cat.id);
          break;
        }
      }
    }
    if (cat.kind === "asset" && cat.assetType === "PENSION") {
      const idx = monthIndexForDate(cat.accessibleFrom, inputs.asOfMonthStart);
      // Skip pensions already accessible (idx === 0) and ones outside the
      // horizon — no marker to paint for either.
      if (idx != null && idx > 0 && idx <= inputs.months) {
        push("PENSION_ACCESSIBLE", idx, cat.id);
      }
    }
  }

  return [...byKey.values()].sort((a, b) => a.monthIndex - b.monthIndex);
}

/**
 * Project a single non-cash category across the full horizon. Cash is left at its starting balance here and updated later via `distributeDriftAcrossCash` so post-retirement cash can absorb cashflow computed from other categories' workings.
 */
function projectNonCash(
  cat: ForecastCategory,
  start: number,
  inputs: ForecastInputs,
  retirementIndex: number | null,
): ForecastCategoryWorkings {
  const months = inputs.months;
  const base: ForecastCategoryWorkings = {
    categoryId: cat.id,
    startingBalance: start,
    growthRate: null,
    xirr: null,
    monthlyContribution: 0,
    monthlyBillRepayment: 0,
    monthlyPayslipRepayment: 0,
    monthlyRepayment: 0,
    interestRate: null,
    projectedBalance: flatProjection(start, months),
  };

  if (cat.kind === "asset") {
    switch (cat.assetType) {
      case "PROPERTY":
      case "VEHICLE":
        base.growthRate = cat.growthRate ?? null;
        base.projectedBalance = projectGrowthAsset(
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
        const monthlyDrawdownFactor = 1 - RETIREMENT_DRAWDOWN_RATE / 12;
        // Pension pots with a minimum access date (e.g. UK age-57 lock-in)
        // don't begin drawdown until the month containing that date, even
        // if the user is retired. They still grow at XIRR in the meantime.
        const accessibleIndex = monthIndexForDate(
          cat.kind === "asset" ? cat.accessibleFrom : null,
          inputs.asOfMonthStart,
        );
        const series = new Array<number>(months + 1);
        series[0] = start;
        for (let i = 1; i <= months; i++) {
          const retired = retirementIndex != null && i >= retirementIndex;
          const accessible = accessibleIndex == null || i >= accessibleIndex;
          const grown = series[i - 1] * monthlyFactor;
          if (!retired) {
            series[i] = grown + contribution;
          } else if (accessible) {
            series[i] = grown * monthlyDrawdownFactor;
          } else {
            // Retired but pot still locked: grow without drawdown, no new
            // contributions (income has stopped).
            series[i] = grown;
          }
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
        const billRepayment = loanEwmaRepayment(
          inputs.liabilityTxs.get(cat.id) ?? [],
          inputs.loanBills.get(cat.id) ?? [],
          inputs.asOfMonthStart,
        );
        const payslipRepayment = ewmaMonthlyContribution(
          inputs.loanPayslipAdjustments.get(cat.id) ?? [],
          inputs.asOfMonthStart,
          12,
        );
        base.monthlyBillRepayment = billRepayment;
        base.monthlyPayslipRepayment = payslipRepayment;
        base.monthlyRepayment = billRepayment + payslipRepayment;
        base.interestRate = cat.interestRate ?? null;
        base.projectedBalance = projectLoanWithRetirement(
          start,
          billRepayment,
          payslipRepayment,
          cat.interestRate ?? 0,
          months,
          retirementIndex,
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

function projectGrowthAsset(
  startValue: number,
  annualPercent: number | null,
  months: number,
): number[] {
  const factor = monthlyGrowthFactor(annualPercent);
  const out: number[] = new Array(months + 1);
  out[0] = startValue;
  for (let i = 1; i <= months; i++) out[i] = out[i - 1] * factor;
  return out;
}

/**
 * Project a loan balance forward, compounding annual interest monthly and deducting repayments. Pre-retirement both bill-funded and payslip-funded repayments apply; post-retirement only bill-funded repayments continue (income is zero). Balance is clamped at zero.
 */
function projectLoanWithRetirement(
  startBalance: number,
  monthlyBillRepayment: number,
  monthlyPayslipRepayment: number,
  annualInterestPercent: number,
  months: number,
  retirementIndex: number | null,
): number[] {
  const monthlyFactor = Math.pow(1 + annualInterestPercent / 100, 1 / 12);
  const out = new Array<number>(months + 1);
  out[0] = startBalance;
  for (let i = 1; i <= months; i++) {
    const retired = retirementIndex != null && i >= retirementIndex;
    const repayment =
      monthlyBillRepayment + (retired ? 0 : monthlyPayslipRepayment);
    const afterInterest = out[i - 1] * monthlyFactor;
    out[i] = Math.max(0, afterInterest - repayment);
  }
  return out;
}

/**
 * Cumulative per-month cash delta across the whole horizon. Combines:
 *   - Pre-retirement: a lump-sum `annualSelfAssessmentRefund` bump at each 12-month anniversary (months 12, 24, …) up to — but not including — `retirementIndex`. Other pre-retirement months are zero.
 *   - Post-retirement: drawdown (≈ `RETIREMENT_DRAWDOWN_RATE/12` of each portfolio's balance) minus inflation-adjusted spending minus bill-funded loan repayments that still have a balance to pay.
 */
function buildCashDrift(
  inputs: ForecastInputs,
  workings: Map<string, ForecastCategoryWorkings>,
  retirementIndex: number | null,
  monthlySpending: number,
): number[] {
  const drift = new Array<number>(inputs.months + 1).fill(0);
  const monthlyInflationFactor = Math.pow(1 + ANNUAL_INFLATION_RATE, 1 / 12);
  const drawdownFraction = RETIREMENT_DRAWDOWN_RATE / 12;
  const annualSaRefund = inputs.annualSelfAssessmentRefund ?? 0;
  const preRetirementEnd =
    retirementIndex == null ? inputs.months + 1 : retirementIndex;

  for (let m = 1; m <= inputs.months; m++) {
    if (m < preRetirementEnd) {
      // Pre-retirement: cash is flat except for the annual SA refund
      // lump sum landing on each 12-month anniversary.
      const bump = m % 12 === 0 ? annualSaRefund : 0;
      drift[m] = drift[m - 1] + bump;
      continue;
    }
    // Post-retirement.
    let drawdown = 0;
    let loanRepayments = 0;
    for (const cat of inputs.categories) {
      if (
        cat.kind === "asset" &&
        (cat.assetType === "STOCK" || cat.assetType === "PENSION")
      ) {
        const w = workings.get(cat.id);
        if (!w) continue;
        // Skip locked pensions — if the pot can't be drawn yet, it
        // contributes nothing to this month's cash drift.
        const accessibleIndex = monthIndexForDate(
          cat.accessibleFrom,
          inputs.asOfMonthStart,
        );
        if (accessibleIndex != null && m < accessibleIndex) continue;
        // Drawdown is the portion of the portfolio we pulled out this month:
        // balance[m-1] grown to balance[m-1]*monthlyFactor, multiplied by
        // drawdownFraction. That's equivalent to balance[m-1] * xirrFactor *
        // drawdownFraction — but since post-retirement contribution is zero,
        // `balance[m-1] * xirrFactor = balance[m] / (1 - drawdownFraction)`.
        // Use that to extract the drawdown directly from the series.
        const bal = w.projectedBalance[m];
        const balBeforeDrawdown = bal / (1 - drawdownFraction);
        drawdown += balBeforeDrawdown - bal;
      }
      if (
        cat.kind === "liability" &&
        !cat.skip &&
        cat.liabilityType === "LOAN"
      ) {
        const w = workings.get(cat.id);
        if (!w) continue;
        // Loan bill repayment only actually pulls cash if there's still a
        // balance to pay. If the loan is fully paid off before this month,
        // there's no cash outflow.
        const prev = w.projectedBalance[m - 1] ?? 0;
        if (prev > 0) {
          loanRepayments += Math.min(w.monthlyBillRepayment, prev);
        }
      }
    }
    const monthsSinceRetirement =
      retirementIndex == null ? 0 : m - retirementIndex;
    const inflatedSpending =
      monthlySpending * Math.pow(monthlyInflationFactor, monthsSinceRetirement);
    drift[m] = drift[m - 1] + drawdown - loanRepayments - inflatedSpending;
  }
  return drift;
}

/**
 * Apply a cumulative per-month cash drift onto the CASH categories, distributed in proportion to each category's starting balance. When every CASH category is empty, the whole drift lands on the first one — otherwise the drift has nowhere to go and we'd silently drop the post-retirement cashflow.
 */
function distributeDriftAcrossCash(
  cashIds: readonly string[],
  workings: Map<string, ForecastCategoryWorkings>,
  drift: readonly number[],
): void {
  if (cashIds.length === 0) return;
  const totalStart = cashIds.reduce(
    (s, id) => s + (workings.get(id)?.startingBalance ?? 0),
    0,
  );
  for (const id of cashIds) {
    const w = workings.get(id);
    if (!w) continue;
    const share =
      totalStart > 0
        ? w.startingBalance / totalStart
        : id === cashIds[0]
          ? 1
          : 0;
    if (share === 0) continue;
    const series = w.projectedBalance.slice();
    for (let m = 0; m < series.length; m++) {
      series[m] = series[m] + drift[m] * share;
    }
    w.projectedBalance = series;
  }
}

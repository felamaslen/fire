/**
 * Value and cashflow forecasting utilities shared by the net-worth forecast engine and the planning balance module. Pure math plus a handful of tiny helpers that bucket raw planning rows into the per-month samples we feed the EWMA. No DB, no GraphQL, no side effects — each helper takes the rows it needs as parameters so the DB-shaped loaders upstream stay separate and testable.
 */

import { addMonths } from "date-fns";

import { collectionDayInMonth } from "@/graphql/planning/balance";

// ============================================================
// Primitives
// ============================================================

/**
 * Exponentially-weighted moving average of `values` ordered most-recent first. Uses α = 2 / (n + 1) (Pandas' default span formula) so the caller picks the decay implicitly by choosing the window size.
 *
 * Returns 0 for an empty input so call sites can treat "no samples" as "no cashflow" without an explicit null check. Output is a float — if the caller needs an integer (e.g. minor-currency units) it's their responsibility to round.
 */
export function ewma(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const alpha = 2 / (values.length + 1);
  let s = values[values.length - 1];
  for (let i = values.length - 2; i >= 0; i--) {
    s = alpha * values[i] + (1 - alpha) * s;
  }
  return s;
}

// ============================================================
// Per-type asset value compounding (property, vehicle)
// ============================================================

/**
 * Convert a percentage annual growth rate (e.g. `3` for +3%/year, `-15` for −15%/year depreciation) into the equivalent monthly compounding factor. Returns `1` when the rate is null or zero so callers can multiply unconditionally.
 */
export function monthlyGrowthFactor(annualPercent: number | null): number {
  if (annualPercent == null || annualPercent === 0) return 1;
  const annual = annualPercent / 100;
  return Math.pow(1 + annual, 1 / 12);
}

/**
 * Project `startValue` forward `months` months at the given annual rate, compounded monthly. Returns an array of length `months + 1` starting at `startValue`.
 */
export function projectMonthlyGrowth(
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

// ============================================================
// Liability balance projection (credit cards, loans)
// ============================================================

/**
 * Project a loan balance forward, compounding the annual interest rate monthly and deducting a fixed monthly repayment. The balance is clamped at zero — once the loan is paid off it stays paid off.
 */
export function projectLoanBalance(
  startBalance: number,
  monthlyRepayment: number,
  annualInterestPercent: number,
  months: number,
): number[] {
  const monthlyFactor = Math.pow(1 + annualInterestPercent / 100, 1 / 12);
  const out = new Array<number>(months + 1);
  out[0] = startBalance;
  for (let i = 1; i <= months; i++) {
    const afterInterest = out[i - 1] * monthlyFactor;
    out[i] = Math.max(0, afterInterest - monthlyRepayment);
  }
  return out;
}

// ============================================================
// EWMA inputs from raw planning rows
// ============================================================

export type LiabilityTx = {
  /** Transaction date (UTC). */
  date: Date;
  /** Signed minor-currency amount; sign is ignored — repayments are normally negative against the account, positive against the liability. */
  amount: number;
};

export type LiabilityBill = {
  start: Date;
  end: Date | null;
  frequency: "MONTHLY" | "QUARTERLY" | "YEARLY";
  /** Raw stored `PlanningBills.collectionDate` (decoded by `collectionDayInMonth`). */
  collectionDate: string;
  /** Scheduled amount in minor currency units. */
  amount: number;
};

export type InvestmentTx = {
  /** Transaction date (UTC). */
  date: Date;
  /** Signed units — positive for buys, negative for sells. */
  units: number;
  /** Unit price in the investment's currency, major units. */
  price: number;
};

function sumLiabilityTxInMonth(
  txs: readonly LiabilityTx[],
  monthStart: Date,
): number {
  const next = addMonths(monthStart, 1);
  let sum = 0;
  for (const tx of txs) {
    if (tx.date >= monthStart && tx.date < next) sum += Math.abs(tx.amount);
  }
  return sum;
}

function billFiresInMonth(bill: LiabilityBill, monthStart: Date): boolean {
  const nextMonth = addMonths(monthStart, 1);
  if (bill.start >= nextMonth) return false;
  if (bill.end != null && bill.end < monthStart) return false;
  const day = collectionDayInMonth(
    bill.frequency,
    bill.collectionDate,
    monthStart,
  );
  if (day == null) return false;
  const collectionOn = new Date(
    Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth(), day),
  );
  return (
    collectionOn >= bill.start && (bill.end == null || collectionOn <= bill.end)
  );
}

/**
 * EWMA of the last `windowMonths` calendar months of credit-card spending against this liability. Each month = sum of `|tx.amount|` for `PlanningTransactions` tagged to the card in that month. Months with no transactions count as zero. Samples are ordered most-recent first, and the window ends at the calendar month immediately preceding `asOfMonthStart` (we don't include the current, partially-elapsed month).
 */
export function creditCardEwmaSpend(
  txs: readonly LiabilityTx[],
  asOfMonthStart: Date,
  windowMonths = 12,
): number {
  const samples: number[] = [];
  for (let i = 1; i <= windowMonths; i++) {
    samples.push(sumLiabilityTxInMonth(txs, addMonths(asOfMonthStart, -i)));
  }
  return ewma(samples);
}

/**
 * EWMA of the last `windowMonths` *non-zero* months of loan repayment activity. For each month working back from the one before `asOfMonthStart`, we take the sum of `|tx.amount|` if any transactions hit the liability that month; otherwise we fall back to the scheduled bill amount if any bill fires that month; otherwise we skip the month. We stop once we have `windowMonths` samples or have gone back `maxLookback` months — whichever comes first. Returns 0 when there is no historical activity at all, which the caller should treat as "don't extrapolate repayments on this loan".
 */
export function loanEwmaRepayment(
  txs: readonly LiabilityTx[],
  bills: readonly LiabilityBill[],
  asOfMonthStart: Date,
  windowMonths = 10,
  maxLookback = 36,
): number {
  const samples: number[] = [];
  for (let i = 1; i <= maxLookback && samples.length < windowMonths; i++) {
    const m = addMonths(asOfMonthStart, -i);
    const txSum = sumLiabilityTxInMonth(txs, m);
    if (txSum > 0) {
      samples.push(txSum);
      continue;
    }
    let billSum = 0;
    for (const b of bills) if (billFiresInMonth(b, m)) billSum += b.amount;
    if (billSum > 0) samples.push(billSum);
  }
  return ewma(samples);
}

/**
 * EWMA of monthly cash contributions into a portfolio over the last `windowMonths` complete calendar months (newest first, excluding the month containing `asOfMonthStart`). Each sample sums `|tx.amount|` of `PlanningTransactions` tagged with the wrapper's asset id for that month — contributions are stored as outflows from a cash account (negative) so the magnitude is the relevant figure. Months with no transactions count as zero.
 */
export function ewmaMonthlyContribution(
  txs: readonly LiabilityTx[],
  asOfMonthStart: Date,
  windowMonths = 36,
): number {
  const samples: number[] = [];
  for (let i = 1; i <= windowMonths; i++) {
    samples.push(sumLiabilityTxInMonth(txs, addMonths(asOfMonthStart, -i)));
  }
  return ewma(samples);
}

/**
 * Internal-rate-of-return for an irregular cashflow stream (XIRR). `flows` must contain at least one positive and one negative entry. Uses Newton–Raphson with a wide-bracket bisection fallback. Returns the annualised rate as a decimal (e.g. `0.08` = 8%/yr), or `null` when no sensible root is found.
 */
export function solveXirr(
  flows: readonly { date: Date; amount: number }[],
): number | null {
  if (flows.length < 2) return null;
  const hasPos = flows.some((f) => f.amount > 0);
  const hasNeg = flows.some((f) => f.amount < 0);
  if (!hasPos || !hasNeg) return null;

  // Reference = earliest date; ages in fractional years since then.
  let refMs = flows[0].date.getTime();
  for (const f of flows) refMs = Math.min(refMs, f.date.getTime());
  const msPerYear = 365.25 * 24 * 60 * 60 * 1000;
  const ages = flows.map((f) => (f.date.getTime() - refMs) / msPerYear);

  const npv = (r: number): number => {
    let s = 0;
    for (let i = 0; i < flows.length; i++) {
      s += flows[i].amount / Math.pow(1 + r, ages[i]);
    }
    return s;
  };
  const dnpv = (r: number): number => {
    let s = 0;
    for (let i = 0; i < flows.length; i++) {
      if (ages[i] === 0) continue;
      s += (-ages[i] * flows[i].amount) / Math.pow(1 + r, ages[i] + 1);
    }
    return s;
  };

  // Newton-Raphson.
  let r = 0.1;
  for (let i = 0; i < 100; i++) {
    const v = npv(r);
    if (Math.abs(v) < 1e-7) return r;
    const d = dnpv(r);
    if (d === 0) break;
    const next = r - v / d;
    if (!Number.isFinite(next) || next <= -0.999) break;
    if (Math.abs(next - r) < 1e-9) return next;
    r = next;
  }

  // Bisection fallback over a wide bracket.
  let lo = -0.999;
  let hi = 10;
  let fLo = npv(lo);
  if (fLo * npv(hi) > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fMid = npv(mid);
    if (Math.abs(fMid) < 1e-7 || hi - lo < 1e-9) return mid;
    if (fLo * fMid < 0) {
      hi = mid;
    } else {
      lo = mid;
      fLo = fMid;
    }
  }
  return null;
}

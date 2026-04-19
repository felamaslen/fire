/**
 * Value / cashflow forecasting utilities shared by the net-worth
 * forecast engine and the planning balance module. Pure math plus a
 * handful of tiny helpers that bucket raw planning rows into the
 * per-month samples we feed the EWMA. No DB, no GraphQL, no side
 * effects — each helper takes the rows it needs as parameters so the
 * DB-shaped loaders upstream stay separate and testable.
 */

import { addMonths } from "date-fns";

import { collectionDayInMonth } from "@/graphql/planning/balance";

// ============================================================
// Primitives
// ============================================================

/**
 * Exponentially-weighted moving average of `values` ordered most-recent
 * first. Uses α = 2 / (n + 1) (Pandas' default span formula) so the
 * caller picks the decay implicitly by choosing the window size.
 *
 * Returns 0 for an empty input so call sites can treat "no samples" as
 * "no cashflow" without an explicit null check. Output is a float — if
 * the caller needs an integer (e.g. minor-currency units) it's their
 * responsibility to round.
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
 * Convert a percentage annual growth rate (e.g. `3` for +3%/year, `-15`
 * for −15%/year depreciation) into the equivalent monthly compounding
 * factor. Returns `1` when the rate is null or zero so callers can
 * multiply unconditionally.
 */
export function monthlyGrowthFactor(annualPercent: number | null): number {
  if (annualPercent == null || annualPercent === 0) return 1;
  const annual = annualPercent / 100;
  return Math.pow(1 + annual, 1 / 12);
}

/**
 * Project `startValue` forward `months` months at the given annual rate,
 * compounded monthly. Returns an array of length `months + 1` starting
 * at `startValue`.
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
 * Project a credit-card balance forward.
 *
 * Credit cards have no stored interest rate in this system — by
 * convention users only track balances for cards they pay off in full,
 * so the balance either stays flat (paid from a cash account each
 * month) or accrues the monthly spend unabated when no billed-from
 * account is set.
 */
export function projectCreditCardBalance(
  startBalance: number,
  monthlySpend: number,
  months: number,
  paidFromAccount: boolean,
): number[] {
  const out = new Array<number>(months + 1);
  out[0] = startBalance;
  for (let i = 1; i <= months; i++) {
    out[i] = paidFromAccount ? out[i - 1] : out[i - 1] + monthlySpend;
  }
  return out;
}

/**
 * Project a loan balance forward, compounding the annual interest rate
 * monthly and deducting a fixed monthly repayment. The balance is
 * clamped at zero — once the loan is paid off it stays paid off.
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

export type Payslip = {
  /** Pay date (UTC). */
  date: Date;
  /** `PlanningPayslip.toAccountId` — the cash account the net pay lands in. */
  toAccountId: string;
  /** Net pay in minor currency units (gross + signed adjustments). */
  netAmount: number;
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
 * EWMA of the last `windowMonths` calendar months of credit-card
 * spending against this liability. Each month = sum of |tx.amount| of
 * planning transactions tagged to the card in that month. Months with
 * no transactions count as zero. Samples are ordered most-recent first,
 * and the window ends at the calendar month immediately preceding
 * `asOfMonthStart` (we don't include the current, partially-elapsed
 * month).
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
 * EWMA of the last `windowMonths` *non-zero* months of loan repayment
 * activity. For each month working back from the one before
 * `asOfMonthStart`, we take the sum of |tx.amount| if any transactions
 * hit the liability that month; otherwise we fall back to the scheduled
 * bill amount if any bill fires that month; otherwise we skip the
 * month. We stop once we have `windowMonths` samples or have gone back
 * `maxLookback` months — whichever comes first. Returns 0 when there
 * is no historical activity at all, which the caller should treat as
 * "don't extrapolate repayments on this loan".
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
 * EWMA of monthly cash contributions into a portfolio over the last
 * `windowMonths` complete calendar months (newest first, excluding the
 * month containing `asOfMonthStart`). Each transaction contributes
 * `units * price` to its month — positive for buys, negative for
 * sells — and months with no transactions count as zero. Fees / taxes
 * are ignored, matching how `Portfolio.xirr` itself is computed.
 */
export function ewmaMonthlyContribution(
  txs: readonly InvestmentTx[],
  asOfMonthStart: Date,
  windowMonths = 36,
): number {
  const samples: number[] = [];
  for (let i = 1; i <= windowMonths; i++) {
    const monthStart = addMonths(asOfMonthStart, -i);
    const nextMonth = addMonths(monthStart, 1);
    let sum = 0;
    for (const tx of txs) {
      if (tx.date >= monthStart && tx.date < nextMonth) {
        sum += tx.units * tx.price;
      }
    }
    samples.push(sum);
  }
  return ewma(samples);
}

/**
 * EWMA of the `windowSize` most-recent payslip net amounts landing in
 * `accountId`. Returns 0 when there are no payslips for the account —
 * the caller should treat that as "no income projection for this
 * account" and not synthesise a cashflow.
 */
export function ewmaPayslipNet(
  payslips: readonly Payslip[],
  accountId: string,
  windowSize = 10,
): number {
  const forAccount = payslips.filter((p) => p.toAccountId === accountId);
  forAccount.sort((a, b) => b.date.getTime() - a.date.getTime());
  const recent = forAccount.slice(0, windowSize).map((p) => p.netAmount);
  return ewma(recent);
}

import type { PlanningYearUKTaxRates } from "@/db/schema/planning";

/** Input to `computeUKTake`. All monetary values are annual integers in minor units of GBP (pence). Pension fractions are decimals in `[0, 1]`. */
export type UKTakeInput = {
  /** Annual gross pay before any deductions, in pence. E.g. `8_000_000` = £80,000. */
  gross: number;
  pension: {
    /**
     * Salary-sacrifice fraction of gross pay, in `[0, 1]`. Null / undefined when the scheme doesn't use it. E.g. `0.1` = 10% sacrifice: on £80k gross, £8k is diverted before any calculation, so tax / NI / student-loan are assessed on £72k.
     */
    sacrifice?: number | null;
    /**
     * Net-pay pension fraction of post-sacrifice gross, in `[0, 1]`. E.g. `0.05` = 5%. Reduces the income-tax and student-loan bases but leaves NIC on the full post-sacrifice amount.
     */
    netPay: number;
    /**
     * Relief-at-source pension fraction of post-sacrifice gross, in `[0, 1]`. E.g. `0.05` = 5%. Has no effect at PAYE time — HMRC pays basic-rate relief into the pot directly and higher-rate relief is reclaimed via self-assessment.
     */
    relief: number;
  };
  /** Whether UK Student Loan plan 2 is being repaid on this income. When false, `studentLoan` in the result is always 0. */
  studentLoanPlan2: boolean;
  /** UK tax parameters (rates and band thresholds) for the applicable financial year. */
  rates: typeof PlanningYearUKTaxRates.$inferSelect;
};

/** Output of `computeUKTake`. All values are annual integers in minor units of GBP (pence). Deductions are returned as positive numbers; callers can render them as negatives. */
export type UKTake = {
  /** Annual gross after salary-sacrifice deductions, in pence. This is the figure the other outputs are derived from. E.g. input gross £80k with 10% sacrifice → `7_200_000`. */
  gross: number;
  /** Annual income tax withheld, in pence. E.g. a £30k earner with the default PA pays roughly `348_600` (£3,486). */
  incomeTax: number;
  /** Annual employee National Insurance contributions (Class 1), in pence. E.g. same £30k earner pays roughly `139_440` (£1,394.40) at 8% above PT. */
  nic: number;
  /** Annual student-loan plan 2 repayments, in pence. Zero below the plan 2 threshold. E.g. a £30k earner repays roughly `24_345` (£243.45) at 9% above £27,295. */
  studentLoan: number;
  /** Annual take-home: `gross - incomeTax - nic - studentLoan`, in pence. Does not account for net-pay or relief-at-source pension bookkeeping — those flow through separately on the payslip. */
  net: number;
};

/**
 * UK PAYE-style annual take-home calculator. Simplifications:
 *   - Annual basis, not cumulative per-period. Divide by 12 for a per-month view.
 *   - Personal allowance = basic-rate threshold (the band's lower edge). Tapers by £1 per £2 earned over £100k (standard UK rule).
 *   - Salary sacrifice reduces the base for income tax + NI + student loan.
 *   - Net-pay pension reduces income-tax and student-loan base (NI is unchanged).
 *   - Relief-at-source is ignored at PAYE time (reclaimed separately).
 */
export function computeUKTake({
  gross,
  pension,
  studentLoanPlan2,
  rates,
}: UKTakeInput): UKTake {
  const sac = Math.round(gross * (pension.sacrifice ?? 0));
  const postSacrifice = gross - sac;

  const netPay = Math.round(postSacrifice * pension.netPay);
  const incomeTaxBase = postSacrifice - netPay;
  const studentLoanBase = postSacrifice - netPay;

  const personalAllowance = Math.max(
    0,
    rates.thresholdBasic -
      Math.max(
        0,
        Math.floor((incomeTaxBase - rates.thresholdPersonalAllowanceTaper) / 2),
      ),
  );

  const incomeTax = taxOnIncome(incomeTaxBase, personalAllowance, rates);

  const nic = nicOnEarnings(postSacrifice, rates);

  const studentLoan = studentLoanPlan2
    ? Math.max(
        0,
        Math.round(
          (studentLoanBase - rates.thresholdStudentLoanPlan2) *
            rates.rateStudentLoanPlan2,
        ),
      )
    : 0;

  const net = postSacrifice - incomeTax - nic - studentLoan;
  return { gross: postSacrifice, incomeTax, nic, studentLoan, net };
}

function taxOnIncome(
  taxable: number,
  personalAllowance: number,
  rates: typeof PlanningYearUKTaxRates.$inferSelect,
): number {
  if (taxable <= personalAllowance) return 0;
  const basicTop = rates.thresholdHigher; // top of basic band
  const higherTop = rates.thresholdAdditional; // top of higher band / start of additional
  let remaining = taxable - personalAllowance;
  let tax = 0;

  const basicBandWidth = Math.max(0, basicTop - personalAllowance);
  const inBasic = Math.min(remaining, basicBandWidth);
  tax += inBasic * rates.rateBasic;
  remaining -= inBasic;
  if (remaining <= 0) return Math.round(tax);

  const higherBandWidth = Math.max(0, higherTop - basicTop);
  const inHigher = Math.min(remaining, higherBandWidth);
  tax += inHigher * rates.rateHigher;
  remaining -= inHigher;
  if (remaining <= 0) return Math.round(tax);

  tax += remaining * rates.rateAdditional;
  return Math.round(tax);
}

function nicOnEarnings(
  earnings: number,
  rates: typeof PlanningYearUKTaxRates.$inferSelect,
): number {
  if (earnings <= rates.thresholdNicPrimary) return 0;
  const mainBand = Math.max(
    0,
    Math.min(earnings, rates.thresholdNicUpperEarnings) -
      rates.thresholdNicPrimary,
  );
  const aboveUEL = Math.max(0, earnings - rates.thresholdNicUpperEarnings);
  return Math.round(
    mainBand * rates.rateNicMain + aboveUEL * rates.rateNicAdditional,
  );
}

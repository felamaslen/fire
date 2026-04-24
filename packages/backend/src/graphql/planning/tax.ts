import type { Float } from "grats";

import type { PlanningYearUKTaxRates } from "@/db/schema/planning";

/** UK-specific tax parameters captured on a PlanningYear. Rates are decimals (0–1); thresholds are in fractional units of GBP. @gqlType */
export class PlanningYearTaxRatesUK {
  readonly __typename = "PlanningYearTaxRatesUK" as const;

  row!: typeof PlanningYearUKTaxRates.$inferSelect;

  constructor(row: typeof PlanningYearUKTaxRates.$inferSelect) {
    this.row = row;
  }

  /** @gqlField */ get rateBasic(): Float {
    return this.row.rateBasic;
  }
  /** @gqlField */ get rateHigher(): Float {
    return this.row.rateHigher;
  }
  /** @gqlField */ get rateAdditional(): Float {
    return this.row.rateAdditional;
  }
  /** Top of the basic-rate band, in fractional units of GBP. @gqlField */
  get thresholdBasic(): Float {
    return this.row.thresholdBasic;
  }
  /** Top of the higher-rate band, in fractional units of GBP. @gqlField */
  get thresholdHigher(): Float {
    return this.row.thresholdHigher;
  }
  /** Start of the additional-rate band, in fractional units of GBP. @gqlField */
  get thresholdAdditional(): Float {
    return this.row.thresholdAdditional;
  }
  /** @gqlField */ get rateNicMain(): Float {
    return this.row.rateNicMain;
  }
  /** @gqlField */ get rateNicAdditional(): Float {
    return this.row.rateNicAdditional;
  }
  /** NIC primary threshold, in fractional units of GBP. @gqlField */
  get thresholdNicPrimary(): Float {
    return this.row.thresholdNicPrimary;
  }
  /** NIC upper earnings limit, in fractional units of GBP. @gqlField */
  get thresholdNicUpperEarnings(): Float {
    return this.row.thresholdNicUpperEarnings;
  }
  /** @gqlField */ get rateStudentLoanPlan2(): Float {
    return this.row.rateStudentLoanPlan2;
  }
  /** Student-loan plan 2 threshold, in fractional units of GBP. @gqlField */
  get thresholdStudentLoanPlan2(): Float {
    return this.row.thresholdStudentLoanPlan2;
  }
  /** Income at which the personal allowance begins to taper (£1 of PA withdrawn per £2 earned above this), in fractional units of GBP. @gqlField */
  get thresholdPersonalAllowanceTaper(): Float {
    return this.row.thresholdPersonalAllowanceTaper;
  }
}

/** Country-specific tax parameters captured on a PlanningYear. @gqlUnion */
export type PlanningYearTaxRates = PlanningYearTaxRatesUK;

/** @gqlInput */
export type PlanningYearTaxRatesUKInput = {
  rateBasic: Float;
  rateHigher: Float;
  rateAdditional: Float;
  /** Top of the basic-rate band, in fractional units of GBP. */
  thresholdBasic: Float;
  /** Top of the higher-rate band, in fractional units of GBP. */
  thresholdHigher: Float;
  /** Start of the additional-rate band, in fractional units of GBP. */
  thresholdAdditional: Float;
  rateNicMain: Float;
  rateNicAdditional: Float;
  /** NIC primary threshold, in fractional units of GBP. */
  thresholdNicPrimary: Float;
  /** NIC upper earnings limit, in fractional units of GBP. */
  thresholdNicUpperEarnings: Float;
  rateStudentLoanPlan2: Float;
  /** Student-loan plan 2 threshold, in fractional units of GBP. */
  thresholdStudentLoanPlan2: Float;
  /** Income at which the personal allowance begins to taper, in fractional units of GBP. */
  thresholdPersonalAllowanceTaper: Float;
};

/** Country-specific tax parameter payload. Exactly one variant must be set. @gqlInput */
export type PlanningYearTaxRatesInput = {
  /** UK tax parameters. */
  uk: PlanningYearTaxRatesUKInput;
};

/** Input to `computeUKTake`. All monetary values are annual integers in fractional units of GBP (pence). Pension fractions are decimals in `[0, 1]`. */
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
  /** HMRC tax code in effect for this projection — e.g. `1257L`, `K475`, `0T`, `BR`, `NT`. When null / unset, the year's default personal allowance (`rates.thresholdBasic`) is used with the high-income taper. */
  taxCode?: string | null;
};

/** Output of `computeUKTake`. All values are annual integers in fractional units of GBP (pence). Deductions are returned as positive numbers; callers can render them as negatives. */
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
  /** Annual employee-side pension contribution that's deducted from payroll after `gross` (i.e. `netPay + reliefAtSource`), in pence. Salary sacrifice is intentionally excluded — it's already baked out of `gross`. Exists so the planner can surface a "Pension" deduction line alongside tax / NIC / student-loan. */
  pensionEmployee: number;
};

/**
 * UK PAYE-style annual take-home calculator. Simplifications:
 *   - Annual basis, not cumulative per-period. Divide by 12 for a per-month view.
 *   - Personal allowance = basic-rate threshold (the band's lower edge). Tapers by £1 per £2 earned over £100k (standard UK rule).
 *   - Salary sacrifice reduces the base for income tax + NI + student loan.
 *   - Net-pay pension reduces the income-tax base only — NI and student loan are both computed on post-sacrifice earnings regardless of net-pay contributions (HMRC's SL3 rule: student loan is deducted on NIable pay, not income-taxable pay).
 *   - Relief-at-source is ignored at PAYE time (reclaimed separately).
 */
export function computeUKTake({
  gross,
  pension,
  studentLoanPlan2,
  rates,
  taxCode,
}: UKTakeInput): UKTake {
  const sac = Math.round(gross * (pension.sacrifice ?? 0));
  const postSacrifice = gross - sac;

  const netPay = Math.round(postSacrifice * pension.netPay);
  const reliefAtSource = Math.round(postSacrifice * pension.relief);
  const incomeTaxBase = postSacrifice - netPay;
  // Student loan is deducted on NIable earnings — i.e. post-sacrifice (salary
  // sacrifice reduces NIable pay), but NOT reduced by net-pay or
  // relief-at-source pension contributions. Those only affect income tax.
  const studentLoanBase = postSacrifice;

  const parsed = parseUKTaxCode(taxCode, rates);
  // Fall back to the year's default PA (with the high-income taper) only if
  // no code override applies. Codes already bake the PA into their numeric
  // prefix, so no taper on top of them.
  const personalAllowance =
    parsed.personalAllowance ??
    Math.max(
      0,
      rates.thresholdBasic -
        Math.max(
          0,
          Math.floor(
            (incomeTaxBase - rates.thresholdPersonalAllowanceTaper) / 2,
          ),
        ),
    );

  const incomeTax = parsed.noTax
    ? 0
    : parsed.flatRate != null
      ? Math.round(Math.max(0, incomeTaxBase) * parsed.flatRate)
      : taxOnIncome(incomeTaxBase, personalAllowance, rates);

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
  return {
    gross: postSacrifice,
    incomeTax,
    nic,
    studentLoan,
    net,
    pensionEmployee: netPay + reliefAtSource,
  };
}

/**
 * Interpret an HMRC tax code into a `{ personalAllowance, flatRate, noTax }` triple the main calculator can consume. Supports the most common forms:
 *
 * - `NNNN[LMN]` — personal allowance = prefix × 10 GBP (e.g. `1257L` → £12,570).
 * - `K<N>` — negative personal allowance = −(N × 10) GBP (untaxed income adjustment).
 * - `0T` — zero personal allowance, standard bands.
 * - `BR` — all income at basic rate, no PA.
 * - `D0` / `D1` — all income at higher / additional rate, no PA.
 * - `NT` — no tax at all.
 *
 * Anything else (or a blank code) returns `{ personalAllowance: null }` so the caller falls back to the year's default with taper.
 */
export function parseUKTaxCode(
  code: string | null | undefined,
  rates: typeof PlanningYearUKTaxRates.$inferSelect,
): {
  /** Personal allowance in pence, or null to keep the caller's default. */
  personalAllowance: number | null;
  /** If set, apply a single flat rate to the whole taxable base. */
  flatRate: number | null;
  /** If true, income tax is zero regardless of base. */
  noTax: boolean;
} {
  if (!code) {
    return { personalAllowance: null, flatRate: null, noTax: false };
  }
  const normalised = code.trim().toUpperCase();
  if (normalised === "NT") {
    return { personalAllowance: 0, flatRate: null, noTax: true };
  }
  if (normalised === "0T") {
    return { personalAllowance: 0, flatRate: null, noTax: false };
  }
  if (normalised === "BR") {
    return { personalAllowance: 0, flatRate: rates.rateBasic, noTax: false };
  }
  if (normalised === "D0") {
    return { personalAllowance: 0, flatRate: rates.rateHigher, noTax: false };
  }
  if (normalised === "D1") {
    return {
      personalAllowance: 0,
      flatRate: rates.rateAdditional,
      noTax: false,
    };
  }
  const lmn = /^(\d+)[LMN]$/.exec(normalised);
  if (lmn) {
    // Prefix × 10 GBP → × 1000 pence.
    return {
      personalAllowance: Number(lmn[1]) * 1000,
      flatRate: null,
      noTax: false,
    };
  }
  const k = /^K(\d+)$/.exec(normalised);
  if (k) {
    return {
      personalAllowance: -Number(k[1]) * 1000,
      flatRate: null,
      noTax: false,
    };
  }
  return { personalAllowance: null, flatRate: null, noTax: false };
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

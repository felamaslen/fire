/**
 * Build a `ForecastInputs` snapshot from the live database for the forecast engine. Non-home-currency rows are filtered out — cross-currency handling is out of scope for the MVP.
 */

import { addMonths, startOfMonth } from "date-fns";
import { and, desc, eq, gte, isNotNull, isNull, lte, or } from "drizzle-orm";

import { HOME_CURRENCY } from "@/config";
import { db } from "@/db";
import { model } from "@/db/drizzle-model";
import {
  NetWorthCategoryAssets,
  NetWorthCategoryLiabilities,
  NetWorthCategoryOptions,
  NetWorthCurrencyRates,
  NetWorthEntries,
  NetWorthValueAmounts,
  NetWorthValues,
} from "@/db/schema/net-worth";
import {
  PlanningBills,
  PlanningEarnings,
  PlanningEarningsUKTaxCodes,
  PlanningPayslipAdjustments,
  PlanningPayslips,
  PlanningTransactions,
  PlanningYearUKTaxRates,
} from "@/db/schema/planning";

import type { Context } from "../graphql/context";
import { computePortfolioXirr } from "../graphql/investments/portfolio-xirr";
import {
  buildRateToHome,
  convertToHomeMinor,
} from "../graphql/net-worth/index";
import { computeUKTake } from "../graphql/planning/tax";
import { type ForecastCategory, type ForecastInputs } from "./engine";
import {
  creditCardEwmaSpend,
  ewmaMonthlyContribution,
  type LiabilityBill,
  type LiabilityTx,
} from "./growth";

/** Lookback window for planning transactions / investment transactions feeding the EWMAs. */
const EWMA_LOOKBACK_MONTHS = 36;

/**
 * Load everything `runForecast` needs for a projection starting at the calendar month containing `asOfDate` and running `months` months forward. Rows in non-home currencies are skipped.
 */
export async function loadForecastInputs(
  ctx: Context,
  asOfDate: Date,
  months: number,
): Promise<ForecastInputs> {
  const asOfMonthStart = startOfMonth(asOfDate);
  const ewmaCutoff = addMonths(asOfMonthStart, -EWMA_LOOKBACK_MONTHS);

  const [
    categories,
    { startingBalance },
    liabilityTxs,
    loanBills,
    loanPayslipAdjustments,
    contributionRows,
    creditCardTxs,
    nonLiabilityBills,
    settingsRow,
    earningsSql,
  ] = await Promise.all([
    loadCategories(),
    loadStartingBalances(),
    loadLoanTxs(ewmaCutoff),
    loadLoanBills(),
    loadLoanPayslipAdjustments(ewmaCutoff),
    loadPortfolioContributionRows(ewmaCutoff),
    loadCreditCardTxs(ewmaCutoff),
    loadNonLiabilityBills(asOfDate),
    model("AppSettings").findByIdOrNull(true),
    loadPredictedEarningsSql(asOfDate),
  ]);

  // Manual pension contributions (raw user-recorded outflows) need two
  // treatments to account for RAS-style relief:
  //   1. The pension pot grows by 1.25× the outflow — basic-rate relief
  //      HMRC pays directly to the provider.
  //   2. For a 40%/45% earner, the extra relief above basic rate is
  //      reclaimed via self-assessment. We attribute each manual contrib
  //      to the earning whose `toAccountId` matches the tx's `accountId`
  //      (i.e. "<person> paid My pension from the cash account My job salary lands
  //      in"). See `loadPredictedEarningsForecast`.
  const pensionAssetIds = new Set(
    categories
      .filter((c) => c.kind === "asset" && c.assetType === "PENSION")
      .map((c) => c.id),
  );
  const portfolioContributionTxs = new Map<string, LiabilityTx[]>();
  for (const r of contributionRows) {
    const arr = portfolioContributionTxs.get(r.assetId) ?? [];
    // Basic-rate gross-up applies to PENSION wrappers only — stock/ISA
    // contributions aren't relieved.
    const amount = pensionAssetIds.has(r.assetId)
      ? r.amount / (1 - 0.2)
      : r.amount;
    arr.push({ date: r.date, amount });
    portfolioContributionTxs.set(r.assetId, arr);
  }
  const manualPensionContribsByAccount = new Map<string, LiabilityTx[]>();
  for (const r of contributionRows) {
    if (!pensionAssetIds.has(r.assetId)) continue;
    const arr = manualPensionContribsByAccount.get(r.accountId) ?? [];
    arr.push({ date: r.date, amount: r.amount });
    manualPensionContribsByAccount.set(r.accountId, arr);
  }

  const earningsForecast = computePredictedEarningsForecast(
    asOfDate,
    earningsSql,
    manualPensionContribsByAccount,
  );
  const monthlyIncome = earningsForecast.monthlyIncome;

  // Compute XIRR per STOCK / PENSION wrapper using the same shared helper
  // that backs the live `Portfolio.xirr` resolver — same cash flows, same
  // terminal value (today's live-overlaid market value), same terminal
  // date ("now") — so the rate shown in the forecast workings matches the
  // rate shown on the investments page exactly.
  const portfolioCategoryIds = categories
    .filter(
      (c) =>
        c.kind === "asset" &&
        (c.assetType === "STOCK" || c.assetType === "PENSION"),
    )
    .map((c) => c.id);
  const xirrByAsset = new Map<string, number | null>();
  await Promise.all(
    portfolioCategoryIds.map(async (assetId) => {
      const xirr = await computePortfolioXirr(ctx, {
        currency: HOME_CURRENCY,
        assetIds: [assetId],
        investmentIds: null,
        skipLive: true,
      });
      xirrByAsset.set(assetId, xirr);
    }),
  );

  const categoriesWithXirr: ForecastCategory[] = categories.map((c) => {
    if (
      c.kind === "asset" &&
      (c.assetType === "STOCK" || c.assetType === "PENSION")
    ) {
      return { ...c, xirr: xirrByAsset.get(c.id) ?? null };
    }
    return c;
  });

  // Monthly spending baseline: EWMA of credit-card activity across all
  // cards + monthlified non-liability bills. Loan repayments are NOT
  // spending — they reduce liabilities in the engine directly, and the
  // bill-funded portion is deducted from cash post-retirement as a
  // separate line item in `computeCashDrift`.
  let monthlySpending = 0;
  for (const [, txs] of creditCardTxs) {
    monthlySpending += creditCardEwmaSpend(txs, asOfMonthStart);
  }
  for (const b of nonLiabilityBills) {
    monthlySpending += billMonthlyEquivalent(b);
  }

  // Fold predicted pension contributions (from linked earnings) into the
  // per-portfolio contribution map, as synthetic monthly outflows over the
  // last year — the engine's EWMA then picks them up. This deposits
  // salary-sacrifice, net-pay, and relief-at-source (grossed up for HMRC's
  // top-up) into the linked pension asset.
  const pensionAugmentedContributionTxs = augmentPensionContributions(
    portfolioContributionTxs,
    earningsForecast.monthlyPensionByAssetId,
    asOfMonthStart,
  );

  // Same pattern for student-loan deductions: synthesise monthly payslip
  // adjustments against the linked loan liability so the forecast models
  // the loan paying down.
  const loanPayslipAdjustmentsWithStudentLoans = augmentWithSyntheticMonthly(
    loanPayslipAdjustments,
    earningsForecast.monthlyStudentLoanByLiabilityId,
    asOfMonthStart,
  );

  const retirementYear = settingsRow?.retirementYear ?? null;

  return {
    asOfMonthStart,
    months,
    categories: categoriesWithXirr,
    startingBalance,
    liabilityTxs,
    loanBills,
    loanPayslipAdjustments: loanPayslipAdjustmentsWithStudentLoans,
    portfolioContributionTxs: pensionAugmentedContributionTxs,
    retirementYear,
    monthlyIncome,
    monthlySpending,
    annualSelfAssessmentRefund: earningsForecast.annualSelfAssessmentRefund,
  };
}

const augmentPensionContributions = augmentWithSyntheticMonthly;

/**
 * Append synthetic monthly rows (one per month across `EWMA_LOOKBACK_MONTHS`) to the map, keyed by id. Used to turn a predicted monthly amount into EWMA-friendly history so the engine's `ewma` averages to (nearly) the right figure rather than getting diluted against an under-filled window. Sign matches real tx rows (outflows stored negative).
 */
function augmentWithSyntheticMonthly(
  original: Map<string, readonly LiabilityTx[] | LiabilityTx[]>,
  monthlyById: Map<string, number>,
  asOfMonthStart: Date,
): Map<string, LiabilityTx[]> {
  const out = new Map<string, LiabilityTx[]>();
  for (const [id, txs] of original) out.set(id, [...txs]);
  if (monthlyById.size === 0) return out;
  for (const [id, monthly] of monthlyById) {
    if (monthly <= 0) continue;
    const synthetic: LiabilityTx[] = [];
    for (let i = 1; i <= EWMA_LOOKBACK_MONTHS; i++) {
      synthetic.push({ date: addMonths(asOfMonthStart, -i), amount: -monthly });
    }
    out.set(id, [...(out.get(id) ?? []), ...synthetic]);
  }
  return out;
}

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

// ============================================================
// Individual loaders
// ============================================================

async function loadCategories(): Promise<ForecastCategory[]> {
  const [assets, liabilities, options] = await Promise.all([
    db.select().from(NetWorthCategoryAssets),
    db.select().from(NetWorthCategoryLiabilities),
    db.select().from(NetWorthCategoryOptions),
  ]);
  const out: ForecastCategory[] = [];
  for (const a of assets) {
    out.push({
      id: a.id,
      kind: "asset",
      assetType: a.type,
      growthRate: a.growthRate === null ? null : Number(a.growthRate),
      accessibleFrom: a.accessibleFrom,
    });
  }
  for (const l of liabilities) {
    out.push({
      id: l.id,
      kind: "liability",
      liabilityType: l.type,
      interestRate: l.interestRate === null ? null : Number(l.interestRate),
      skip: l.skip,
    });
  }
  for (const o of options) {
    out.push({ id: o.id, kind: "option" });
  }
  return out;
}

async function loadStartingBalances(): Promise<{
  startingBalance: Map<string, number>;
  latestEntryDate: Date | null;
}> {
  const [latest] = await db
    .select()
    .from(NetWorthEntries)
    .orderBy(desc(NetWorthEntries.date), desc(NetWorthEntries.id))
    .limit(1);
  const startingBalance = new Map<string, number>();
  if (!latest) return { startingBalance, latestEntryDate: null };

  const [rates, values] = await Promise.all([
    db
      .select()
      .from(NetWorthCurrencyRates)
      .where(eq(NetWorthCurrencyRates.entryId, latest.id)),
    db
      .select({
        categoryAssetId: NetWorthValues.categoryAssetId,
        categoryLiabilityId: NetWorthValues.categoryLiabilityId,
        categoryOptionId: NetWorthValues.categoryOptionId,
        amount: NetWorthValueAmounts.amount,
        currency: NetWorthValueAmounts.currency,
      })
      .from(NetWorthValues)
      .leftJoin(
        NetWorthValueAmounts,
        eq(NetWorthValueAmounts.valueId, NetWorthValues.id),
      )
      .where(eq(NetWorthValues.entryId, latest.id)),
  ]);
  const rateMap = buildRateToHome(rates);
  for (const v of values) {
    if (v.amount == null || v.currency == null) continue;
    const homeMinor = convertToHomeMinor(v.amount, v.currency, rateMap);
    const categoryId =
      v.categoryAssetId ?? v.categoryLiabilityId ?? v.categoryOptionId;
    if (!categoryId) continue;
    // Liabilities are stored signed — normally negative. We want the
    // starting *magnitude* so `projectLoanBalance` treats it as debt
    // to pay down rather than negative assets.
    const add = v.categoryLiabilityId ? Math.abs(homeMinor) : homeMinor;
    startingBalance.set(
      categoryId,
      (startingBalance.get(categoryId) ?? 0) + add,
    );
  }
  return { startingBalance, latestEntryDate: latest.date };
}

async function loadLoanTxs(cutoff: Date): Promise<Map<string, LiabilityTx[]>> {
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
        eq(NetWorthCategoryLiabilities.type, "LOAN"),
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

async function loadLoanBills(): Promise<Map<string, LiabilityBill[]>> {
  const rows = await db
    .select({
      liabilityId: PlanningBills.liabilityId,
      start: PlanningBills.start,
      end: PlanningBills.end,
      frequency: PlanningBills.frequency,
      collectionDate: PlanningBills.collectionDate,
      amount: PlanningBills.amount,
    })
    .from(PlanningBills)
    .innerJoin(
      NetWorthCategoryLiabilities,
      eq(NetWorthCategoryLiabilities.id, PlanningBills.liabilityId),
    )
    .where(
      and(
        eq(NetWorthCategoryLiabilities.type, "LOAN"),
        eq(PlanningBills.currency, HOME_CURRENCY),
      ),
    );
  const out = new Map<string, LiabilityBill[]>();
  for (const r of rows) {
    if (!r.liabilityId) continue;
    const arr = out.get(r.liabilityId) ?? [];
    arr.push({
      start: r.start,
      end: r.end,
      frequency: r.frequency,
      collectionDate: r.collectionDate,
      amount: r.amount,
    });
    out.set(r.liabilityId, arr);
  }
  return out;
}

/** Raw per-row contribution transactions — `PlanningTransactions` with an `assetId` set. Each row is a cash outflow from `accountId` into the wrapper's investments. The caller groups these by `assetId` (for per-wrapper EWMA) and by `accountId` (for per-payer pension-relief attribution). */
type PortfolioContributionRow = {
  assetId: string;
  accountId: string;
  date: Date;
  amount: number;
};

async function loadPortfolioContributionRows(
  cutoff: Date,
): Promise<PortfolioContributionRow[]> {
  const rows = await db
    .select({
      assetId: PlanningTransactions.assetId,
      accountId: PlanningTransactions.accountId,
      date: PlanningTransactions.date,
      amount: PlanningTransactions.amount,
    })
    .from(PlanningTransactions)
    .where(
      and(
        isNotNull(PlanningTransactions.assetId),
        gte(PlanningTransactions.date, cutoff),
        eq(PlanningTransactions.currency, HOME_CURRENCY),
      ),
    );
  const out: PortfolioContributionRow[] = [];
  for (const r of rows) {
    if (!r.assetId) continue;
    out.push({
      assetId: r.assetId,
      accountId: r.accountId,
      date: r.date,
      amount: r.amount,
    });
  }
  return out;
}

async function loadLoanPayslipAdjustments(
  cutoff: Date,
): Promise<Map<string, LiabilityTx[]>> {
  const rows = await db
    .select({
      liabilityId: PlanningPayslipAdjustments.liabilityId,
      date: PlanningPayslips.date,
      amount: PlanningPayslipAdjustments.amount,
      currency: PlanningPayslips.currency,
    })
    .from(PlanningPayslipAdjustments)
    .innerJoin(
      PlanningPayslips,
      eq(PlanningPayslips.id, PlanningPayslipAdjustments.payslipId),
    )
    .innerJoin(
      NetWorthCategoryLiabilities,
      eq(
        NetWorthCategoryLiabilities.id,
        PlanningPayslipAdjustments.liabilityId,
      ),
    )
    .where(
      and(
        isNotNull(PlanningPayslipAdjustments.liabilityId),
        eq(NetWorthCategoryLiabilities.type, "LOAN"),
        gte(PlanningPayslips.date, cutoff),
        eq(PlanningPayslips.currency, HOME_CURRENCY),
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
  return db
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
}

type PredictedEarningsForecast = {
  /** Monthly net income landing in cash accounts, summed across all active earnings. Excludes the annual self-assessment refund (see `annualSelfAssessmentRefund`). */
  monthlyIncome: number;
  /** Monthly pension contribution into a specific pension asset (`NetWorthCategoryAsset` of type `PENSION`), by asset id. Grossed up to include HMRC relief-at-source top-up. */
  monthlyPensionByAssetId: Map<string, number>;
  /** Monthly student-loan payroll deduction paid against a specific loan liability (`NetWorthCategoryLiability`), by liability id. Synthesised from the earning's tax calc; only populated for earnings with `studentLoanPlan2 = true` and a linked `studentLoanLiabilityId`. */
  monthlyStudentLoanByLiabilityId: Map<string, number>;
  /** Annual higher/additional-rate pension-relief refund claimed via self-assessment, summed across all active earnings. Lands as a lump sum on each 12-month anniversary pre-retirement. */
  annualSelfAssessmentRefund: number;
};

type PredictedEarningsSql = {
  earningRows: {
    earning: typeof PlanningEarnings.$inferSelect;
    taxCode: typeof PlanningEarningsUKTaxCodes.$inferSelect | null;
  }[];
  rates: typeof PlanningYearUKTaxRates.$inferSelect | null;
};

/** Pure SQL fetch for `computePredictedEarningsForecast` — the active `PlanningEarnings` (with tax codes left-joined) plus the UK FY rates row covering `asOfDate`. Hoisted so the two queries can fire in parallel with the rest of `loadForecastInputs`'s main batch. */
async function loadPredictedEarningsSql(
  asOfDate: Date,
): Promise<PredictedEarningsSql> {
  // UK financial year starts 6 April; at the schema level we identify years
  // by the calendar year they start in (FY25/26 → 2025).
  const fyYear =
    asOfDate.getUTCMonth() > 3 ||
    (asOfDate.getUTCMonth() === 3 && asOfDate.getUTCDate() >= 6)
      ? asOfDate.getUTCFullYear()
      : asOfDate.getUTCFullYear() - 1;

  const [earningRows, rates] = await Promise.all([
    db
      .select({
        earning: PlanningEarnings,
        taxCode: PlanningEarningsUKTaxCodes,
      })
      .from(PlanningEarnings)
      .leftJoin(
        PlanningEarningsUKTaxCodes,
        eq(PlanningEarningsUKTaxCodes.earningsId, PlanningEarnings.id),
      )
      .where(
        and(
          lte(PlanningEarnings.start, asOfDate),
          or(isNull(PlanningEarnings.end), gte(PlanningEarnings.end, asOfDate)),
          eq(PlanningEarnings.currency, HOME_CURRENCY),
        ),
      ),
    db
      .select()
      .from(PlanningYearUKTaxRates)
      .where(eq(PlanningYearUKTaxRates.year, fyYear))
      .limit(1)
      .then((rows) => rows[0] ?? null),
  ]);
  return { earningRows, rates };
}

/**
 * Predicted monthly net income + per-asset pension contributions from `PlanningEarnings` active on `asOfDate`. Runs each earning's annual gross through `computeUKTake` (UK PAYE: tax + NI + student loan + pension) using the active tax code and the current UK FY's rates, then divides by 12.
 *
 * An earning's pension fractions are only applied when `pensionAssetId` is set — if the user hasn't linked the earning to a pension asset, we assume the pension contribution stays as take-home cash (since the forecast has no other wrapper to deposit it into, and pretending it vanishes would understate net worth).
 *
 * Pension deposit into the asset includes HMRC's basic-rate top-up for relief-at-source (grossed up by `1 / (1 - rateBasic)`). Salary sacrifice and net-pay amounts are already gross contributions, no additional top-up applies.
 *
 * This is a prediction from the user's configured earnings — not an EWMA of actual payslips, which is unreliable on data where adjustments (tax/NI/pension) aren't populated per row and treating raw gross as net would overstate income.
 */
function computePredictedEarningsForecast(
  asOfDate: Date,
  { earningRows, rates }: PredictedEarningsSql,
  /** Manual (user-recorded) pension contribs routed to a PENSION asset, keyed by the source cash account id. Used to attribute the RAS basic-rate gross-up + self-assessment higher-rate relief to the earning paid into that account. Amounts are raw (negative) cash outflows — the owner's net contribution before HMRC's 25% top-up. */
  manualPensionContribsByAccount: Map<string, readonly LiabilityTx[]>,
): PredictedEarningsForecast {
  const monthlyPensionByAssetId = new Map<string, number>();
  const monthlyStudentLoanByLiabilityId = new Map<string, number>();
  let annualSelfAssessmentRefund = 0;
  if (!rates) {
    return {
      monthlyIncome: 0,
      monthlyPensionByAssetId,
      monthlyStudentLoanByLiabilityId,
      annualSelfAssessmentRefund,
    };
  }

  // Group tax codes by earning. `taxCode` is null for earnings with no
  // codes on file — the left join still returns a row for the earning.
  type EarningRow = typeof PlanningEarnings.$inferSelect;
  type TaxCodeRow = typeof PlanningEarningsUKTaxCodes.$inferSelect;
  const grouped = new Map<
    string,
    { earning: EarningRow; taxCodes: TaxCodeRow[] }
  >();
  for (const row of earningRows) {
    let g = grouped.get(row.earning.id);
    if (!g) {
      g = { earning: row.earning, taxCodes: [] };
      grouped.set(row.earning.id, g);
    }
    if (row.taxCode) g.taxCodes.push(row.taxCode);
  }

  let monthlyIncome = 0;
  for (const { earning, taxCodes } of grouped.values()) {
    if (earning.countryCode !== "GB") continue;
    const sacFrac = earning.pensionSalarySacrifice ?? 0;
    const netPayFrac = earning.pensionNetPay ?? 0;
    const reliefFrac = earning.pensionReliefAtSource ?? 0;
    const take = computeUKTake({
      gross: earning.amountGross,
      pension: {
        sacrifice: earning.pensionSalarySacrifice,
        netPay: netPayFrac,
        relief: reliefFrac,
      },
      studentLoanPlan2: earning.studentLoanPlan2,
      rates,
      taxCode: activeTaxCode(taxCodes, asOfDate),
    });
    // `take.net` is post-tax/NI/student-loan; the employee-side pension
    // contribution (net-pay + relief-at-source) comes out of payroll too,
    // so the amount actually hitting the bank account is `net - pension`.
    // We always deduct the pension from cash income — even when no asset
    // is linked — otherwise pre-retirement cash would be inflated by a
    // phantom amount.
    monthlyIncome += (take.net - take.pensionEmployee) / 12;

    // Only deposit into a pension asset when the earning is linked to
    // one. Without a link the contribution still leaves the bank via
    // payroll but the forecast has nowhere concrete to deposit it — it
    // drops out of the projected net worth. This mirrors how unlinked
    // student-loan deductions are treated (repayment happens but the
    // forecast doesn't show the liability paydown).
    const rasGrossUp = 1 / (1 - rates.rateBasic);
    let rasGrossedUpFromEarning = 0;
    if (earning.pensionAssetId != null) {
      // Contributions into the pension pot per year:
      //   - Salary sacrifice: full sacrifice amount (already gross — paid
      //     by the employer before any tax/NI).
      //   - Net pay: the full netPay deduction (pre-tax from gross).
      //   - Relief at source: the employee's net contribution grossed up
      //     by the basic-rate relief HMRC adds directly to the pot.
      const sac = Math.round(earning.amountGross * sacFrac);
      const postSacrifice = earning.amountGross - sac;
      const netPayAmt = Math.round(postSacrifice * netPayFrac);
      const reliefAmt = Math.round(postSacrifice * reliefFrac);
      rasGrossedUpFromEarning = reliefAmt * rasGrossUp;
      const annualPension = sac + netPayAmt + rasGrossedUpFromEarning;
      const monthly = annualPension / 12;
      const prev = monthlyPensionByAssetId.get(earning.pensionAssetId) ?? 0;
      monthlyPensionByAssetId.set(earning.pensionAssetId, prev + monthly);
    }

    // Manual pension contribs flowing out of this earning's cash
    // account — attributed to this earner for SA-refund purposes. The
    // pot-deposit gross-up already happened in `loadForecastInputs`; here
    // we just need the grossed-up annual figure for the tax calc.
    const manualMonthlyNetContrib = ewmaMonthlyContribution(
      manualPensionContribsByAccount.get(earning.toAccountId) ?? [],
      startOfMonth(asOfDate),
    );
    const manualAnnualRasGrossedUp = manualMonthlyNetContrib * 12 * rasGrossUp;

    // Higher/additional-rate relief is claimed via self-assessment: the
    // basic-rate band is extended by the total grossed-up RAS amount, so
    // income PAYE taxed at 40%/45% is re-taxed at 20%. The refund lands
    // in the earner's bank, so we add it back to take-home. Only RAS
    // drives this — net-pay and salary-sacrifice already give full
    // marginal relief at PAYE time.
    const totalRasGrossedUp =
      rasGrossedUpFromEarning + manualAnnualRasGrossedUp;
    if (totalRasGrossedUp > 0) {
      const takeSa = computeUKTake({
        gross: earning.amountGross,
        pension: {
          sacrifice: earning.pensionSalarySacrifice,
          netPay: netPayFrac,
          relief: reliefFrac,
        },
        studentLoanPlan2: earning.studentLoanPlan2,
        rates,
        taxCode: activeTaxCode(taxCodes, asOfDate),
        rasGrossedUp: totalRasGrossedUp,
      });
      const refund = take.incomeTax - takeSa.incomeTax;
      if (refund > 0) annualSelfAssessmentRefund += refund;
    }

    // Route the predicted student-loan deduction to the linked loan
    // liability so the forecast models the loan paying down. The employee
    // never receives this money (it's deducted from payroll) — `take.net`
    // already excludes it, so no cash adjustment is needed.
    if (earning.studentLoanPlan2 && earning.studentLoanLiabilityId != null) {
      const monthly = take.studentLoan / 12;
      if (monthly > 0) {
        const prev =
          monthlyStudentLoanByLiabilityId.get(earning.studentLoanLiabilityId) ??
          0;
        monthlyStudentLoanByLiabilityId.set(
          earning.studentLoanLiabilityId,
          prev + monthly,
        );
      }
    }
  }
  return {
    monthlyIncome,
    monthlyPensionByAssetId,
    monthlyStudentLoanByLiabilityId,
    annualSelfAssessmentRefund,
  };
}

function activeTaxCode(
  taxCodes: readonly (typeof PlanningEarningsUKTaxCodes.$inferSelect)[],
  asOf: Date,
): string | null {
  const ms = asOf.getTime();
  for (const tc of taxCodes) {
    const s = tc.start.getTime();
    const e = tc.end?.getTime() ?? Number.POSITIVE_INFINITY;
    if (s <= ms && ms <= e) return tc.taxCode;
  }
  return null;
}

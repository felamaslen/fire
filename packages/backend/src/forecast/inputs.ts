/**
 * Build a `ForecastInputs` snapshot from the live database for the forecast engine. Non-home-currency rows are filtered out — cross-currency handling is out of scope for the MVP.
 */

import { addMonths, startOfMonth } from "date-fns";
import { and, desc, eq, gte, isNotNull, isNull, lte, or } from "drizzle-orm";

import { HOME_CURRENCY } from "@/config";
import { db } from "@/db";
import { model } from "@/db/drizzle-model";
import { Investments, InvestmentTransactions } from "@/db/schema/investments";
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

import {
  buildRateToHome,
  convertToHomeMinor,
} from "../graphql/net-worth/index";
import { computeUKTake } from "../graphql/planning/tax";
import { type ForecastCategory, type ForecastInputs } from "./engine";
import {
  creditCardEwmaSpend,
  ewma,
  type InvestmentTx,
  type LiabilityBill,
  type LiabilityTx,
  solveXirr,
} from "./growth";

/** Lookback window for planning transactions / investment transactions feeding the EWMAs. */
const EWMA_LOOKBACK_MONTHS = 36;

/**
 * Load everything `runForecast` needs for a projection starting at the calendar month containing `asOfDate` and running `months` months forward. Rows in non-home currencies are skipped.
 */
export async function loadForecastInputs(
  asOfDate: Date,
  months: number,
): Promise<ForecastInputs> {
  const asOfMonthStart = startOfMonth(asOfDate);
  const ewmaCutoff = addMonths(asOfMonthStart, -EWMA_LOOKBACK_MONTHS);

  const [
    categories,
    { startingBalance, latestEntryDate },
    liabilityTxs,
    loanBills,
    loanPayslipAdjustments,
    { portfolioInvestmentTxs, portfolioAssetIds },
    portfolioContributionTxs,
    creditCardTxs,
    nonLiabilityBills,
    monthlyIncome,
    settingsRow,
  ] = await Promise.all([
    loadCategories(),
    loadStartingBalances(),
    loadLoanTxs(ewmaCutoff),
    loadLoanBills(),
    loadLoanPayslipAdjustments(ewmaCutoff),
    loadPortfolioInvestmentTxs(),
    loadPortfolioContributionTxs(ewmaCutoff),
    loadCreditCardTxs(ewmaCutoff),
    loadNonLiabilityBills(asOfDate),
    loadPredictedMonthlyNetIncome(asOfDate),
    model("AppSettings").findByIdOrNull(true),
  ]);

  // Compute XIRR per STOCK / PENSION wrapper, using that wrapper's
  // starting balance as the terminal flow. We use `latestEntryDate` as
  // the terminal flow's date so XIRR matches what the live
  // `Portfolio.xirr` resolver would produce (it uses "today", but at
  // the snapshot scale a month of drift is negligible).
  const terminalDate = latestEntryDate ?? asOfDate;
  const xirrByAsset = new Map<string, number | null>();
  for (const assetId of portfolioAssetIds) {
    const txs = portfolioInvestmentTxs.get(assetId) ?? [];
    if (txs.length === 0) {
      xirrByAsset.set(assetId, null);
      continue;
    }
    const terminalValue = startingBalance.get(assetId) ?? 0;
    const flows: { date: Date; amount: number }[] = txs.map((t) => ({
      date: t.date,
      amount: -t.units * t.price,
    }));
    if (terminalValue > 0) {
      flows.push({ date: terminalDate, amount: terminalValue });
    }
    xirrByAsset.set(assetId, solveXirr(flows));
  }

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

  // Recover payslip deductions tied to loans that would be fully paid off
  // before retirement — if that deduction disappears, the user would
  // redirect it into ongoing investment contributions. Fold the recovered
  // amount into each portfolio's contribution so the pre-retirement
  // projection reflects the freed-up cash. Post-retirement, contributions
  // stop anyway.
  const retirementYear = settingsRow?.retirementYear ?? null;
  const augmentedPortfolioContributionTxs = retirementYear
    ? augmentPortfolioContributionsWithRecoveredDeductions(
        portfolioContributionTxs,
        loanPayslipAdjustments,
        categoriesWithXirr,
        startingBalance,
        asOfMonthStart,
        retirementYear,
      )
    : portfolioContributionTxs;

  return {
    asOfMonthStart,
    months,
    categories: categoriesWithXirr,
    startingBalance,
    liabilityTxs,
    loanBills,
    loanPayslipAdjustments,
    portfolioContributionTxs: augmentedPortfolioContributionTxs,
    retirementYear,
    monthlyIncome,
    monthlySpending,
  };
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

/**
 * When a payslip-funded loan will be paid off before the retirement year, recover its EWMA deduction and fold it into every portfolio's contribution stream as an extra synthetic tx per month. Splits evenly across portfolios so the math stays simple. If there are no portfolios the recovery is dropped — there's nowhere sensible for it to land.
 */
function augmentPortfolioContributionsWithRecoveredDeductions(
  original: Map<string, LiabilityTx[]>,
  loanPayslipAdjustments: Map<string, readonly LiabilityTx[]>,
  categories: readonly ForecastCategory[],
  startingBalance: Map<string, number>,
  asOfMonthStart: Date,
  retirementYear: number,
): Map<string, LiabilityTx[]> {
  const portfolioIds = categories
    .filter(
      (c) =>
        c.kind === "asset" &&
        (c.assetType === "STOCK" || c.assetType === "PENSION"),
    )
    .map((c) => c.id);
  if (portfolioIds.length === 0) return original;

  const monthsToRetirement =
    (retirementYear - asOfMonthStart.getUTCFullYear()) * 12 -
    asOfMonthStart.getUTCMonth();
  if (monthsToRetirement <= 0) return original;

  let recovered = 0;
  for (const cat of categories) {
    if (cat.kind !== "liability" || cat.liabilityType !== "LOAN") continue;
    const adjustments = loanPayslipAdjustments.get(cat.id);
    if (!adjustments || adjustments.length === 0) continue;
    const monthly = recentMonthlyEwma(adjustments, asOfMonthStart, 12);
    if (monthly <= 0) continue;
    const start = startingBalance.get(cat.id) ?? 0;
    // Crude linear payoff estimate — ignores interest. Good enough to
    // decide whether the deduction frees up before retirement.
    const monthsToPayoff = start / monthly;
    if (monthsToPayoff < monthsToRetirement) {
      recovered += monthly;
    }
  }
  if (recovered <= 0) return original;

  const perPortfolio = recovered / portfolioIds.length;
  // Emit a year's worth of synthetic outflows so the contribution EWMA
  // picks up the recovered amount rather than diluting across zero-months.
  const syntheticTxs: LiabilityTx[] = [];
  for (let i = 1; i <= 12; i++) {
    syntheticTxs.push({
      date: addMonths(asOfMonthStart, -i),
      amount: -perPortfolio,
    });
  }

  const out = new Map<string, LiabilityTx[]>();
  for (const [id, txs] of original) out.set(id, [...txs]);
  for (const id of portfolioIds) {
    const existing = out.get(id) ?? [];
    out.set(id, [...existing, ...syntheticTxs]);
  }
  return out;
}

function recentMonthlyEwma(
  txs: readonly LiabilityTx[],
  asOfMonthStart: Date,
  windowMonths: number,
): number {
  const samples: number[] = [];
  for (let i = 1; i <= windowMonths; i++) {
    const m = addMonths(asOfMonthStart, -i);
    const next = addMonths(m, 1);
    let sum = 0;
    for (const t of txs) {
      if (t.date >= m && t.date < next) sum += Math.abs(t.amount);
    }
    samples.push(sum);
  }
  return ewma(samples);
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

/** Per-wrapper investment transactions — used to compute each portfolio's XIRR. `units * price` gives the flow for the XIRR solver; we don't use these rows for the forward contribution EWMA (see `loadPortfolioContributionTxs`). No time cutoff: XIRR needs the full tx history so the rate accounts for long-held buys, not just recent activity against a large terminal balance. */
async function loadPortfolioInvestmentTxs(): Promise<{
  portfolioInvestmentTxs: Map<string, InvestmentTx[]>;
  portfolioAssetIds: string[];
}> {
  const rows = await db
    .select({
      assetId: InvestmentTransactions.assetId,
      date: InvestmentTransactions.date,
      units: InvestmentTransactions.units,
      price: InvestmentTransactions.price,
    })
    .from(InvestmentTransactions)
    .innerJoin(
      Investments,
      eq(Investments.id, InvestmentTransactions.investmentId),
    )
    .where(eq(InvestmentTransactions.currency, HOME_CURRENCY));
  const out = new Map<string, InvestmentTx[]>();
  for (const r of rows) {
    const arr = out.get(r.assetId) ?? [];
    arr.push({ date: r.date, units: r.units, price: r.price });
    out.set(r.assetId, arr);
  }
  return {
    portfolioInvestmentTxs: out,
    portfolioAssetIds: [...out.keys()],
  };
}

/** Per-wrapper contribution transactions — `PlanningTransactions` with an `assetId` set. Each row is a cash outflow from a planning account into the wrapper's investments; the forecast EWMAs `|amount|` per month to project ongoing contributions. */
async function loadPortfolioContributionTxs(
  cutoff: Date,
): Promise<Map<string, LiabilityTx[]>> {
  const rows = await db
    .select({
      assetId: PlanningTransactions.assetId,
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
  const out = new Map<string, LiabilityTx[]>();
  for (const r of rows) {
    if (!r.assetId) continue;
    const arr = out.get(r.assetId) ?? [];
    arr.push({ date: r.date, amount: r.amount });
    out.set(r.assetId, arr);
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

/**
 * Predicted monthly net income from `PlanningEarnings` active on `asOfDate`, summed across streams. Runs each earning's annual gross through `computeUKTake` (UK PAYE: tax + NI + student loan + pension) using the active tax code and the current UK FY's rates, then divides by 12.
 *
 * This is a prediction from the user's configured earnings — not an EWMA of actual payslips, which is unreliable on data where adjustments (tax/NI/pension) aren't populated per row and treating raw gross as net would overstate income.
 */
async function loadPredictedMonthlyNetIncome(asOfDate: Date): Promise<number> {
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
  if (!rates) return 0;

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

  let monthly = 0;
  for (const { earning, taxCodes } of grouped.values()) {
    if (earning.countryCode !== "GB") continue;
    const take = computeUKTake({
      gross: earning.amountGross,
      pension: {
        sacrifice: earning.pensionSalarySacrifice,
        netPay: earning.pensionNetPay ?? 0,
        relief: earning.pensionReliefAtSource ?? 0,
      },
      studentLoanPlan2: earning.studentLoanPlan2,
      rates,
      taxCode: activeTaxCode(taxCodes, asOfDate),
    });
    // `take.net` is post-tax/NI/student-loan; the employee-side pension
    // contribution (net-pay + relief-at-source) comes out of payroll too,
    // so the amount actually hitting the bank account is `net - pension`.
    monthly += (take.net - take.pensionEmployee) / 12;
  }
  return monthly;
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

/**
 * Build a `ForecastInputs` snapshot from the live database for the forecast engine. Non-home-currency rows are filtered out — cross-currency handling is out of scope for the MVP.
 */

import { addMonths, startOfMonth } from "date-fns";
import { and, desc, eq, gte, inArray, isNotNull, isNull } from "drizzle-orm";

import { HOME_CURRENCY } from "@/config";
import { db } from "@/db";
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
  PlanningAccounts,
  PlanningBills,
  PlanningPayslipAdjustments,
  PlanningPayslips,
  PlanningTransactions,
} from "@/db/schema/planning";

import {
  buildRateToHome,
  convertToHomeMinor,
} from "../graphql/net-worth/index";
import { type ForecastCategory, type ForecastInputs } from "./engine";
import {
  type InvestmentTx,
  type LiabilityBill,
  type LiabilityTx,
  type Payslip,
  solveXirr,
} from "./growth";

/** Lookback window for planning transactions / investment transactions / payslips feeding the EWMAs. */
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
    nonLiabilityBills,
    { portfolioTxs, portfolioAssetIds },
    payslips,
    accountIds,
  ] = await Promise.all([
    loadCategories(),
    loadStartingBalances(),
    loadLiabilityTxs(ewmaCutoff),
    loadLoanBills(),
    loadNonLiabilityBills(),
    loadPortfolioTxs(ewmaCutoff),
    loadPayslips(ewmaCutoff),
    loadAccountIds(),
  ]);

  // Compute XIRR per STOCK / PENSION wrapper, using that wrapper's
  // starting balance as the terminal flow. We use `latestEntryDate` as
  // the terminal flow's date so XIRR matches what the live
  // `Portfolio.xirr` resolver would produce (it uses "today", but at
  // the snapshot scale a month of drift is negligible).
  const terminalDate = latestEntryDate ?? asOfDate;
  const xirrByAsset = new Map<string, number | null>();
  for (const assetId of portfolioAssetIds) {
    const txs = portfolioTxs.get(assetId) ?? [];
    if (txs.length === 0) {
      xirrByAsset.set(assetId, null);
      continue;
    }
    const terminalValue = (startingBalance.get(assetId) ?? 0) / 100;
    const flows: { date: Date; amount: number }[] = txs.map((t) => ({
      date: t.date,
      amount: -t.units * t.price,
    }));
    if (terminalValue > 0) {
      flows.push({ date: terminalDate, amount: terminalValue });
    }
    xirrByAsset.set(assetId, solveXirr(flows));
  }

  // Attach xirr to the relevant categories.
  const categoriesWithXirr: ForecastCategory[] = categories.map((c) => {
    if (
      c.kind === "asset" &&
      (c.assetType === "STOCK" || c.assetType === "PENSION")
    ) {
      return { ...c, xirr: xirrByAsset.get(c.id) ?? null };
    }
    return c;
  });

  return {
    asOfMonthStart,
    months,
    categories: categoriesWithXirr,
    startingBalance,
    liabilityTxs,
    loanBills,
    portfolioTxs,
    payslips,
    accountIds,
    nonLiabilityBills,
  };
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
    // starting *magnitude* so the engine's projectLoanBalance /
    // projectCreditCardBalance treat it as debt to pay down rather
    // than negative assets.
    const add = v.categoryLiabilityId ? Math.abs(homeMinor) : homeMinor;
    startingBalance.set(
      categoryId,
      (startingBalance.get(categoryId) ?? 0) + add,
    );
  }
  return { startingBalance, latestEntryDate: latest.date };
}

async function loadLiabilityTxs(
  cutoff: Date,
): Promise<Map<string, LiabilityTx[]>> {
  const rows = await db
    .select({
      liabilityId: PlanningTransactions.liabilityId,
      date: PlanningTransactions.date,
      amount: PlanningTransactions.amount,
    })
    .from(PlanningTransactions)
    .where(
      and(
        isNotNull(PlanningTransactions.liabilityId),
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

async function loadNonLiabilityBills(): Promise<LiabilityBill[]> {
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
      ),
    );
  return rows;
}

async function loadPortfolioTxs(cutoff: Date): Promise<{
  portfolioTxs: Map<string, InvestmentTx[]>;
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
    .where(
      and(
        gte(InvestmentTransactions.date, cutoff),
        eq(InvestmentTransactions.currency, HOME_CURRENCY),
      ),
    );
  const out = new Map<string, InvestmentTx[]>();
  for (const r of rows) {
    const arr = out.get(r.assetId) ?? [];
    arr.push({ date: r.date, units: r.units, price: r.price });
    out.set(r.assetId, arr);
  }
  return {
    portfolioTxs: out,
    portfolioAssetIds: [...out.keys()],
  };
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

/**
 * `Query.netWorthCurrent` — predicted net worth at "today", derived from the latest recorded `NetWorthEntries` snapshot by replaying actual / forecast cash flows between the entry's date and today, applying cached close-price growth to held investments, and accruing daily interest on loans. Never triggers a live price refetch — `priceLatest` comes from the most recent `InvestmentPrices` row.
 *
 * Returns `null` when an entry already exists in the current calendar month (the user has snapshotted today, no prediction needed) or when there is no prior entry to roll forward from.
 */

import {
  addDays,
  addMonths,
  differenceInCalendarDays,
  isAfter,
  startOfDay,
  startOfMonth,
} from "date-fns";
import {
  and,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";

import { HOME_CURRENCY } from "@/config";
import { db } from "@/db";
import {
  InvestmentPrices,
  Investments,
  InvestmentTransactions,
} from "@/db/schema/investments";
import {
  NetWorthCategoryAssets,
  NetWorthCategoryLiabilities,
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
import { creditCardEwmaSpend } from "@/forecast/growth";

import type { Context } from "../context";
import type { Date as CalendarDate } from "../date";
import { Money } from "../money";
import { collectionDayInMonth } from "../planning/balance";
import { computeUKTake } from "../planning/tax";
import type { NetWorthAssetType } from "./categories";
import type { NetWorthHistoryAssetBucket } from "./history";
import { buildRateToHome, convertToHomeMinor } from "./index";

const EWMA_LOOKBACK_MONTHS = 36;

/** A single line in the breakdown of the change between the previous net-worth snapshot and the predicted current value — e.g. "Income: +£1,200", "Loan interest: -£42". Positive means the line increased net worth, negative means it decreased it. @gqlType */
export type NetWorthCurrentBreakdown = {
  /** Human-readable label naming the source of the change. @gqlField */
  label: string;
  /** Signed amount in the home currency. @gqlField */
  amount: Money;
};

/** Predicted net worth at "today" — same shape as a `NetWorthHistoryPoint`, plus a `breakdown` of where the change from the previous snapshot came from (income, bills, investment growth, loan interest, etc.). @gqlType */
export type NetWorthCurrent = {
  /** @gqlField */
  date: CalendarDate;
  /** Gross assets at this point, grouped by asset type. @gqlField */
  assetsByType: NetWorthHistoryAssetBucket[];
  /** Gross assets total, in the home currency. @gqlField */
  assets: Money;
  /** Total liabilities (positive magnitude), in the home currency. @gqlField */
  liabilities: Money;
  /** Net worth: `assets − liabilities`. @gqlField */
  net: Money;
  /** Per-source signed contributions to the change between the previous snapshot and the predicted current value. The sum is approximately the net delta (off-by-zero contributions from washes such as cash → wrapper transfers and loan repayments are intentionally not surfaced). @gqlField */
  breakdown: NetWorthCurrentBreakdown[];
};

/**
 * Predicted net worth at "today" — the latest `NetWorthEntries` rolled forward to today by replaying actual / forecast cash flows, applying cached close-price growth to held investments, and accruing daily interest on loans. Never triggers a live price refetch.
 *
 * Returns `null` when an entry already exists in the current calendar month or when there is no prior entry to roll forward from.
 *
 * @gqlQueryField
 */
export async function netWorthCurrent(
  _ctx: Context,
): Promise<NetWorthCurrent | null> {
  const today = startOfDay(new Date());
  const monthStart = startOfMonth(today);
  const nextMonthStart = startOfMonth(addMonths(today, 1));

  const [existingThisMonth] = await db
    .select({ id: NetWorthEntries.id })
    .from(NetWorthEntries)
    .where(
      and(
        gte(NetWorthEntries.date, monthStart),
        lt(NetWorthEntries.date, nextMonthStart),
      ),
    )
    .limit(1);
  if (existingThisMonth) return null;

  const [prevEntry] = await db
    .select()
    .from(NetWorthEntries)
    .where(lt(NetWorthEntries.date, monthStart))
    .orderBy(desc(NetWorthEntries.date), desc(NetWorthEntries.id))
    .limit(1);
  if (!prevEntry) return null;
  const dE = startOfDay(prevEntry.date);

  const [assetCats, liabCats] = await Promise.all([
    db.select().from(NetWorthCategoryAssets),
    db.select().from(NetWorthCategoryLiabilities),
  ]);
  const assetCatById = new Map(assetCats.map((c) => [c.id, c]));
  const liabCatById = new Map(liabCats.map((c) => [c.id, c]));

  const { assetBalances, liabilityBalances, optionBalances } =
    await loadStartingBalances(prevEntry.id);

  const cashDelta = new Map<string, number>();
  const liabilityDelta = new Map<string, number>();
  const stockDelta = new Map<string, number>();
  const breakdown = new Map<string, number>();
  const addCash = (id: string, n: number) =>
    cashDelta.set(id, (cashDelta.get(id) ?? 0) + n);
  const addLiab = (id: string, n: number) =>
    liabilityDelta.set(id, (liabilityDelta.get(id) ?? 0) + n);
  const addStock = (id: string, n: number) =>
    stockDelta.set(id, (stockDelta.get(id) ?? 0) + n);
  const addBreakdown = (label: string, n: number) =>
    breakdown.set(label, (breakdown.get(label) ?? 0) + n);

  // Repayment events that drive the loan accrual walk. Bill / payslip /
  // transaction repayments all funnel into one stream, sorted by date.
  type LoanEvent = { date: Date; amount: number };
  const loanEvents = new Map<string, LoanEvent[]>();
  const addLoanEvent = (liabilityId: string, ev: LoanEvent) => {
    const arr = loanEvents.get(liabilityId) ?? [];
    arr.push(ev);
    loanEvents.set(liabilityId, arr);
  };

  // ============================================================
  // Income — payslips first, then earnings fallback.
  // ============================================================
  const payslips = await db
    .select({
      id: PlanningPayslips.id,
      date: PlanningPayslips.date,
      toAccountId: PlanningPayslips.toAccountId,
      amountGross: PlanningPayslips.amountGross,
      currency: PlanningPayslips.currency,
    })
    .from(PlanningPayslips)
    .where(
      and(
        gt(PlanningPayslips.date, dE),
        lte(PlanningPayslips.date, today),
        eq(PlanningPayslips.currency, HOME_CURRENCY),
      ),
    );

  const adjustments =
    payslips.length === 0
      ? []
      : await db
          .select({
            payslipId: PlanningPayslipAdjustments.payslipId,
            amount: PlanningPayslipAdjustments.amount,
            liabilityId: PlanningPayslipAdjustments.liabilityId,
          })
          .from(PlanningPayslipAdjustments)
          .where(
            inArray(
              PlanningPayslipAdjustments.payslipId,
              payslips.map((p) => p.id),
            ),
          );
  const adjsByPayslip = new Map<
    string,
    { amount: number; liabilityId: string | null }[]
  >();
  for (const a of adjustments) {
    const arr = adjsByPayslip.get(a.payslipId) ?? [];
    arr.push({ amount: a.amount, liabilityId: a.liabilityId });
    adjsByPayslip.set(a.payslipId, arr);
  }

  const accountsPaidThisMonth = new Set<string>();
  for (const p of payslips) {
    const adjList = adjsByPayslip.get(p.id) ?? [];
    let net = p.amountGross;
    for (const a of adjList) net += a.amount;
    addCash(p.toAccountId, net);
    addBreakdown("Income", net);
    if (p.date >= monthStart) accountsPaidThisMonth.add(p.toAccountId);
    for (const a of adjList) {
      if (a.liabilityId && a.amount < 0) {
        addLoanEvent(a.liabilityId, {
          date: startOfDay(p.date),
          amount: -a.amount,
        });
      }
    }
  }

  // Income fallback: per cash account with no payslip in the *current* month,
  // look up the most recent payslip ever for that account; if today is at or
  // past that day-of-month within the current month, credit a full month's
  // predicted net (computed from the active GB earnings on this account).
  const earnings = await db
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
        lte(PlanningEarnings.start, today),
        or(isNull(PlanningEarnings.end), gte(PlanningEarnings.end, today)),
        eq(PlanningEarnings.currency, HOME_CURRENCY),
        eq(PlanningEarnings.countryCode, "GB"),
      ),
    );
  const earningsByAccount = new Map<
    string,
    {
      earning: typeof PlanningEarnings.$inferSelect;
      taxCodes: (typeof PlanningEarningsUKTaxCodes.$inferSelect)[];
    }[]
  >();
  for (const r of earnings) {
    let group = earningsByAccount.get(r.earning.toAccountId);
    if (!group) {
      group = [];
      earningsByAccount.set(r.earning.toAccountId, group);
    }
    let bucket = group.find((g) => g.earning.id === r.earning.id);
    if (!bucket) {
      bucket = { earning: r.earning, taxCodes: [] };
      group.push(bucket);
    }
    if (r.taxCode) bucket.taxCodes.push(r.taxCode);
  }

  const accountsNeedingFallback = [...earningsByAccount.keys()].filter(
    (a) => !accountsPaidThisMonth.has(a),
  );

  if (accountsNeedingFallback.length > 0) {
    const fyYear = ukFyYear(today);
    const [taxRates] = await db
      .select()
      .from(PlanningYearUKTaxRates)
      .where(eq(PlanningYearUKTaxRates.year, fyYear))
      .limit(1);
    const lastPayslipPerAccount = await db
      .select({
        toAccountId: PlanningPayslips.toAccountId,
        date: sql<Date>`MAX(${PlanningPayslips.date})`,
      })
      .from(PlanningPayslips)
      .where(inArray(PlanningPayslips.toAccountId, accountsNeedingFallback))
      .groupBy(PlanningPayslips.toAccountId);
    const lastPayDateByAccount = new Map(
      lastPayslipPerAccount.map((r) => [r.toAccountId, new Date(r.date)]),
    );

    if (taxRates) {
      for (const accountId of accountsNeedingFallback) {
        const lastPay = lastPayDateByAccount.get(accountId);
        if (!lastPay) continue; // Never been paid → assume not yet paid.
        const expectedDay = lastPay.getUTCDate();
        const expectedThisMonth = clampDayInMonth(monthStart, expectedDay);
        if (isAfter(expectedThisMonth, today)) continue;
        // Pay day is in (dE, today] for this month — credit predicted net.
        const group = earningsByAccount.get(accountId) ?? [];
        for (const { earning, taxCodes } of group) {
          const take = computeUKTake({
            gross: earning.amountGross,
            pension: {
              sacrifice: earning.pensionSalarySacrifice,
              netPay: earning.pensionNetPay ?? 0,
              relief: earning.pensionReliefAtSource ?? 0,
            },
            studentLoanPlan2: earning.studentLoanPlan2,
            rates: taxRates,
            taxCode: activeTaxCode(taxCodes, today),
          });
          const monthlyNet = Math.round((take.net - take.pensionEmployee) / 12);
          addCash(accountId, monthlyNet);
          addBreakdown("Income", monthlyNet);

          // Linked student-loan deduction reduces the loan balance even
          // when paid via the predicted-net fallback (it never lands in
          // cash — already deducted from take above).
          if (
            earning.studentLoanPlan2 &&
            earning.studentLoanLiabilityId != null &&
            take.studentLoan > 0
          ) {
            addLoanEvent(earning.studentLoanLiabilityId, {
              date: expectedThisMonth,
              amount: Math.round(take.studentLoan / 12),
            });
          }
        }
      }
    }
  }

  // ============================================================
  // Bills — each scheduled occurrence in (dE, today].
  // ============================================================
  const bills = await db
    .select()
    .from(PlanningBills)
    .where(
      and(
        eq(PlanningBills.currency, HOME_CURRENCY),
        lte(PlanningBills.start, today),
        or(isNull(PlanningBills.end), gte(PlanningBills.end, dE)),
      ),
    );
  for (const b of bills) {
    const occurrences = enumerateBillOccurrences(b, dE, today);
    for (const occ of occurrences) {
      addCash(b.fromAccountId, -b.amount);
      const liabCat = b.liabilityId ? liabCatById.get(b.liabilityId) : null;
      if (liabCat?.type === "LOAN") {
        addLoanEvent(b.liabilityId!, { date: occ, amount: b.amount });
      } else if (liabCat?.type === "CREDIT_CARD") {
        // Bill paying a CC is a payoff — surface as CC spending (cash drop,
        // implicit offsetting spend, liability unchanged).
        addBreakdown("Credit-card spending", -b.amount);
      } else {
        addBreakdown("Bills", -b.amount);
      }
    }
  }

  // ============================================================
  // Planning transactions — ad-hoc inflows / outflows, investment outflows,
  // CC payoffs, loan payoffs.
  // ============================================================
  const planningTxs = await db
    .select()
    .from(PlanningTransactions)
    .where(
      and(
        gt(PlanningTransactions.date, dE),
        lte(PlanningTransactions.date, today),
        eq(PlanningTransactions.currency, HOME_CURRENCY),
        eq(PlanningTransactions.isProvisional, false),
      ),
    );
  for (const t of planningTxs) {
    addCash(t.accountId, t.amount);
    if (t.toAccountId && t.amount < 0) {
      addCash(t.toAccountId, -t.amount);
      // Internal transfer — both sides update, net zero net-worth impact.
      continue;
    }
    if (t.assetId) {
      // Cash → wrapper. Cash drops here, wrapper's recorded balance rises by
      // the same magnitude (it's now sitting in wrapper cash). Net zero.
      addStock(t.assetId, -t.amount);
      continue;
    }
    if (t.liabilityId && t.amount < 0) {
      const liabCat = liabCatById.get(t.liabilityId);
      if (liabCat?.type === "LOAN") {
        addLoanEvent(t.liabilityId, {
          date: startOfDay(t.date),
          amount: -t.amount,
        });
        continue; // Loan paydown — net effect surfaced via the loan line.
      }
      if (liabCat?.type === "CREDIT_CARD") {
        // CC payoff: cash drops above; mirror with an equal liability drop
        // so the payment washes net-worth-wise. The implicit CC spending is
        // surfaced separately below from the EWMA prorate.
        addLiab(t.liabilityId, t.amount);
        continue;
      }
    }
    addBreakdown("Other transactions", t.amount);
  }

  // ============================================================
  // CC spending — daily-prorated EWMA of past CC payments. Treats every CC
  // as accruing the typical monthly spend evenly across the days in the
  // window, regardless of whether a payoff transaction lands inside it
  // (payoffs wash above; spending sits on top).
  // ============================================================
  const ccCats = liabCats.filter((c) => c.type === "CREDIT_CARD" && !c.skip);
  const windowDays = Math.max(0, differenceInCalendarDays(today, dE));
  if (ccCats.length > 0 && windowDays > 0) {
    const ewmaCutoff = addMonths(monthStart, -EWMA_LOOKBACK_MONTHS);
    const ccHistory = await db
      .select({
        liabilityId: PlanningTransactions.liabilityId,
        date: PlanningTransactions.date,
        amount: PlanningTransactions.amount,
      })
      .from(PlanningTransactions)
      .where(
        and(
          inArray(
            PlanningTransactions.liabilityId,
            ccCats.map((c) => c.id),
          ),
          gte(PlanningTransactions.date, ewmaCutoff),
          eq(PlanningTransactions.currency, HOME_CURRENCY),
        ),
      );
    const byLiab = new Map<string, { date: Date; amount: number }[]>();
    for (const r of ccHistory) {
      if (!r.liabilityId) continue;
      const arr = byLiab.get(r.liabilityId) ?? [];
      arr.push({ date: r.date, amount: r.amount });
      byLiab.set(r.liabilityId, arr);
    }
    for (const cc of ccCats) {
      const monthly = creditCardEwmaSpend(byLiab.get(cc.id) ?? [], monthStart);
      if (monthly <= 0) continue;
      const prorated = Math.round((monthly / 30) * windowDays);
      addLiab(cc.id, prorated);
      addBreakdown("Credit-card spending", -prorated);
    }
  }

  // ============================================================
  // Loan accrual — daily interest, payments, daily interest again to today.
  // ============================================================
  for (const liab of liabCats) {
    if (liab.type !== "LOAN" || liab.skip) continue;
    const start = liabilityBalances.get(liab.id) ?? 0;
    const annualRate =
      liab.interestRate == null ? 0 : Number(liab.interestRate);
    const dailyRate = annualRate / 100 / 365;
    const events = (loanEvents.get(liab.id) ?? [])
      .slice()
      .sort((a, b) => a.date.getTime() - b.date.getTime());
    let balance = start;
    let cursor = dE;
    for (const ev of events) {
      const days = differenceInCalendarDays(ev.date, cursor);
      if (days > 0 && dailyRate !== 0) {
        balance *= Math.pow(1 + dailyRate, days);
      }
      balance = Math.max(0, balance - ev.amount);
      cursor = ev.date;
    }
    const tailDays = differenceInCalendarDays(today, cursor);
    if (tailDays > 0 && dailyRate !== 0) {
      balance *= Math.pow(1 + dailyRate, tailDays);
    }
    const delta = balance - start;
    addLiab(liab.id, delta);
    // Loan paydown via cash (bills / payslip adjustments / loan-tagged
    // PlanningTransactions) drops cash + drops the liability by the same
    // magnitude — those wash net-worth-wise, so the loan-line surfaces only
    // the residual = accrued interest minus principal repaid. Sign flipped:
    // positive = liability dropped (good); negative = liability grew.
    if (delta !== 0) addBreakdown("Loans", -delta);
  }

  // ============================================================
  // Stock / pension growth — per investment, units held at dE × Δ price.
  // Cached close prices only (no live overlay).
  // ============================================================
  const investments = await db
    .select({
      id: Investments.id,
      currency: Investments.currency,
    })
    .from(Investments)
    .where(eq(Investments.currency, HOME_CURRENCY));
  if (investments.length > 0) {
    const investmentIds = investments.map((i) => i.id);
    const heldRows = await db
      .select({
        investmentId: InvestmentTransactions.investmentId,
        assetId: InvestmentTransactions.assetId,
        units: sql<number>`SUM(${InvestmentTransactions.units})`,
      })
      .from(InvestmentTransactions)
      .where(
        and(
          inArray(InvestmentTransactions.investmentId, investmentIds),
          lte(InvestmentTransactions.date, dE),
        ),
      )
      .groupBy(
        InvestmentTransactions.investmentId,
        InvestmentTransactions.assetId,
      );
    const priceAtPrev = await db
      .select({
        investmentId: InvestmentPrices.investmentId,
        priceAdjusted: InvestmentPrices.priceAdjusted,
        date: sql<Date>`${InvestmentPrices.date}`,
      })
      .from(InvestmentPrices)
      .innerJoin(
        sql<{
          investmentId: string;
          maxDate: Date;
        }>`(
          SELECT "investmentId", MAX("date") AS "maxDate"
          FROM "InvestmentPrices"
          WHERE "investmentId" = ANY (${sql.raw(`ARRAY[${investmentIds.map((id) => `'${id}'::uuid`).join(", ")}]`)})
            AND "date" <= ${dE}
          GROUP BY "investmentId"
        ) AS prev_p`,
        and(
          eq(sql`prev_p."investmentId"`, InvestmentPrices.investmentId),
          eq(sql`prev_p."maxDate"`, InvestmentPrices.date),
        ),
      );
    const prevPriceById = new Map(
      priceAtPrev.map((r) => [r.investmentId, r.priceAdjusted]),
    );

    const latestPrices = await db
      .select({
        investmentId: InvestmentPrices.investmentId,
        priceAdjusted: InvestmentPrices.priceAdjusted,
      })
      .from(InvestmentPrices)
      .where(
        and(
          inArray(InvestmentPrices.investmentId, investmentIds),
          eq(InvestmentPrices.isLatest, true),
        ),
      );
    const latestPriceById = new Map(
      latestPrices.map((r) => [r.investmentId, r.priceAdjusted]),
    );

    for (const h of heldRows) {
      if (!h.units || h.units <= 0) continue;
      const prevPrice = prevPriceById.get(h.investmentId);
      const nowPrice = latestPriceById.get(h.investmentId);
      if (prevPrice == null || nowPrice == null) continue;
      const delta = Math.round((nowPrice - prevPrice) * h.units);
      if (delta === 0) continue;
      addStock(h.assetId, delta);
      const cat = assetCatById.get(h.assetId);
      if (cat?.type === "STOCK") addBreakdown("Stocks", delta);
      else if (cat?.type === "PENSION") addBreakdown("Pension", delta);
    }
  }

  // ============================================================
  // Compose the output point — apply deltas, bucket by asset type.
  // ============================================================
  const finalAsset = new Map<string, number>(assetBalances);
  for (const [id, d] of cashDelta) {
    const cat = assetCatById.get(id);
    if (!cat || cat.type !== "CASH") continue;
    finalAsset.set(id, (finalAsset.get(id) ?? 0) + d);
  }
  for (const [id, d] of stockDelta) {
    const cat = assetCatById.get(id);
    if (!cat) continue;
    finalAsset.set(id, (finalAsset.get(id) ?? 0) + d);
  }
  const finalLiab = new Map<string, number>(liabilityBalances);
  for (const [id, d] of liabilityDelta) {
    finalLiab.set(id, (finalLiab.get(id) ?? 0) + d);
  }

  const byType = new Map<NetWorthAssetType, number>();
  let assetsTotal = 0;
  for (const [id, amt] of finalAsset) {
    const cat = assetCatById.get(id);
    if (!cat) continue;
    byType.set(cat.type, (byType.get(cat.type) ?? 0) + amt);
    assetsTotal += amt;
  }
  for (const [id, amt] of optionBalances) {
    if (!liabCatById.has(id)) {
      // OPTION bucket lives alongside assets in the history shape.
      byType.set("OPTION", (byType.get("OPTION") ?? 0) + amt);
      assetsTotal += amt;
    }
  }
  let liabilitiesTotal = 0;
  for (const [id, amt] of finalLiab) {
    const cat = liabCatById.get(id);
    if (!cat || cat.skip) continue;
    liabilitiesTotal += amt;
  }

  const assetsByType: NetWorthHistoryAssetBucket[] = [...byType.entries()]
    .filter(([, amt]) => amt !== 0)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([type, amt]) => ({
      type,
      amount: Money.fromMinorDenomination(amt, HOME_CURRENCY),
    }));

  const breakdownOrder = [
    "Income",
    "Bills",
    "Credit-card spending",
    "Other transactions",
    "Stocks",
    "Pension",
    "Loans",
  ];
  const breakdownOut: NetWorthCurrentBreakdown[] = breakdownOrder
    .filter((label) => (breakdown.get(label) ?? 0) !== 0)
    .map((label) => ({
      label,
      amount: Money.fromMinorDenomination(
        breakdown.get(label) ?? 0,
        HOME_CURRENCY,
      ),
    }));

  return {
    date: today as CalendarDate,
    assetsByType,
    assets: Money.fromMinorDenomination(assetsTotal, HOME_CURRENCY),
    liabilities: Money.fromMinorDenomination(liabilitiesTotal, HOME_CURRENCY),
    net: Money.fromMinorDenomination(
      assetsTotal - liabilitiesTotal,
      HOME_CURRENCY,
    ),
    breakdown: breakdownOut,
  };
}

async function loadStartingBalances(entryId: string): Promise<{
  assetBalances: Map<string, number>;
  liabilityBalances: Map<string, number>;
  optionBalances: Map<string, number>;
}> {
  const [rateRows, valueRows] = await Promise.all([
    db
      .select()
      .from(NetWorthCurrencyRates)
      .where(eq(NetWorthCurrencyRates.entryId, entryId)),
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
      .where(eq(NetWorthValues.entryId, entryId)),
  ]);
  const rateMap = buildRateToHome(rateRows);
  const assetBalances = new Map<string, number>();
  const liabilityBalances = new Map<string, number>();
  const optionBalances = new Map<string, number>();
  for (const r of valueRows) {
    if (r.amount == null || r.currency == null) continue;
    const homeMinor = convertToHomeMinor(r.amount, r.currency, rateMap);
    if (r.categoryAssetId) {
      assetBalances.set(
        r.categoryAssetId,
        (assetBalances.get(r.categoryAssetId) ?? 0) + homeMinor,
      );
    } else if (r.categoryLiabilityId) {
      liabilityBalances.set(
        r.categoryLiabilityId,
        (liabilityBalances.get(r.categoryLiabilityId) ?? 0) +
          Math.abs(homeMinor),
      );
    } else if (r.categoryOptionId) {
      optionBalances.set(
        r.categoryOptionId,
        (optionBalances.get(r.categoryOptionId) ?? 0) + homeMinor,
      );
    }
  }
  return { assetBalances, liabilityBalances, optionBalances };
}

/**
 * Yield each scheduled collection date for `bill` strictly after `from` and on or before `to`. Collection dates that fall outside the bill's `[start, end]` range are skipped.
 */
function enumerateBillOccurrences(
  bill: typeof PlanningBills.$inferSelect,
  from: Date,
  to: Date,
): Date[] {
  const out: Date[] = [];
  let cursor = startOfMonth(from);
  const endCap = startOfMonth(addMonths(to, 1));
  while (cursor < endCap) {
    const day = collectionDayInMonth(
      bill.frequency,
      bill.collectionDate,
      cursor,
    );
    if (day != null) {
      const occ = clampDayInMonth(cursor, day);
      const inWindow = occ > from && occ <= to;
      const inBillRange =
        occ >= bill.start && (bill.end == null || occ <= bill.end);
      if (inWindow && inBillRange) out.push(occ);
    }
    cursor = addMonths(cursor, 1);
  }
  return out;
}

/** Build a UTC date for `day`-of-month inside `monthStart`, clamped to the month's last day if `day` exceeds it. */
function clampDayInMonth(monthStart: Date, day: number): Date {
  const next = addMonths(monthStart, 1);
  const lastDay = differenceInCalendarDays(next, monthStart);
  const clamped = Math.min(day, lastDay);
  return addDays(monthStart, clamped - 1);
}

function ukFyYear(d: Date): number {
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  if (m > 3 || (m === 3 && day >= 6)) return d.getUTCFullYear();
  return d.getUTCFullYear() - 1;
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

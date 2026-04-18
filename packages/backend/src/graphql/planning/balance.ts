import { strict as assert } from "node:assert";

import { and, desc, eq, gte, inArray, isNull, lt, lte, or } from "drizzle-orm";
import type { ID } from "grats";

import { HOME_CURRENCY } from "@/config";
import { db } from "@/db";
import {
  NetWorthCategoryAssets,
  NetWorthCategoryLiabilities,
  NetWorthEntries,
  NetWorthValueAmounts,
  NetWorthValues,
} from "@/db/schema/net-worth";
import {
  PlanningAccounts,
  PlanningBills,
  PlanningEarnings,
  PlanningEarningsUKTaxCodes,
  PlanningMonthBills,
  PlanningPayslipAdjustments,
  PlanningPayslips,
  PlanningTransactions,
  PlanningYearUKTaxRates,
} from "@/db/schema/planning";
import { UnreachableCaseError } from "@/errors";

import { Money } from "../money";
import { NetWorthCategoryAsset } from "../net-worth/categories";
import type { PlanningTransaction } from "./index";
import {
  addMonthsUTC,
  earningMonthCoverage,
  monthId,
  monthYearLabel,
} from "./months";
import { computeUKTake } from "./tax";
import { encodePlanningTransactionId } from "./transactions";

// TODO: derive per-account currency from the latest NetWorthValueAmount / let callers specify it. For now the planner reports everything in the home currency.
const REPORTING_CURRENCY = HOME_CURRENCY;

type TxRow = typeof PlanningTransactions.$inferSelect;
type PayslipRow = typeof PlanningPayslips.$inferSelect;
type AdjustmentRow = typeof PlanningPayslipAdjustments.$inferSelect;
type EarningRow = typeof PlanningEarnings.$inferSelect;
type TaxCodeRow = typeof PlanningEarningsUKTaxCodes.$inferSelect;
type BillRow = typeof PlanningBills.$inferSelect;
type OverrideRow = typeof PlanningMonthBills.$inferSelect;
type RateRow = typeof PlanningYearUKTaxRates.$inferSelect;

/** Credit-card liability billed from a planning account, with the pre-computed EWMA of its 24 most recent balance snapshots (GBP minor units). */
export type CreditCardPrediction = {
  liabilityId: string;
  name: string;
  billedFromAccountId: string;
  ewmaMinor: number;
};

/** Snapshot of one planning account (PlanningAccounts row joined with the underlying asset). */
export type PlanningAccountInfo = {
  assetId: string;
  alias: string | null;
  asset: NetWorthCategoryAsset;
};

/** Every row needed to render a full planning year — pre-loaded once per PlanningYear so the month × account resolvers can filter in memory without issuing more SQL. */
export type PlanningYearData = {
  year: number;
  accounts: PlanningAccountInfo[];
  transactions: TxRow[];
  payslips: Array<{ payslip: PayslipRow; adjustments: AdjustmentRow[] }>;
  earnings: Array<{ earning: EarningRow; taxCodes: TaxCodeRow[] }>;
  bills: Array<{
    bill: BillRow;
    overridesByMonthStartIso: Map<string, OverrideRow>;
  }>;
  rates: RateRow | null;
  /** GBP-denominated snapshot values per assigned asset, sorted by date descending. */
  snapshots: Array<{ date: Date; assetId: string; minor: number }>;
  /** Credit-card liabilities with a `billedFromAccountId` pointing at one of the planning accounts, plus the EWMA of their recent balance history that feeds the monthly predicted payment. */
  creditCardPredictions: CreditCardPrediction[];
};

/** Look up every planning account and return the (account, asset) pair — used at PlanningYear load time. */
export async function loadPlanningAccountInfos(): Promise<
  PlanningAccountInfo[]
> {
  const rows = await db
    .select({
      assetId: PlanningAccounts.accountId,
      alias: PlanningAccounts.alias,
      asset: NetWorthCategoryAssets,
    })
    .from(PlanningAccounts)
    .innerJoin(
      NetWorthCategoryAssets,
      eq(PlanningAccounts.accountId, NetWorthCategoryAssets.id),
    );
  return rows.map((r) => ({
    assetId: r.assetId,
    alias: r.alias,
    asset: NetWorthCategoryAsset.load(r.asset),
  }));
}

/** Fetch every source of transactions + value baselines for `yearNumber` in a single concurrent batch. */
export async function loadPlanningYearData(
  yearNumber: number,
  accounts: PlanningAccountInfo[],
): Promise<PlanningYearData> {
  const assetIds = accounts.map((a) => a.assetId);
  const fyStart = new Date(Date.UTC(yearNumber, 3, 1));
  const fyEnd = new Date(Date.UTC(yearNumber + 1, 3, 1));
  const hasAccounts = assetIds.length > 0;

  const [
    txs,
    payslipJoin,
    earningJoin,
    billJoin,
    rates,
    snapshotRows,
    creditCardPredictions,
  ] = await Promise.all([
    hasAccounts
      ? db
          .select()
          .from(PlanningTransactions)
          .where(eq(PlanningTransactions.year, yearNumber))
      : Promise.resolve<TxRow[]>([]),
    hasAccounts
      ? db
          .select({
            payslip: PlanningPayslips,
            adjustment: PlanningPayslipAdjustments,
          })
          .from(PlanningPayslips)
          .leftJoin(
            PlanningPayslipAdjustments,
            eq(PlanningPayslipAdjustments.payslipId, PlanningPayslips.id),
          )
          .where(
            and(
              inArray(PlanningPayslips.toAccountId, assetIds),
              gte(PlanningPayslips.date, fyStart),
              lt(PlanningPayslips.date, fyEnd),
            ),
          )
      : Promise.resolve<
          Array<{ payslip: PayslipRow; adjustment: AdjustmentRow | null }>
        >([]),
    hasAccounts
      ? db
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
              inArray(PlanningEarnings.toAccountId, assetIds),
              lte(PlanningEarnings.start, fyEnd),
              or(
                isNull(PlanningEarnings.end),
                gte(PlanningEarnings.end, fyStart),
              ),
            ),
          )
      : Promise.resolve<
          Array<{ earning: EarningRow; taxCode: TaxCodeRow | null }>
        >([]),
    hasAccounts
      ? db
          .select({ bill: PlanningBills, override: PlanningMonthBills })
          .from(PlanningBills)
          .leftJoin(
            PlanningMonthBills,
            and(
              eq(PlanningMonthBills.billId, PlanningBills.id),
              eq(PlanningMonthBills.year, yearNumber),
            ),
          )
          .where(
            and(
              inArray(PlanningBills.fromAccountId, assetIds),
              lte(PlanningBills.start, fyEnd),
              or(isNull(PlanningBills.end), gte(PlanningBills.end, fyStart)),
            ),
          )
      : Promise.resolve<Array<{ bill: BillRow; override: OverrideRow | null }>>(
          [],
        ),
    db
      .select()
      .from(PlanningYearUKTaxRates)
      .where(eq(PlanningYearUKTaxRates.year, yearNumber))
      .then((rows) => rows[0] ?? null),
    hasAccounts
      ? db
          .select({
            date: NetWorthEntries.date,
            assetId: NetWorthValues.categoryAssetId,
            minor: NetWorthValueAmounts.amount,
          })
          .from(NetWorthEntries)
          .innerJoin(
            NetWorthValues,
            and(
              eq(NetWorthValues.entryId, NetWorthEntries.id),
              inArray(NetWorthValues.categoryAssetId, assetIds),
            ),
          )
          .innerJoin(
            NetWorthValueAmounts,
            and(
              eq(NetWorthValueAmounts.valueId, NetWorthValues.id),
              eq(NetWorthValueAmounts.currency, REPORTING_CURRENCY),
            ),
          )
          .orderBy(desc(NetWorthEntries.date))
      : Promise.resolve<
          Array<{ date: Date; assetId: string | null; minor: number }>
        >([]),
    hasAccounts
      ? loadCreditCardPredictions(assetIds)
      : Promise.resolve<CreditCardPrediction[]>([]),
  ]);

  const payslipsById = new Map<
    string,
    { payslip: PayslipRow; adjustments: AdjustmentRow[] }
  >();
  for (const r of payslipJoin) {
    const entry = payslipsById.get(r.payslip.id) ?? {
      payslip: r.payslip,
      adjustments: [],
    };
    if (r.adjustment) entry.adjustments.push(r.adjustment);
    payslipsById.set(r.payslip.id, entry);
  }
  // Order adjustments deterministically by id — Postgres returns rows in
  // whatever order suits it, which shifts when a row is updated and jumps
  // around visually in the grid. `id` is a uuidv7 so sorting by it is
  // equivalent to creation order.
  for (const entry of payslipsById.values()) {
    entry.adjustments.sort((a, b) => a.id.localeCompare(b.id));
  }

  const billsById = new Map<
    string,
    { bill: BillRow; overridesByMonthStartIso: Map<string, OverrideRow> }
  >();
  for (const r of billJoin) {
    const entry = billsById.get(r.bill.id) ?? {
      bill: r.bill,
      overridesByMonthStartIso: new Map<string, OverrideRow>(),
    };
    if (r.override)
      entry.overridesByMonthStartIso.set(
        r.override.date.toISOString(),
        r.override,
      );
    billsById.set(r.bill.id, entry);
  }

  const earningsById = new Map<
    string,
    { earning: EarningRow; taxCodes: TaxCodeRow[] }
  >();
  for (const r of earningJoin) {
    const entry = earningsById.get(r.earning.id) ?? {
      earning: r.earning,
      taxCodes: [],
    };
    if (r.taxCode) entry.taxCodes.push(r.taxCode);
    earningsById.set(r.earning.id, entry);
  }

  const snapshots: PlanningYearData["snapshots"] = [];
  for (const s of snapshotRows) {
    if (s.assetId == null) continue;
    snapshots.push({ date: s.date, assetId: s.assetId, minor: s.minor });
  }

  return {
    year: yearNumber,
    accounts,
    transactions: txs,
    payslips: Array.from(payslipsById.values()),
    earnings: Array.from(earningsById.values()),
    bills: Array.from(billsById.values()),
    rates,
    snapshots,
    creditCardPredictions,
  };
}

/** How many most-recent liability balances feed the credit-card spend prediction. */
const CREDIT_CARD_EWMA_WINDOW = 24;

/** Load credit-card liabilities whose `billedFromAccountId` points at one of `assetIds`, plus their balance history, and pre-compute the EWMA that will be used as the monthly predicted payment. */
async function loadCreditCardPredictions(
  assetIds: string[],
): Promise<CreditCardPrediction[]> {
  const liabilities = await db
    .select()
    .from(NetWorthCategoryLiabilities)
    .where(
      and(
        eq(NetWorthCategoryLiabilities.type, "CREDIT_CARD"),
        inArray(NetWorthCategoryLiabilities.billedFromAccountId, assetIds),
      ),
    );
  if (liabilities.length === 0) return [];

  const balances = await db
    .select({
      liabilityId: NetWorthValues.categoryLiabilityId,
      date: NetWorthEntries.date,
      minor: NetWorthValueAmounts.amount,
    })
    .from(NetWorthEntries)
    .innerJoin(
      NetWorthValues,
      and(
        eq(NetWorthValues.entryId, NetWorthEntries.id),
        inArray(
          NetWorthValues.categoryLiabilityId,
          liabilities.map((l) => l.id),
        ),
      ),
    )
    .innerJoin(
      NetWorthValueAmounts,
      and(
        eq(NetWorthValueAmounts.valueId, NetWorthValues.id),
        eq(NetWorthValueAmounts.currency, REPORTING_CURRENCY),
      ),
    )
    .orderBy(desc(NetWorthEntries.date));

  const byLiability = new Map<string, number[]>();
  for (const b of balances) {
    if (b.liabilityId == null) continue;
    const list = byLiability.get(b.liabilityId) ?? [];
    if (list.length < CREDIT_CARD_EWMA_WINDOW) list.push(b.minor);
    byLiability.set(b.liabilityId, list);
  }

  return liabilities
    .filter((l) => l.billedFromAccountId != null)
    .map((l) => ({
      liabilityId: l.id,
      name: l.name,
      billedFromAccountId: l.billedFromAccountId as string,
      ewmaMinor: exponentialWeightedAverage(byLiability.get(l.id) ?? []),
    }));
}

/** EWMA over values ordered most-recent-first. Uses α = 2/(n+1) (Pandas default). Returns 0 when `values` is empty. */
function exponentialWeightedAverage(values: number[]): number {
  if (values.length === 0) return 0;
  const alpha = 2 / (values.length + 1);
  let s = values[values.length - 1];
  for (let i = values.length - 2; i >= 0; i--) {
    s = alpha * values[i] + (1 - alpha) * s;
  }
  return Math.round(s);
}

/** Pure in-memory filter: the transactions visible to `(assetId, monthDate)` given a pre-loaded year bundle. */
export function monthTransactionsFor(
  data: PlanningYearData,
  assetId: string,
  monthDate: Date,
): PlanningTransaction[] {
  const monthStart = new Date(
    Date.UTC(monthDate.getUTCFullYear(), monthDate.getUTCMonth(), 1),
  );
  const monthEnd = addMonthsUTC(monthStart, 1);
  const out: PlanningTransaction[] = [];

  // 1) Explicit PlanningTransactions
  for (const tx of data.transactions) {
    if (tx.date.getTime() < monthStart.getTime()) continue;
    if (tx.date.getTime() >= monthEnd.getTime()) continue;
    if (tx.accountId === assetId) {
      out.push({
        id: encodePlanningTransactionId({ kind: "tx", id: tx.id }),
        name: tx.name,
        amount: Money.fromMinorDenomination(tx.amount, tx.currency),
        isProvisional: false,
        isEditable: true,
        liabilityId: (tx.liabilityId ?? null) as ID | null,
        assetId: (tx.assetId ?? null) as ID | null,
      });
    }
    if (tx.toAccountId === assetId) {
      out.push({
        id: encodePlanningTransactionId({ kind: "to", id: tx.id }),
        name: tx.name,
        amount: Money.fromMinorDenomination(-tx.amount, tx.currency),
        isProvisional: false,
        isEditable: false,
        liabilityId: null,
        assetId: null,
      });
    }
  }

  // 2) Payslips (actual income)
  const payslipsThisMonth = data.payslips.filter(
    ({ payslip: p }) =>
      p.toAccountId === assetId &&
      p.date.getTime() >= monthStart.getTime() &&
      p.date.getTime() < monthEnd.getTime(),
  );
  for (const { payslip: p, adjustments } of payslipsThisMonth) {
    out.push({
      id: encodePlanningTransactionId({ kind: "pay", id: p.id }),
      name: p.name,
      amount: Money.fromMinorDenomination(p.amountGross, p.currency),
      isProvisional: false,
      isEditable: true,
      liabilityId: null,
      assetId: null,
    });
    for (const a of adjustments) {
      out.push({
        id: encodePlanningTransactionId({ kind: "adj", id: a.id }),
        name: a.name,
        amount: Money.fromMinorDenomination(a.amount, p.currency),
        isProvisional: false,
        isEditable: true,
        liabilityId: (a.liabilityId ?? null) as ID | null,
        assetId: null,
      });
    }
  }
  const hasPayslip = payslipsThisMonth.length > 0;

  // 3) Earnings predictions (skipped when a payslip covers this account+month)
  if (!hasPayslip && data.rates) {
    for (const { earning: e, taxCodes } of data.earnings) {
      if (e.toAccountId !== assetId) continue;
      const coverage = earningMonthCoverage(e.start, e.end, monthStart);
      if (coverage === 0) continue;
      assert(e.countryCode === "GB", "Only GB earnings supported");
      const take = computeUKTake({
        gross: e.amountGross,
        pension: {
          sacrifice: e.pensionSalarySacrifice,
          netPay: e.pensionNetPay ?? 0,
          relief: e.pensionReliefAtSource ?? 0,
        },
        studentLoanPlan2: e.studentLoanPlan2,
        rates: data.rates,
        taxCode: activeTaxCode(taxCodes, monthStart),
      });
      // Annualised → monthly, then pro-rata'd when the earning only covers
      // part of the month (start or end falls mid-month).
      const perMonth = (n: number) => Math.round((n / 12) * coverage);
      const monthKey = monthId(monthStart);
      out.push({
        id: encodePlanningTransactionId({
          kind: "earn",
          part: "gross",
          id: e.id,
          monthId: monthKey,
        }),
        name: `${e.name} — ${monthYearLabel(monthStart)}`,
        amount: Money.fromMinorDenomination(perMonth(take.gross), e.currency),
        isProvisional: true,
        isEditable: true,
        liabilityId: null,
        assetId: null,
      });
      if (take.incomeTax > 0) {
        out.push({
          id: encodePlanningTransactionId({
            kind: "earn",
            part: "tax",
            id: e.id,
            monthId: monthKey,
          }),
          name: `${e.name} — income tax`,
          amount: Money.fromMinorDenomination(
            -perMonth(take.incomeTax),
            e.currency,
          ),
          isProvisional: true,
          isEditable: true,
          liabilityId: null,
          assetId: null,
        });
      }
      if (take.nic > 0) {
        out.push({
          id: encodePlanningTransactionId({
            kind: "earn",
            part: "nic",
            id: e.id,
            monthId: monthKey,
          }),
          name: `${e.name} — NIC`,
          amount: Money.fromMinorDenomination(-perMonth(take.nic), e.currency),
          isProvisional: true,
          isEditable: true,
          liabilityId: null,
          assetId: null,
        });
      }
      if (take.studentLoan > 0) {
        out.push({
          id: encodePlanningTransactionId({
            kind: "earn",
            part: "sl",
            id: e.id,
            monthId: monthKey,
          }),
          name: `${e.name} — student loan`,
          amount: Money.fromMinorDenomination(
            -perMonth(take.studentLoan),
            e.currency,
          ),
          isProvisional: true,
          isEditable: true,
          liabilityId: (e.studentLoanLiabilityId ?? null) as ID | null,
          assetId: null,
        });
      }
    }
  }

  // 4) Credit-card spend predictions — one row per CC liability whose
  // `billedFromAccountId` is this account, unless the month already has a
  // manual `PlanningTransactions` row with matching `liabilityId` (which
  // explicitly overrides the prediction for that month).
  for (const cc of data.creditCardPredictions) {
    if (cc.billedFromAccountId !== assetId) continue;
    const suppressed = data.transactions.some(
      (t) =>
        t.liabilityId === cc.liabilityId &&
        t.date.getTime() >= monthStart.getTime() &&
        t.date.getTime() < monthEnd.getTime(),
    );
    if (suppressed) continue;
    out.push({
      id: encodePlanningTransactionId({
        kind: "liab",
        id: cc.liabilityId,
        monthId: monthId(monthStart),
      }),
      name: cc.name,
      amount: Money.fromMinorDenomination(
        -Math.abs(cc.ewmaMinor),
        REPORTING_CURRENCY,
      ),
      isProvisional: true,
      isEditable: true,
      liabilityId: cc.liabilityId as ID,
      assetId: null,
    });
  }

  // 5) Bills with per-month overrides
  for (const { bill: b, overridesByMonthStartIso } of data.bills) {
    if (b.fromAccountId !== assetId) continue;
    const collectionDay = collectionDayInMonth(
      b.frequency,
      b.collectionDate,
      monthStart,
    );
    if (collectionDay == null) continue;
    const collectionOn = new Date(
      Date.UTC(
        monthStart.getUTCFullYear(),
        monthStart.getUTCMonth(),
        collectionDay,
      ),
    );
    if (collectionOn.getTime() < b.start.getTime()) continue;
    if (b.end && collectionOn.getTime() > b.end.getTime()) continue;
    const override = overridesByMonthStartIso.get(monthStart.toISOString());
    if (override) {
      if (override.amount == null || override.currency == null) continue;
      out.push({
        id: encodePlanningTransactionId({
          kind: "bill",
          id: b.id,
          monthId: monthId(monthStart),
        }),
        name: b.name,
        amount: Money.fromMinorDenomination(
          -override.amount,
          override.currency,
        ),
        isProvisional: false,
        isEditable: true,
        liabilityId: null,
        assetId: null,
      });
    } else {
      out.push({
        id: encodePlanningTransactionId({
          kind: "bill",
          id: b.id,
          monthId: monthId(monthStart),
        }),
        name: b.name,
        amount: Money.fromMinorDenomination(-b.amount, b.currency),
        isProvisional: true,
        isEditable: true,
        liabilityId: null,
        assetId: null,
      });
    }
  }

  return out;
}

/** Pure in-memory compute: the opening balance at `monthDate` for `assetId`, rolling forward from the latest snapshot strictly before it through intervening months' transactions. */
export function valueStartFor(
  data: PlanningYearData,
  assetId: string,
  monthDate: Date,
): Money {
  const monthStart = new Date(
    Date.UTC(monthDate.getUTCFullYear(), monthDate.getUTCMonth(), 1),
  );
  const baseline = data.snapshots.find(
    (s) => s.assetId === assetId && s.date.getTime() < monthStart.getTime(),
  );
  let runningMinor = baseline ? baseline.minor : 0;

  const baselineMonthStart = baseline
    ? new Date(
        Date.UTC(
          baseline.date.getUTCFullYear(),
          baseline.date.getUTCMonth(),
          1,
        ),
      )
    : null;
  let cursor = baselineMonthStart
    ? addMonthsUTC(baselineMonthStart, 1)
    : new Date(Date.UTC(data.year, 3, 1));
  while (cursor.getTime() < monthStart.getTime()) {
    const txs = monthTransactionsFor(data, assetId, cursor);
    for (const tx of txs) {
      assert(
        tx.amount.currency === REPORTING_CURRENCY,
        `Transaction currency ${tx.amount.currency} does not match reporting currency ${REPORTING_CURRENCY}`,
      );
      runningMinor += Math.round(tx.amount.amount * 100);
    }
    cursor = addMonthsUTC(cursor, 1);
  }

  return Money.fromMinorDenomination(runningMinor, REPORTING_CURRENCY);
}

/** The day-of-month on which the bill collects within `monthDate`, or `null` if it does not collect that month. MONTHLY returns the bare day; QUARTERLY/YEARLY look up the matching `M-D` entry. */
function collectionDayInMonth(
  frequency: "MONTHLY" | "QUARTERLY" | "YEARLY",
  collectionDate: string,
  monthDate: Date,
): number | null {
  const month = monthDate.getUTCMonth() + 1;
  switch (frequency) {
    case "MONTHLY":
      return Number(collectionDate);
    case "QUARTERLY":
      return matchMonthDay(collectionDate.split(/,\s*/), month);
    case "YEARLY":
      return matchMonthDay([collectionDate], month);
    default:
      throw new UnreachableCaseError(frequency);
  }
}

function matchMonthDay(entries: string[], month: number): number | null {
  for (const entry of entries) {
    const [m, d] = entry.split("-");
    if (Number(m) === month) return Number(d);
  }
  return null;
}

/** Pick the tax code whose `[start, end]` covers `monthStart`, or null if none do. Multiple codes can be recorded over an earning's lifetime (a new HMRC code re-issued mid-year); we return the first match. */
function activeTaxCode(
  taxCodes: TaxCodeRow[],
  monthStart: Date,
): string | null {
  const ms = monthStart.getTime();
  for (const tc of taxCodes) {
    const s = tc.start.getTime();
    const e = tc.end?.getTime() ?? Number.POSITIVE_INFINITY;
    if (s <= ms && ms <= e) return tc.taxCode;
  }
  return null;
}

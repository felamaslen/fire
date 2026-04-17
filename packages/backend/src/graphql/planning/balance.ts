import { strict as assert } from "node:assert";

import { and, desc, eq, gte, inArray, isNull, lt, lte, or } from "drizzle-orm";
import type { ID } from "grats";

import { HOME_CURRENCY } from "@/config";
import { db } from "@/db";
import {
  NetWorthCategoryAssets,
  NetWorthEntries,
  NetWorthValueAmounts,
  NetWorthValues,
} from "@/db/schema/net-worth";
import {
  PlanningAccounts,
  PlanningBills,
  PlanningEarnings,
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
import { computeUKTake } from "./tax";
import { encodePlanningTransactionId } from "./transactions";

// TODO: derive per-account currency from the latest NetWorthValueAmount / let callers specify it. For now the planner reports everything in the home currency.
const REPORTING_CURRENCY = HOME_CURRENCY;

type TxRow = typeof PlanningTransactions.$inferSelect;
type PayslipRow = typeof PlanningPayslips.$inferSelect;
type AdjustmentRow = typeof PlanningPayslipAdjustments.$inferSelect;
type EarningRow = typeof PlanningEarnings.$inferSelect;
type BillRow = typeof PlanningBills.$inferSelect;
type OverrideRow = typeof PlanningMonthBills.$inferSelect;
type RateRow = typeof PlanningYearUKTaxRates.$inferSelect;

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
  earnings: EarningRow[];
  bills: Array<{
    bill: BillRow;
    overridesByMonthStartIso: Map<string, OverrideRow>;
  }>;
  rates: RateRow | null;
  /** GBP-denominated snapshot values per assigned asset, sorted by date descending. */
  snapshots: Array<{ date: Date; assetId: string; minor: number }>;
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

  const [txs, payslipJoin, earnings, billJoin, rates, snapshotRows] =
    await Promise.all([
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
            .select()
            .from(PlanningEarnings)
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
        : Promise.resolve<EarningRow[]>([]),
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
        : Promise.resolve<
            Array<{ bill: BillRow; override: OverrideRow | null }>
          >([]),
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
    earnings,
    bills: Array.from(billsById.values()),
    rates,
    snapshots,
  };
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
  const monthEnd = new Date(
    Date.UTC(monthDate.getUTCFullYear(), monthDate.getUTCMonth() + 1, 1),
  );
  const out: PlanningTransaction[] = [];

  // 1) Explicit PlanningTransactions
  for (const tx of data.transactions) {
    if (tx.date.getTime() < monthStart.getTime()) continue;
    if (tx.date.getTime() >= monthEnd.getTime()) continue;
    if (tx.fromAccountId === assetId) {
      out.push({
        id: encodePlanningTransactionId({ kind: "tx", id: tx.id }),
        name: tx.name,
        amount: Money.fromMinorDenomination(-tx.amount, tx.currency),
        isProvisional: false,
        isEditable: true,
        liabilityId: null,
      });
    }
    if (tx.toAccountId === assetId) {
      out.push({
        id: encodePlanningTransactionId({ kind: "to", id: tx.id }),
        name: tx.name,
        amount: Money.fromMinorDenomination(tx.amount, tx.currency),
        isProvisional: false,
        isEditable: false,
        liabilityId: null,
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
    });
    for (const a of adjustments) {
      out.push({
        id: encodePlanningTransactionId({ kind: "adj", id: a.id }),
        name: a.name,
        amount: Money.fromMinorDenomination(a.amount, p.currency),
        isProvisional: false,
        isEditable: true,
        liabilityId: (a.liabilityId ?? null) as ID | null,
      });
    }
  }
  const hasPayslip = payslipsThisMonth.length > 0;

  // 3) Earnings predictions (skipped when a payslip covers this account+month)
  if (!hasPayslip && data.rates) {
    for (const e of data.earnings) {
      if (e.toAccountId !== assetId) continue;
      if (e.start.getTime() > monthStart.getTime()) continue;
      if (e.end && e.end.getTime() < monthStart.getTime()) continue;
      assert(e.countryCode === "GB", "Only GB earnings supported");
      const take = computeUKTake({
        gross: e.amountGross,
        pension: {
          sacrifice: e.pensionSalarySacrifice,
          netPay: e.pensionNetPay,
          relief: e.pensionReliefAtSource,
        },
        studentLoanPlan2: e.studentLoanPlan2,
        rates: data.rates,
      });
      const perMonth = (n: number) => Math.round(n / 12);
      out.push({
        id: encodePlanningTransactionId({
          kind: "earn",
          part: "gross",
          id: e.id,
        }),
        name: `${e.name} — gross`,
        amount: Money.fromMinorDenomination(perMonth(take.gross), e.currency),
        isProvisional: true,
        isEditable: true,
        liabilityId: null,
      });
      if (take.incomeTax > 0) {
        out.push({
          id: encodePlanningTransactionId({
            kind: "earn",
            part: "tax",
            id: e.id,
          }),
          name: `${e.name} — income tax`,
          amount: Money.fromMinorDenomination(
            -perMonth(take.incomeTax),
            e.currency,
          ),
          isProvisional: true,
          isEditable: true,
          liabilityId: null,
        });
      }
      if (take.nic > 0) {
        out.push({
          id: encodePlanningTransactionId({
            kind: "earn",
            part: "nic",
            id: e.id,
          }),
          name: `${e.name} — NIC`,
          amount: Money.fromMinorDenomination(-perMonth(take.nic), e.currency),
          isProvisional: true,
          isEditable: true,
          liabilityId: null,
        });
      }
      if (take.studentLoan > 0) {
        out.push({
          id: encodePlanningTransactionId({
            kind: "earn",
            part: "sl",
            id: e.id,
          }),
          name: `${e.name} — student loan`,
          amount: Money.fromMinorDenomination(
            -perMonth(take.studentLoan),
            e.currency,
          ),
          isProvisional: true,
          isEditable: true,
          liabilityId: null,
        });
      }
    }
  }

  // 4) Bills with per-month overrides
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
        id: encodePlanningTransactionId({ kind: "bill", id: b.id }),
        name: b.name,
        amount: Money.fromMinorDenomination(
          -override.amount,
          override.currency,
        ),
        isProvisional: false,
        isEditable: true,
        liabilityId: null,
      });
    } else {
      out.push({
        id: encodePlanningTransactionId({ kind: "bill", id: b.id }),
        name: b.name,
        amount: Money.fromMinorDenomination(-b.amount, b.currency),
        isProvisional: true,
        isEditable: true,
        liabilityId: null,
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

  const walkFrom = baseline
    ? new Date(
        Date.UTC(
          baseline.date.getUTCFullYear(),
          baseline.date.getUTCMonth() + 1,
          1,
        ),
      )
    : new Date(Date.UTC(data.year, 3, 1));
  const cursor = new Date(walkFrom);
  while (cursor.getTime() < monthStart.getTime()) {
    const txs = monthTransactionsFor(data, assetId, cursor);
    for (const tx of txs) {
      assert(
        tx.amount.currency === REPORTING_CURRENCY,
        `Transaction currency ${tx.amount.currency} does not match reporting currency ${REPORTING_CURRENCY}`,
      );
      runningMinor += Math.round(tx.amount.amount * 100);
    }
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
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

import { strict as assert } from "node:assert";

import {
  and,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
} from "drizzle-orm";
import type { ID } from "grats";
import { z } from "zod";

import { HOME_CURRENCY } from "@/config";
import { db } from "@/db";
import type { CurrencyCode } from "@/db/schema/currency";
import {
  NetWorthCategoryAssets,
  NetWorthCategoryLiabilities,
} from "@/db/schema/net-worth";
import {
  PlanningBills,
  PlanningEarnings,
  PlanningEarningsUKTaxCodes,
  PlanningMonthBills,
  PlanningPayslipAdjustments,
  PlanningPayslips,
  PlanningTransactions,
  PlanningYearUKTaxRates,
} from "@/db/schema/planning";

import {
  getMoneyInputFractionalAmount,
  Money,
  type MoneyInput,
} from "../money";
import {
  NetWorthCategoryAsset,
  NetWorthCategoryLiability,
} from "../net-worth/categories";
import { VOID, type Void } from "../void";
import { ensurePlanningMonth, PlanningTransaction } from "./index";
import {
  earningMonthCoverage,
  monthYearLabel,
  parseMonthId,
  planningMonthKey,
} from "./months";
import { computeUKTake } from "./tax";

/**
 * Opaque `PlanningTransaction.id` payload — identifies what a given row on the ledger actually maps back to. Encoded on the wire as hex-encoded JSON so clients treat it as an opaque string, but decodable on the server for routing `transactionUpdate` / `transactionDelete`.
 */
const txIdSchema = z.discriminatedUnion("kind", [
  /** Manual `PlanningTransactions` row, from-side (the account paying out). */
  z.object({ kind: z.literal("tx"), id: z.string() }),
  /** Manual `PlanningTransactions` row, to-side (the account receiving, for transfers). */
  z.object({ kind: z.literal("to"), id: z.string() }),
  /** Payslip gross pay row. */
  z.object({ kind: z.literal("pay"), id: z.string() }),
  /** Payslip adjustment row. */
  z.object({ kind: z.literal("adj"), id: z.string() }),
  /** Bill projection — either a predicted row or a materialised `PlanningMonthBills` override. `monthId` scopes the virtual row to a specific month so the composite is globally unique (the same bill appears in each month it collects in). */
  z.object({
    kind: z.literal("bill"),
    id: z.string(),
    monthId: z.string(),
  }),
  /** One line from an earnings stream's predicted monthly take (gross, income-tax, NIC, or student-loan). `monthId` scopes the virtual row to a specific month — the same earning projects identical rows across every covered month, so the composite has to include the month to stay globally unique. */
  z.object({
    kind: z.literal("earn"),
    part: z.enum(["gross", "tax", "nic", "sl", "pen"]),
    id: z.string(),
    monthId: z.string(),
  }),
  /** Credit-card payment prediction for a month — `id` is the liability id. `monthId` scopes the virtual row to a specific month; editing materialises a real `PlanningTransactions` row with the liability id set, which then suppresses this prediction for that month. */
  z.object({
    kind: z.literal("liab"),
    id: z.string(),
    monthId: z.string(),
  }),
]);

export type PlanningTransactionId = z.infer<typeof txIdSchema>;

export function encodePlanningTransactionId(
  payload: PlanningTransactionId,
): ID {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("hex") as ID;
}

export function decodePlanningTransactionId(
  raw: string,
): PlanningTransactionId {
  try {
    const json = Buffer.from(raw, "hex").toString("utf8");
    return txIdSchema.parse(JSON.parse(json));
  } catch (cause) {
    throw new Error(`Invalid transaction id: ${raw}`, { cause });
  }
}

/**
 * Asset categories (`STOCK` / `PENSION`) most commonly referenced by existing planning transactions paid out of `accountId`, ordered by descending use count. Intended as a "frequently used" shortlist for the investment-transaction form.
 *
 * @gqlQueryField
 * @gqlAnnotate semanticNonNull
 */
export async function transactionAssetsFrequent(
  /** Planning account (`PlanningAccount.id`) to scope the frequency count to — only transactions debited from this account are counted. */
  accountId: ID,
): Promise<NetWorthCategoryAsset[] | null> {
  const rows = await db
    .select({
      asset: NetWorthCategoryAssets,
      c: count(PlanningTransactions.id).as("c"),
    })
    .from(PlanningTransactions)
    .innerJoin(
      NetWorthCategoryAssets,
      eq(NetWorthCategoryAssets.id, PlanningTransactions.assetId),
    )
    .where(eq(PlanningTransactions.accountId, accountId))
    .groupBy(NetWorthCategoryAssets.id)
    .orderBy(desc(count(PlanningTransactions.id)));
  return rows.map((r) => NetWorthCategoryAsset.load(r.asset));
}

/**
 * Liability categories most commonly serviced from `accountId`, ordered by descending use count. Counts both manual planning transactions debited from this account and recurring bills paid from this account (e.g. a mortgage bill tagged with its LOAN liability), so loan / mortgage liabilities that are only ever touched via the bills flow still surface here. Intended as a "frequently used" shortlist for the credit-card / bill-payment transaction form.
 *
 * @gqlQueryField
 * @gqlAnnotate semanticNonNull
 */
export async function transactionLiabilitiesFrequent(
  /** Planning account (`PlanningAccount.id`) to scope the frequency count to — only rows debited from this account are counted. */
  accountId: ID,
): Promise<NetWorthCategoryLiability[] | null> {
  // Pull liabilityIds from both sources (manual tx + bills) and aggregate in
  // memory. A single SQL UNION would also work but the bill count is
  // naturally small for a personal finance app, so this stays readable.
  const [txRows, billRows] = await Promise.all([
    db
      .select({
        liabilityId: PlanningTransactions.liabilityId,
        c: count(PlanningTransactions.id).as("c"),
      })
      .from(PlanningTransactions)
      .where(
        and(
          eq(PlanningTransactions.accountId, accountId),
          isNotNull(PlanningTransactions.liabilityId),
        ),
      )
      .groupBy(PlanningTransactions.liabilityId),
    db
      .select({
        liabilityId: PlanningBills.liabilityId,
        c: count(PlanningBills.id).as("c"),
      })
      .from(PlanningBills)
      .where(
        and(
          eq(PlanningBills.fromAccountId, accountId),
          isNotNull(PlanningBills.liabilityId),
        ),
      )
      .groupBy(PlanningBills.liabilityId),
  ]);
  const totals = new Map<string, number>();
  for (const r of [...txRows, ...billRows]) {
    if (r.liabilityId == null) continue;
    totals.set(r.liabilityId, (totals.get(r.liabilityId) ?? 0) + r.c);
  }
  if (totals.size === 0) return [];
  const rows = await db
    .select()
    .from(NetWorthCategoryLiabilities)
    .where(inArray(NetWorthCategoryLiabilities.id, Array.from(totals.keys())));
  return rows
    .sort((a, b) => (totals.get(b.id) ?? 0) - (totals.get(a.id) ?? 0))
    .map((r) => NetWorthCategoryLiability.load(r));
}

/**
 * Record a manual transaction on a planning month. `amount` is signed — negative for outflows (debits `accountId`, optionally credits `toAccountId`) and positive for ad-hoc inflows credited to `accountId` with no source account. A positive amount requires `toAccountId`, `liabilityId`, and `assetId` to be null. An outflow may either pay down a liability OR invest into a stock/pension asset, but not both.
 *
 * @gqlMutationField
 */
export async function transactionCreate(
  /** Planning month id, e.g. `"apr-2025"`. */
  monthId: ID,
  /** Signed amount: negative = outflow, positive = ad-hoc inflow. */
  amount: MoneyInput,
  name: string,
  /** Primary planning account (`PlanningAccount.id`): debited when `amount` is negative (outflow) or credited when positive (ad-hoc inflow). */
  accountId: ID,
  /** Destination planning account (`PlanningAccount.id`) for an internal transfer. Only valid for outflows. */
  toAccountId?: ID | null,
  /** Liability (`NetWorthCategoryLiability.id`) being paid down by this transaction, if any. Only valid for outflows. Mutually exclusive with `assetId`. */
  liabilityId?: ID | null,
  /** Asset (`NetWorthCategoryAsset.id`, type `STOCK` or `PENSION`) being invested into by this transaction, if any. Only valid for outflows. Mutually exclusive with `liabilityId`. */
  assetId?: ID | null,
): Promise<PlanningTransaction> {
  const { year, date } = monthKey(monthId);
  const { currency, amount: minor } = getMoneyInputFractionalAmount(amount);
  if (minor > 0) {
    assert(
      toAccountId == null && liabilityId == null && assetId == null,
      "Inflow transactions must not have a toAccountId, liabilityId, or assetId",
    );
  }
  assert(
    liabilityId == null || assetId == null,
    "A transaction cannot both pay down a liability and invest into an asset",
  );
  if (assetId != null) await assertInvestableAsset(assetId);
  await ensurePlanningMonth(year, date);
  const [row] = await db
    .insert(PlanningTransactions)
    .values({
      year,
      date,
      amount: minor,
      currency,
      name,
      accountId,
      toAccountId: toAccountId ?? null,
      liabilityId: liabilityId ?? null,
      assetId: assetId ?? null,
    })
    .returning();
  return new PlanningTransaction({
    id: encodePlanningTransactionId({ kind: "tx", id: row.id }),
    name: row.name,
    amount: Money.fromMinorDenomination(row.amount, row.currency),
    isProvisional: false,
    isEditable: true,
    toAccountId: row.toAccountId ?? null,
    liabilityId: row.liabilityId ?? null,
    assetId: row.assetId ?? null,
  });
}

/** Verify an asset exists and is of a type (`STOCK` / `PENSION`) that can receive investment transactions. */
async function assertInvestableAsset(assetId: string): Promise<void> {
  const [asset] = await db
    .select({ type: NetWorthCategoryAssets.type })
    .from(NetWorthCategoryAssets)
    .where(eq(NetWorthCategoryAssets.id, assetId));
  assert(asset, `Asset ${assetId} not found`);
  assert(
    asset.type === "STOCK" || asset.type === "PENSION",
    "Only STOCK or PENSION assets can receive investment transactions",
  );
}

/**
 * Update an existing transaction. The composite `id` determines what's actually rewritten:
 *
 * - `tx:…` / `to:…` — patches the underlying manual `PlanningTransactions` row.
 * - `pay:…` — patches the payslip gross / name.
 * - `adj:…` — patches a payslip adjustment (sign of the existing row is preserved; `amount` is treated as magnitude).
 * - `bill:…` — creates or updates a per-month bill override so this month uses the new amount in place of the predicted value.
 * - `earn:…` — materialises this month's earnings prediction as a real payslip (gross + auto-populated tax/NIC/student-loan deductions), then applies the edit to the corresponding payslip line. Future months continue to be predicted from the earnings stream.
 *
 * @gqlMutationField
 */
export async function transactionUpdate(
  /** Planning month id, e.g. `"apr-2025"`. For manual transactions this also re-anchors the transaction to that month. */
  monthId: ID,
  /** Composite id as returned on `PlanningTransaction.id`. */
  id: ID,
  /** New positive magnitude. */
  amount?: MoneyInput | null,
  name?: string | null,
  /** New primary planning account (`PlanningAccount.id`). Manual transactions only. */
  accountId?: ID | null,
  /** New destination planning account (`PlanningAccount.id`) for a transfer. Pass null explicitly to clear. Manual transactions only. */
  toAccountId?: ID | null,
  /** New serviced liability (`NetWorthCategoryLiability.id`). Pass null explicitly to clear. Manual transactions only. Mutually exclusive with `assetId`. */
  liabilityId?: ID | null,
  /** New invested-into asset (`NetWorthCategoryAsset.id`, type `STOCK` or `PENSION`). Pass null explicitly to clear. Manual transactions only. Mutually exclusive with `liabilityId`. */
  assetId?: ID | null,
): Promise<PlanningTransaction> {
  const { year, date } = monthKey(monthId);
  const parsed = decodePlanningTransactionId(id);
  const patchAmount =
    amount != null ? getMoneyInputFractionalAmount(amount) : null;

  switch (parsed.kind) {
    case "tx":
    case "to": {
      assert(
        liabilityId == null || assetId == null,
        "A transaction cannot both pay down a liability and invest into an asset",
      );
      if (assetId != null) await assertInvestableAsset(assetId);
      await ensurePlanningMonth(year, date);
      // `EditTransactionForm` sends a signed amount — the sign is whatever
      // the user picked via the direction toggle. We store it verbatim; the
      // DB's `inflow_ck` rejects disallowed sign/link combinations.
      await db
        .update(PlanningTransactions)
        .set({
          year,
          date,
          ...(name != null && { name }),
          ...(patchAmount && patchAmount),
          ...(accountId != null && { accountId }),
          ...(toAccountId !== undefined && { toAccountId }),
          ...(liabilityId !== undefined && { liabilityId }),
          ...(assetId !== undefined && { assetId }),
          updatedAt: new Date(),
        })
        .where(eq(PlanningTransactions.id, parsed.id));
      break;
    }
    case "pay": {
      await db
        .update(PlanningPayslips)
        .set({
          ...(name != null && { name }),
          ...(patchAmount && {
            amountGross: Math.abs(patchAmount.amount),
            currency: patchAmount.currency,
          }),
          updatedAt: new Date(),
        })
        .where(eq(PlanningPayslips.id, parsed.id));
      break;
    }
    case "adj": {
      await db
        .update(PlanningPayslipAdjustments)
        .set({
          ...(name != null && { name }),
          ...(patchAmount && { amount: patchAmount.amount }),
          updatedAt: new Date(),
        })
        .where(eq(PlanningPayslipAdjustments.id, parsed.id));
      break;
    }
    case "bill": {
      const [bill] = await db
        .select()
        .from(PlanningBills)
        .where(eq(PlanningBills.id, parsed.id));
      assert(bill, `Bill ${parsed.id} not found`);
      if (patchAmount) {
        await upsertBillOverride(
          year,
          date,
          parsed.id,
          Math.abs(patchAmount.amount),
          patchAmount.currency as CurrencyCode,
        );
      }
      // Liability is a property of the bill itself (it tags every collection,
      // not a single month's), so patch it on `PlanningBills` directly.
      // `name` likewise renames the bill globally.
      if (liabilityId !== undefined || name != null) {
        await db
          .update(PlanningBills)
          .set({
            ...(liabilityId !== undefined && { liabilityId }),
            ...(name != null && { name }),
            updatedAt: new Date(),
          })
          .where(eq(PlanningBills.id, parsed.id));
      }
      break;
    }
    case "earn": {
      await materialiseEarningAsPayslip(year, date, parsed, {
        patchAmount: patchAmount?.amount ?? null,
        patchName: name ?? null,
      });
      break;
    }
    case "liab": {
      await materialiseCreditCardPrediction(year, date, parsed.id, {
        patchAmount: patchAmount?.amount ?? null,
        patchCurrency: patchAmount?.currency ?? null,
        patchName: name ?? null,
      });
      break;
    }
  }
  return reloadTransaction(parsed);
}

/** Fetch the current `PlanningTransaction` view of a row after an update. Derived kinds (`earn`, `bill`) materialise into concrete payslip / override rows, but we still return the source composite id so the caller's reference stays valid. */
async function reloadTransaction(
  parsed: PlanningTransactionId,
): Promise<PlanningTransaction> {
  switch (parsed.kind) {
    case "tx":
    case "to": {
      const [row] = await db
        .select()
        .from(PlanningTransactions)
        .where(eq(PlanningTransactions.id, parsed.id));
      assert(row, `Transaction ${parsed.id} not found`);
      const fromSide = parsed.kind === "tx";
      // The "to" side of a transfer is the mirror image: flip the stored sign.
      const signedMinor = fromSide ? row.amount : -row.amount;
      return new PlanningTransaction({
        id: encodePlanningTransactionId(parsed),
        name: row.name,
        amount: Money.fromMinorDenomination(signedMinor, row.currency),
        isProvisional: false,
        isEditable: fromSide,
        toAccountId: fromSide ? (row.toAccountId ?? null) : null,
        liabilityId: fromSide ? (row.liabilityId ?? null) : null,
        assetId: fromSide ? (row.assetId ?? null) : null,
      });
    }
    case "pay": {
      const [row] = await db
        .select()
        .from(PlanningPayslips)
        .where(eq(PlanningPayslips.id, parsed.id));
      assert(row, `Payslip ${parsed.id} not found`);
      return new PlanningTransaction({
        id: encodePlanningTransactionId(parsed),
        name: row.name,
        amount: Money.fromMinorDenomination(row.amountGross, row.currency),
        isProvisional: false,
        isEditable: true,
        toAccountId: null,
        liabilityId: null,
        assetId: null,
      });
    }
    case "adj": {
      const [row] = await db
        .select({
          adjustment: PlanningPayslipAdjustments,
          payslip: PlanningPayslips,
        })
        .from(PlanningPayslipAdjustments)
        .innerJoin(
          PlanningPayslips,
          eq(PlanningPayslips.id, PlanningPayslipAdjustments.payslipId),
        )
        .where(eq(PlanningPayslipAdjustments.id, parsed.id));
      assert(row, `Adjustment ${parsed.id} not found`);
      return new PlanningTransaction({
        id: encodePlanningTransactionId(parsed),
        name: row.adjustment.name,
        amount: Money.fromMinorDenomination(
          row.adjustment.amount,
          row.payslip.currency,
        ),
        isProvisional: false,
        isEditable: true,
        isPayslipDeduction: true,
        toAccountId: null,
        liabilityId: row.adjustment.liabilityId ?? null,
        assetId: null,
      });
    }
    case "bill":
    case "earn":
    case "liab": {
      // Derived kinds materialise into new rows with different composite ids
      // (the derived row is replaced, not mutated in place). We return a
      // placeholder carrying the original `id` so Apollo can invalidate the
      // cached derived entry — clients should refetch the month view to pick
      // up the fresh concrete row. The stub is flagged `isEditable: false`
      // to discourage UIs from treating it as a real transaction.
      return new PlanningTransaction({
        id: encodePlanningTransactionId(parsed),
        name: "",
        amount: Money.fromMinorDenomination(0, "GBP"),
        isProvisional: true,
        isEditable: false,
        toAccountId: null,
        liabilityId: null,
        assetId: null,
      });
    }
  }
}

/**
 * Delete a transaction. For derived transactions we can't literally delete the row (it doesn't exist yet); instead we record the suppression:
 *
 * - `tx:…` / `to:…` — deletes the `PlanningTransactions` row.
 * - `pay:…` — deletes the payslip (and its adjustments, via cascade).
 * - `adj:…` — deletes the single adjustment.
 * - `bill:…` — clears any per-month override row for this (bill, month), so the predicted bill takes over again. To cancel a predicted bill for one month, set its amount to zero explicitly via `transactionUpdate` instead of deleting.
 * - `earn:…` — inserts a zero-gross payslip with no adjustments, which suppresses the earnings prediction for this month.
 * - `liab:…` — materialises a zero-amount manual transaction tagged with the liability, which suppresses the credit-card spend prediction for this month while leaving the liability visible in the grid.
 *
 * @gqlMutationField
 */
export async function transactionDelete(
  /** Planning month id, e.g. `"apr-2025"`. */
  monthId: ID,
  /** Composite id as returned on `PlanningTransaction.id`. */
  id: ID,
): Promise<Void> {
  const { year, date } = monthKey(monthId);
  const parsed = decodePlanningTransactionId(id);

  switch (parsed.kind) {
    case "tx":
    case "to":
      await db
        .delete(PlanningTransactions)
        .where(eq(PlanningTransactions.id, parsed.id));
      break;
    case "pay":
      await db
        .delete(PlanningPayslips)
        .where(eq(PlanningPayslips.id, parsed.id));
      break;
    case "adj":
      await db
        .delete(PlanningPayslipAdjustments)
        .where(eq(PlanningPayslipAdjustments.id, parsed.id));
      break;
    case "bill":
      await db
        .delete(PlanningMonthBills)
        .where(
          and(
            eq(PlanningMonthBills.year, year),
            eq(PlanningMonthBills.date, date),
            eq(PlanningMonthBills.billId, parsed.id),
          ),
        );
      break;
    case "earn": {
      const [earning] = await db
        .select()
        .from(PlanningEarnings)
        .where(eq(PlanningEarnings.id, parsed.id));
      assert(earning, `Earning ${parsed.id} not found`);
      await db.insert(PlanningPayslips).values({
        date: lastDayOfMonth(date),
        amountGross: 0,
        currency: earning.currency,
        name: `${earning.name} — skipped`,
        toAccountId: earning.toAccountId,
        fileUrl: null,
      });
      break;
    }
    case "liab":
      // The predicted row doesn't exist in the DB, so there's nothing to
      // literally delete. Materialise a zero-amount manual transaction
      // tagged with the liability instead — its `liabilityId` presence
      // suppresses the prediction for this month (see
      // `monthTransactionsFor`), while the zero amount means the user's
      // "delete" reads as "I'm not paying this off this month".
      await materialiseCreditCardPrediction(year, date, parsed.id, {
        patchAmount: 0,
        patchCurrency: null,
        patchName: null,
      });
      break;
  }
  return VOID;
}

function monthKey(monthId: string): { year: number; date: Date } {
  return planningMonthKey(parseMonthId(monthId));
}

function lastDayOfMonth(monthStart: Date): Date {
  return new Date(
    Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 0),
  );
}

async function upsertBillOverride(
  year: number,
  date: Date,
  billId: string,
  amount: number | null,
  currency: CurrencyCode | null,
): Promise<void> {
  await ensurePlanningMonth(year, date);
  await db
    .insert(PlanningMonthBills)
    .values({ year, date, billId, amount, currency })
    .onConflictDoUpdate({
      target: [
        PlanningMonthBills.year,
        PlanningMonthBills.date,
        PlanningMonthBills.billId,
      ],
      set: { amount, currency, updatedAt: new Date() },
    });
}

/** Create a concrete payslip for this month mirroring the earnings prediction, applying the user's edit to the matching line. */
async function materialiseEarningAsPayslip(
  year: number,
  date: Date,
  parsed: Extract<PlanningTransactionId, { kind: "earn" }>,
  edit: { patchAmount: number | null; patchName: string | null },
): Promise<void> {
  const [earning] = await db
    .select()
    .from(PlanningEarnings)
    .where(eq(PlanningEarnings.id, parsed.id));
  assert(earning, `Earning ${parsed.id} not found`);
  assert(earning.countryCode === "GB", "Only GB earnings supported");
  const [rates] = await db
    .select()
    .from(PlanningYearUKTaxRates)
    .where(eq(PlanningYearUKTaxRates.year, year));
  assert(rates, `UK tax rates for year ${year} not found`);
  const [activeCode] = await db
    .select()
    .from(PlanningEarningsUKTaxCodes)
    .where(
      and(
        eq(PlanningEarningsUKTaxCodes.earningsId, parsed.id),
        lte(PlanningEarningsUKTaxCodes.start, date),
        or(
          isNull(PlanningEarningsUKTaxCodes.end),
          gte(PlanningEarningsUKTaxCodes.end, date),
        ),
      ),
    );
  const take = computeUKTake({
    gross: earning.amountGross,
    pension: {
      sacrifice: earning.pensionSalarySacrifice,
      netPay: earning.pensionNetPay ?? 0,
      relief: earning.pensionReliefAtSource ?? 0,
    },
    studentLoanPlan2: earning.studentLoanPlan2,
    rates,
    taxCode: activeCode?.taxCode ?? null,
  });
  // Keep the materialised payslip in sync with the projection that produced
  // the row the user just clicked on: pro-rata the monthly figures when the
  // earning only covers part of the month (mid-month start / end).
  const coverage = earningMonthCoverage(earning.start, earning.end, date);
  const perMonth = (n: number) => Math.round((n / 12) * coverage);

  let gross = perMonth(take.gross);
  const adjustments: {
    part: "tax" | "nic" | "sl" | "pen";
    name: string;
    amount: number;
    liabilityId: string | null;
  }[] = [];
  // Names mirror the predicted transactions built in `balance.ts` so the
  // grid looks identical before and after a line gets materialised.
  if (take.incomeTax > 0)
    adjustments.push({
      part: "tax",
      name: `${earning.name} — income tax`,
      amount: -perMonth(take.incomeTax),
      liabilityId: null,
    });
  if (take.nic > 0)
    adjustments.push({
      part: "nic",
      name: `${earning.name} — NIC`,
      amount: -perMonth(take.nic),
      liabilityId: null,
    });
  if (take.studentLoan > 0)
    adjustments.push({
      part: "sl",
      name: `${earning.name} — student loan`,
      amount: -perMonth(take.studentLoan),
      liabilityId: earning.studentLoanLiabilityId,
    });
  if (take.pensionEmployee > 0)
    adjustments.push({
      part: "pen",
      name: `${earning.name} — pension`,
      amount: -perMonth(take.pensionEmployee),
      liabilityId: null,
    });

  if (parsed.part === "gross") {
    if (edit.patchAmount != null) gross = Math.abs(edit.patchAmount);
  } else {
    const signedOverride =
      edit.patchAmount != null ? -Math.abs(edit.patchAmount) : null;
    const existing = adjustments.find((a) => a.part === parsed.part);
    if (existing) {
      if (signedOverride != null) existing.amount = signedOverride;
      if (edit.patchName != null) existing.name = edit.patchName;
    } else {
      adjustments.push({
        part: parsed.part,
        name:
          edit.patchName ?? `${earning.name} — ${adjustmentLabel[parsed.part]}`,
        amount: signedOverride ?? 0,
        liabilityId:
          parsed.part === "sl" ? earning.studentLoanLiabilityId : null,
      });
    }
  }

  // The payslip's `name` is shown as the gross-row label in the cell, so only
  // honour `patchName` when the user is actually editing the gross line. For
  // every other edit (and when no name is supplied) fall back to
  // `<earning name> — <MM/YYYY>` so the row matches its predicted label.
  const payslipDate = lastDayOfMonth(date);
  const payslipName =
    parsed.part === "gross" && edit.patchName != null
      ? edit.patchName
      : `${earning.name} — ${monthYearLabel(date)}`;

  await db.transaction(async (tx) => {
    const [payslip] = await tx
      .insert(PlanningPayslips)
      .values({
        date: payslipDate,
        amountGross: gross,
        currency: earning.currency,
        name: payslipName,
        toAccountId: earning.toAccountId,
        fileUrl: null,
      })
      .returning();
    for (const a of adjustments) {
      await tx.insert(PlanningPayslipAdjustments).values({
        payslipId: payslip.id,
        amount: a.amount,
        name: a.name,
        liabilityId: a.liabilityId,
      });
    }
  });
}

const adjustmentLabel = {
  tax: "income tax",
  nic: "NIC",
  sl: "student loan",
  pen: "pension",
} satisfies Record<
  Exclude<Extract<PlanningTransactionId, { part: string }>["part"], "gross">,
  string
>;

/** Materialise a credit-card spend prediction as a real `PlanningTransactions` row so the user's edit is durable and the prediction for this month is suppressed. Amount is stored as a non-positive outflow on the liability's `billedFromAccountId`. */
async function materialiseCreditCardPrediction(
  year: number,
  date: Date,
  liabilityId: string,
  edit: {
    patchAmount: number | null;
    patchCurrency: CurrencyCode | null;
    patchName: string | null;
  },
): Promise<void> {
  const [liability] = await db
    .select()
    .from(NetWorthCategoryLiabilities)
    .where(eq(NetWorthCategoryLiabilities.id, liabilityId));
  assert(liability, `Liability ${liabilityId} not found`);
  assert(
    liability.type === "CREDIT_CARD",
    `Liability ${liabilityId} is not a credit card`,
  );
  assert(
    liability.billedFromAccountId,
    `Liability ${liabilityId} has no billedFromAccount`,
  );
  // Store whatever signed value the edit form sent — the direction toggle
  // lets the user pick +/-. Amount=0 explicitly overrides the prediction to
  // zero for this month.
  const minor = edit.patchAmount ?? 0;
  await ensurePlanningMonth(year, date);
  await db.insert(PlanningTransactions).values({
    year,
    date,
    amount: minor,
    currency: edit.patchCurrency ?? HOME_CURRENCY,
    name: edit.patchName ?? liability.name,
    accountId: liability.billedFromAccountId,
    toAccountId: null,
    liabilityId,
    assetId: null,
  });
}

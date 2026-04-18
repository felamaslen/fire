import { strict as assert } from "node:assert";

import { eq } from "drizzle-orm";
import type { ID } from "grats";
import { z } from "zod";

import { db } from "@/db";
import type { CurrencyCode } from "@/db/schema/currency";
import {
  PlanningBills,
  PlanningEarnings,
  PlanningMonthBills,
  PlanningPayslipAdjustments,
  PlanningPayslips,
  PlanningTransactions,
  PlanningYearUKTaxRates,
} from "@/db/schema/planning";

import { getMoneyInputFractionalAmount, type MoneyInput } from "../money";
import {
  ensurePlanningMonth,
  type PlanningYear,
  planningYearsForYears,
} from "./index";
import {
  monthId as monthLabel,
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
  /** Bill projection — either a predicted row or a materialised `PlanningMonthBills` override. */
  z.object({ kind: z.literal("bill"), id: z.string() }),
  /** One line from an earnings stream's predicted monthly take (gross, income-tax, NIC, or student-loan). */
  z.object({
    kind: z.literal("earn"),
    part: z.enum(["gross", "tax", "nic", "sl"]),
    id: z.string(),
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
 * Record a manual transaction on a planning month. Amount is a positive magnitude; the direction is carried by which account is `fromAccountId` (and optionally `toAccountId` for internal transfers).
 *
 * @gqlMutationField
 */
export async function transactionCreate(
  /** Planning month id, e.g. `"apr-2025"`. */
  monthId: ID,
  /** Positive magnitude. Sign is derived from which side of the transaction an account is on. */
  amount: MoneyInput,
  name: string,
  /** Planning account (`PlanningAccount.id`) the transaction is paid from. */
  fromAccountId: ID,
  /** Destination planning account (`PlanningAccount.id`) for a transfer. */
  toAccountId?: ID | null,
  /** Liability (`NetWorthCategoryLiability.id`) being paid down by this transaction, if any. */
  liabilityId?: ID | null,
): Promise<PlanningYear[]> {
  const { year, date } = monthKey(monthId);
  const { currency, amount: minor } = getMoneyInputFractionalAmount(amount);
  assert(minor >= 0, "Transaction amount must be a positive magnitude");
  await ensurePlanningMonth(year, date);
  await db.insert(PlanningTransactions).values({
    year,
    date,
    amount: minor,
    currency,
    name,
    fromAccountId,
    toAccountId: toAccountId ?? null,
    liabilityId: liabilityId ?? null,
  });
  return planningYearsForYears([year]);
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
  /** New paying planning account (`PlanningAccount.id`). Manual transactions only. */
  fromAccountId?: ID | null,
  /** New destination planning account (`PlanningAccount.id`) for a transfer. Pass null explicitly to clear. Manual transactions only. */
  toAccountId?: ID | null,
  /** New serviced liability (`NetWorthCategoryLiability.id`). Pass null explicitly to clear. Manual transactions only. */
  liabilityId?: ID | null,
): Promise<PlanningYear[]> {
  const { year, date } = monthKey(monthId);
  const parsed = decodePlanningTransactionId(id);
  const patchAmount =
    amount != null ? getMoneyInputFractionalAmount(amount) : null;

  switch (parsed.kind) {
    case "tx":
    case "to": {
      await ensurePlanningMonth(year, date);
      await db
        .update(PlanningTransactions)
        .set({
          year,
          date,
          ...(name != null && { name }),
          ...(patchAmount && {
            amount: Math.abs(patchAmount.amount),
            currency: patchAmount.currency,
          }),
          ...(fromAccountId != null && { fromAccountId }),
          ...(toAccountId !== undefined && { toAccountId }),
          ...(liabilityId !== undefined && { liabilityId }),
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
      const [existing] = await db
        .select()
        .from(PlanningPayslipAdjustments)
        .where(eq(PlanningPayslipAdjustments.id, parsed.id));
      assert(existing, `Adjustment ${parsed.id} not found`);
      const sign = existing.amount < 0 ? -1 : 1;
      await db
        .update(PlanningPayslipAdjustments)
        .set({
          ...(name != null && { name }),
          ...(patchAmount && {
            amount: sign * Math.abs(patchAmount.amount),
          }),
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
      const overrideAmount = patchAmount
        ? Math.abs(patchAmount.amount)
        : bill.amount;
      const overrideCurrency = (patchAmount?.currency ??
        bill.currency) as CurrencyCode;
      await upsertBillOverride(
        year,
        date,
        parsed.id,
        overrideAmount,
        overrideCurrency,
      );
      break;
    }
    case "earn": {
      await materialiseEarningAsPayslip(year, date, parsed, {
        patchAmount: patchAmount?.amount ?? null,
        patchName: name ?? null,
      });
      break;
    }
  }
  return planningYearsForYears([year]);
}

/**
 * Delete a transaction. For derived transactions we can't literally delete the row (it doesn't exist yet); instead we record the suppression:
 *
 * - `tx:…` / `to:…` — deletes the `PlanningTransactions` row.
 * - `pay:…` — deletes the payslip (and its adjustments, via cascade).
 * - `adj:…` — deletes the single adjustment.
 * - `bill:…` — writes a per-month bill override with null amount, which skips the bill for this month only.
 * - `earn:…` — inserts a zero-gross payslip with no adjustments, which suppresses the earnings prediction for this month.
 *
 * @gqlMutationField
 */
export async function transactionDelete(
  /** Planning month id, e.g. `"apr-2025"`. */
  monthId: ID,
  /** Composite id as returned on `PlanningTransaction.id`. */
  id: ID,
): Promise<PlanningYear[]> {
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
      await upsertBillOverride(year, date, parsed.id, null, null);
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
  }
  return planningYearsForYears([year]);
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
  const take = computeUKTake({
    gross: earning.amountGross,
    pension: {
      sacrifice: earning.pensionSalarySacrifice,
      netPay: earning.pensionNetPay,
      relief: earning.pensionReliefAtSource,
    },
    studentLoanPlan2: earning.studentLoanPlan2,
    rates,
  });
  const perMonth = (n: number) => Math.round(n / 12);

  let gross = perMonth(take.gross);
  const adjustments: {
    part: "tax" | "nic" | "sl";
    name: string;
    amount: number;
  }[] = [];
  if (take.incomeTax > 0)
    adjustments.push({
      part: "tax",
      name: "Income tax",
      amount: -perMonth(take.incomeTax),
    });
  if (take.nic > 0)
    adjustments.push({ part: "nic", name: "NIC", amount: -perMonth(take.nic) });
  if (take.studentLoan > 0)
    adjustments.push({
      part: "sl",
      name: "Student loan",
      amount: -perMonth(take.studentLoan),
    });

  if (edit.patchAmount != null) {
    const signedOverride =
      parsed.part === "gross"
        ? Math.abs(edit.patchAmount)
        : -Math.abs(edit.patchAmount);
    if (parsed.part === "gross") {
      gross = signedOverride;
    } else {
      const existing = adjustments.find((a) => a.part === parsed.part);
      if (existing) existing.amount = signedOverride;
      else
        adjustments.push({
          part: parsed.part,
          name: adjustmentLabel[parsed.part],
          amount: signedOverride,
        });
    }
  }

  const payslipName =
    edit.patchName ?? `${earning.name} — ${monthLabel(date)} (predicted)`;

  await db.transaction(async (tx) => {
    const [payslip] = await tx
      .insert(PlanningPayslips)
      .values({
        date: lastDayOfMonth(date),
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
      });
    }
  });
}

const adjustmentLabel = {
  tax: "Income tax",
  nic: "NIC",
  sl: "Student loan",
} satisfies Record<
  Exclude<Extract<PlanningTransactionId, { part: string }>["part"], "gross">,
  string
>;

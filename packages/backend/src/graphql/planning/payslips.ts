import { strict as assert } from "node:assert";

import { and, eq, notInArray } from "drizzle-orm";
import type { ID } from "grats";

import { db } from "@/db";
import {
  PlanningPayslipAdjustments,
  PlanningPayslips,
} from "@/db/schema/planning";
import { storeUpload } from "@/uploads";

import type { Date as CalendarDate } from "../date";
import { getMoneyInputFractionalAmount, type MoneyInput } from "../money";
import type { Upload } from "../upload";
import { type PlanningYear, planningYearsForYears } from "./index";
import { yearsOverlapping } from "./months";

/** A single payslip line item to attach to a payslip. Include `id` to update an existing adjustment; omit it to create a new one. @gqlInput */
export type PayslipAdjustmentInput = {
  /** Existing adjustment id to update. Omit to create a new one. */
  id?: ID | null;
  /** Signed amount. Negative = deduction. Must use the same currency as the payslip's gross. */
  amount: MoneyInput;
  name: string;
  /** Optional link to a `NetWorthCategoryLiability` this adjustment pays down (e.g. a student-loan deduction). Pass `null` to clear an existing link. */
  liabilityId?: ID | null;
};

async function writeAdjustments(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  payslipId: string,
  payslipCurrency: string,
  adjustments: PayslipAdjustmentInput[],
): Promise<void> {
  const keepIds = adjustments
    .map((a) => a.id)
    .filter((x): x is string => x != null);
  await tx
    .delete(PlanningPayslipAdjustments)
    .where(
      and(
        eq(PlanningPayslipAdjustments.payslipId, payslipId),
        keepIds.length > 0
          ? notInArray(PlanningPayslipAdjustments.id, keepIds)
          : undefined,
      ),
    );

  for (const a of adjustments) {
    const { currency, amount } = getMoneyInputFractionalAmount(a.amount);
    assert(
      currency === payslipCurrency,
      `Adjustment currency ${currency} must match payslip currency ${payslipCurrency}`,
    );
    const row = {
      payslipId,
      amount,
      name: a.name,
      liabilityId: a.liabilityId ?? null,
    };
    if (a.id) {
      await tx
        .insert(PlanningPayslipAdjustments)
        .values({ id: a.id, ...row })
        .onConflictDoUpdate({
          target: PlanningPayslipAdjustments.id,
          set: { ...row, updatedAt: new Date() },
        });
    } else {
      await tx.insert(PlanningPayslipAdjustments).values(row);
    }
  }
}

/**
 * Create a new payslip. If `file` is provided it's streamed into the local uploads bucket and its URL stored on the row.
 *
 * @gqlMutationField
 */
export async function payslipCreate(
  date: CalendarDate,
  amountGross: MoneyInput,
  name: string,
  /** Planning account (`PlanningAccount.id`) the net pay lands in. The asset must already have a planning account assigned via `planningAccountAssign`. */
  toAccountId: ID,
  adjustments?: PayslipAdjustmentInput[] | null,
  /** Multipart file upload (per graphql-multipart-request-spec). Stored in the uploads bucket; the resolved URL is persisted on the payslip row. */
  file?: Upload | null,
): Promise<PlanningYear[]> {
  const { currency, amount } = getMoneyInputFractionalAmount(amountGross);
  const fileUrl = file ? `/files/${await storeUpload(await file)}` : null;
  const row = await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(PlanningPayslips)
      .values({
        date,
        amountGross: amount,
        currency,
        name,
        toAccountId: toAccountId,
        fileUrl,
      })
      .returning();
    if (adjustments != null && adjustments.length > 0) {
      await writeAdjustments(tx, inserted.id, currency, adjustments);
    }
    return inserted;
  });
  return planningYearsForYears(yearsOverlapping(row.date, row.date));
}

/**
 * Partially update an existing payslip. Only fields passed in are changed. Passing `adjustments` replaces the full set of line items (rows not listed are deleted; entries with an `id` are upserted).
 *
 * @gqlMutationField
 */
export async function payslipUpdate(
  id: ID,
  date?: CalendarDate | null,
  amountGross?: MoneyInput | null,
  name?: string | null,
  /** New destination planning account (`PlanningAccount.id`) the net pay lands in. */
  toAccountId?: ID | null,
  adjustments?: PayslipAdjustmentInput[] | null,
  /** Replacement file upload. Pass `null` explicitly to clear the existing fileUrl; omit to leave it unchanged. */
  file?: Upload | null,
): Promise<PlanningYear[]> {
  const [existing] = await db
    .select()
    .from(PlanningPayslips)
    .where(eq(PlanningPayslips.id, id));
  assert(existing, `Payslip ${id} not found`);

  const moneyPatch =
    amountGross != null ? getMoneyInputFractionalAmount(amountGross) : null;
  const effectiveCurrency = moneyPatch?.currency ?? existing.currency;

  let fileUrlPatch: { fileUrl: string | null } | null = null;
  if (file !== undefined) {
    fileUrlPatch = {
      fileUrl: file ? `/files/${await storeUpload(await file)}` : null,
    };
  }

  const row = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(PlanningPayslips)
      .set({
        ...(date != null && { date }),
        ...(moneyPatch && {
          amountGross: moneyPatch.amount,
          currency: moneyPatch.currency,
        }),
        ...(name != null && { name }),
        ...(toAccountId != null && { toAccountId: toAccountId }),
        ...(fileUrlPatch ?? {}),
        updatedAt: new Date(),
      })
      .where(eq(PlanningPayslips.id, id))
      .returning();
    if (adjustments != null) {
      await writeAdjustments(tx, id, effectiveCurrency, adjustments);
    }
    return updated;
  });

  const affected = new Set<number>([
    ...yearsOverlapping(existing.date, existing.date),
    ...yearsOverlapping(row.date, row.date),
  ]);
  return planningYearsForYears([...affected]);
}

/**
 * Delete a payslip. Adjustments are removed via cascade.
 *
 * @gqlMutationField
 */
export async function payslipDelete(id: ID): Promise<PlanningYear[]> {
  const [row] = await db
    .delete(PlanningPayslips)
    .where(eq(PlanningPayslips.id, id))
    .returning();
  if (!row) return [];
  return planningYearsForYears(yearsOverlapping(row.date, row.date));
}

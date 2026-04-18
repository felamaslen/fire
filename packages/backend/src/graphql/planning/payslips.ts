import { strict as assert } from "node:assert";

import { and, desc, eq, lt, notInArray, or } from "drizzle-orm";
import type { ID, Int } from "grats";

import { db } from "@/db";
import {
  NetWorthCategoryAssets,
  NetWorthCategoryLiabilities,
} from "@/db/schema/net-worth";
import {
  PlanningAccounts,
  PlanningPayslipAdjustments,
  PlanningPayslips,
} from "@/db/schema/planning";
import { storeUpload } from "@/uploads";

import type { Date as CalendarDate } from "../date";
import { Money } from "../money";
import { getMoneyInputFractionalAmount, type MoneyInput } from "../money";
import {
  NetWorthCategoryAsset,
  NetWorthCategoryLiability,
} from "../net-worth/categories";
import {
  buildConnection,
  type Connection,
  decodeCursor,
  encodeCursor,
} from "../pagination";
import type { Upload } from "../upload";
import { VOID, type Void } from "../void";
import { PlanningAccount } from "./index";

/** A recorded pay-period snapshot: the gross amount plus zero or more adjustments (tax, NIC, student loan, …). Payslips suppress earnings projections for the same month+account. @gqlType */
export class PlanningPayslip {
  constructor(
    /** @gqlField */
    public readonly id: ID,
    /** Pay date. @gqlField */
    public readonly date: CalendarDate,
    /** Gross pay for this pay period. @gqlField */
    public readonly amountGross: Money,
    /** @gqlField */
    public readonly name: string,
    /** Path to the uploaded payslip file (PDF / image), relative to the server. Null if none was uploaded. @gqlField */
    public readonly fileUrl: string | null,
    public readonly toAccountId: string,
    private readonly currency: string,
  ) {}

  static load(row: typeof PlanningPayslips.$inferSelect): PlanningPayslip {
    return new PlanningPayslip(
      row.id as ID,
      row.date,
      Money.fromMinorDenomination(row.amountGross, row.currency),
      row.name,
      row.fileUrl,
      row.toAccountId,
      row.currency,
    );
  }

  /** Planning account the net pay lands in. @gqlField */
  async toAccount(): Promise<PlanningAccount> {
    const [row] = await db
      .select({
        assetId: PlanningAccounts.accountId,
        alias: PlanningAccounts.alias,
        asset: NetWorthCategoryAssets,
      })
      .from(PlanningAccounts)
      .innerJoin(
        NetWorthCategoryAssets,
        eq(PlanningAccounts.accountId, NetWorthCategoryAssets.id),
      )
      .where(eq(PlanningAccounts.accountId, this.toAccountId));
    assert(
      row,
      `PlanningAccount for asset ${this.toAccountId} referenced by PlanningPayslip ${this.id} is missing — assign it via planningAccountAssign first.`,
    );
    return new PlanningAccount({
      assetId: row.assetId,
      alias: row.alias,
      asset: NetWorthCategoryAsset.load(row.asset),
    });
  }

  /** Line items on this payslip (tax / NIC / student-loan / any custom). Signed; negative = deduction. @gqlField */
  async adjustments(): Promise<PlanningPayslipAdjustment[]> {
    const rows = await db
      .select()
      .from(PlanningPayslipAdjustments)
      .where(eq(PlanningPayslipAdjustments.payslipId, this.id));
    return rows.map((r) => PlanningPayslipAdjustment.load(r, this.currency));
  }
}

/** A single line item on a PlanningPayslip. Currency matches the parent payslip. @gqlType */
export class PlanningPayslipAdjustment {
  constructor(
    /** @gqlField */
    public readonly id: ID,
    /** @gqlField */
    public readonly name: string,
    /** Signed amount. Negative = deduction. @gqlField */
    public readonly amount: Money,
    private readonly liabilityId: string | null,
  ) {}

  static load(
    row: typeof PlanningPayslipAdjustments.$inferSelect,
    currency: string,
  ): PlanningPayslipAdjustment {
    return new PlanningPayslipAdjustment(
      row.id as ID,
      row.name,
      Money.fromMinorDenomination(row.amount, currency),
      row.liabilityId,
    );
  }

  /** Liability this adjustment pays down, if any (e.g. a student-loan deduction). @gqlField */
  async liability(): Promise<NetWorthCategoryLiability | null> {
    if (!this.liabilityId) return null;
    const [row] = await db
      .select()
      .from(NetWorthCategoryLiabilities)
      .where(eq(NetWorthCategoryLiabilities.id, this.liabilityId));
    return row ? NetWorthCategoryLiability.load(row) : null;
  }
}

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
): Promise<PlanningPayslip> {
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
  return PlanningPayslip.load(row);
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
): Promise<PlanningPayslip> {
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
  return PlanningPayslip.load(row);
}

/**
 * Delete a payslip. Adjustments are removed via cascade.
 *
 * @gqlMutationField
 */
export async function payslipDelete(id: ID): Promise<Void> {
  await db.delete(PlanningPayslips).where(eq(PlanningPayslips.id, id));
  return VOID;
}

const PAYSLIPS_DEFAULT_PAGE_SIZE = 20;

/**
 * Every recorded payslip, paginated and sorted by pay date descending (most-recent first, `id` tiebreak).
 *
 * @gqlQueryField
 * @gqlAnnotate semanticNonNull
 */
export async function payslips(
  first?: Int | null,
  after?: ID | null,
): Promise<Connection<PlanningPayslip> | null> {
  const limit = first ?? PAYSLIPS_DEFAULT_PAGE_SIZE;
  const cursor = after ? decodeCursor(after) : null;

  const cursorWhere = cursor
    ? or(
        lt(PlanningPayslips.date, new Date(cursor.c)),
        and(
          eq(PlanningPayslips.date, new Date(cursor.c)),
          lt(PlanningPayslips.id, cursor.i),
        ),
      )
    : undefined;

  const rows = await db
    .select()
    .from(PlanningPayslips)
    .where(cursorWhere)
    .orderBy(desc(PlanningPayslips.date), desc(PlanningPayslips.id))
    .limit(limit + 1);

  const hasExtra = rows.length > limit;
  const page = hasExtra ? rows.slice(0, limit) : rows;

  const dateById = new Map(page.map((r) => [r.id, r.date]));
  return buildConnection<PlanningPayslip>(
    page.map((r) => PlanningPayslip.load(r)),
    (node) => encodeCursor(dateById.get(node.id)!.toISOString(), node.id),
    { hasNextPage: hasExtra, hasPreviousPage: cursor != null },
  );
}

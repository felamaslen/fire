import { strict as assert } from "node:assert";

import DataLoader from "dataloader";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  lt,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import type { ID, Int } from "grats";

import { sessionMayReadKey, signFileUrl } from "@/auth/file-url";
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

import { type Context, contextAwareDataLoader } from "../context";
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

/** Legacy rows stored `/files/<key>`; strip the prefix so downstream code sees a bare storage key. */
export function storageKeyFromColumn(value: string): string {
  return value.startsWith("/files/") ? value.slice("/files/".length) : value;
}

/** Per-request batched loader for `PlanningPayslip.adjustments` (and the resolvers derived from it: `amountGrossAdjusted`, `amountNet`). One SQL fetches every adjustment row for the requested payslip ids; the result map is then sliced per payslip in memory. Lifts the previous per-payslip query out of an N+1. */
const adjustmentsLoader = contextAwareDataLoader(
  () =>
    new DataLoader<string, (typeof PlanningPayslipAdjustments.$inferSelect)[]>(
      async (payslipIds) => {
        const ids = [...payslipIds];
        const rows = await db
          .select()
          .from(PlanningPayslipAdjustments)
          .where(inArray(PlanningPayslipAdjustments.payslipId, ids));
        const byPayslip = new Map<
          string,
          (typeof PlanningPayslipAdjustments.$inferSelect)[]
        >();
        for (const r of rows) {
          let bucket = byPayslip.get(r.payslipId);
          if (!bucket) {
            bucket = [];
            byPayslip.set(r.payslipId, bucket);
          }
          bucket.push(r);
        }
        return ids.map((id) => byPayslip.get(id) ?? []);
      },
    ),
);

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
    /** Bare storage key for the uploaded payslip file, or `null` if none. The `fileUrl` GraphQL field wraps this in a short-lived signed URL per request. */
    private readonly fileKey: string | null,
    public readonly toAccountId: string,
    private readonly currency: string,
    /** Gross in minor units; kept so resolvers that combine with adjustments (also stored minor) don't have to round-trip through `Money.amount` (major-unit `Float`). */
    private readonly amountGrossMinor: number,
  ) {}

  static load(row: typeof PlanningPayslips.$inferSelect): PlanningPayslip {
    return new PlanningPayslip(
      row.id as ID,
      row.date,
      Money.fromMinorDenomination(row.amountGross, row.currency),
      row.name,
      row.fileUrl ? storageKeyFromColumn(row.fileUrl) : null,
      row.toAccountId,
      row.currency,
      row.amountGross,
    );
  }

  /** Signed, short-lived URL to the uploaded payslip file (PDF / image), or `null` if none was uploaded or the current session isn't allowed to read it. The URL's signature covers the storage key + expiry so the `/files/*` endpoint can serve it without the browser attaching an `Authorization` header. @gqlField */
  fileUrl(ctx: Context): string | null {
    if (!this.fileKey) return null;
    if (!sessionMayReadKey(ctx.session, this.fileKey)) return null;
    return signFileUrl(this.fileKey);
  }

  /** Planning account the net pay lands in. @gqlField */
  async toAccount(): Promise<PlanningAccount> {
    const [row] = await db
      .select({
        account: PlanningAccounts,
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
    return PlanningAccount.load({
      assetId: row.account.accountId,
      alias: row.account.alias,
      asset: NetWorthCategoryAsset.load(row.asset),
      target: row.account.target,
      targetCurrency: row.account.currency,
    });
  }

  /** Line items on this payslip (tax / NIC / student-loan / any custom). Signed; negative = deduction. @gqlField */
  async adjustments(ctx: Context): Promise<PlanningPayslipAdjustment[]> {
    const rows = await adjustmentsLoader(ctx).load(this.id);
    return rows.map((r) => PlanningPayslipAdjustment.load(r, this.currency));
  }

  /** Gross plus the sum of any positive adjustments (bonuses, employer top-ups, …). Deductions are excluded. Equals `amountGross` when there are no positive adjustments. @gqlField */
  async amountGrossAdjusted(ctx: Context): Promise<Money> {
    const rows = await adjustmentsLoader(ctx).load(this.id);
    const positiveSum = rows.reduce(
      (sum, r) => sum + (r.amount > 0 ? r.amount : 0),
      0,
    );
    return Money.fromMinorDenomination(
      this.amountGrossMinor + positiveSum,
      this.currency,
    );
  }

  /** Take-home pay: gross plus the signed sum of every adjustment (deductions and additions). @gqlField */
  async amountNet(ctx: Context): Promise<Money> {
    const rows = await adjustmentsLoader(ctx).load(this.id);
    const signedSum = rows.reduce((sum, r) => sum + r.amount, 0);
    return Money.fromMinorDenomination(
      this.amountGrossMinor + signedSum,
      this.currency,
    );
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
  adjustments: PayslipAdjustmentInput[] | null | undefined,
  /** Multipart file upload (per graphql-multipart-request-spec). Stored in the uploads bucket, scoped to the caller's session; the resolved key is persisted on the payslip row. */
  file: Upload | null | undefined,
  ctx: Context,
): Promise<PlanningPayslip> {
  const { currency, amount } = getMoneyInputFractionalAmount(amountGross);
  const fileUrl = file ? await storeUpload(await file, ctx.session) : null;
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
  date: CalendarDate | null | undefined,
  amountGross: MoneyInput | null | undefined,
  name: string | null | undefined,
  /** New destination planning account (`PlanningAccount.id`) the net pay lands in. */
  toAccountId: ID | null | undefined,
  adjustments: PayslipAdjustmentInput[] | null | undefined,
  /** Replacement file upload. Pass `null` explicitly to clear the existing fileUrl; omit to leave it unchanged. */
  file: Upload | null | undefined,
  ctx: Context,
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
      fileUrl: file ? await storeUpload(await file, ctx.session) : null,
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

/** One calendar-month bucket of payslips inside a `payslipsByYear` result. The list always contains exactly 12 buckets (`month` 1-12) regardless of activity, so the UI can render a fixed-height grid with empty months shown as placeholders. @gqlType */
export class PayslipsByYearMonth {
  constructor(
    /** Calendar month, 1-12. @gqlField */
    public readonly month: Int,
    /** Payslips paid in this month, ordered by destination account display name (alias or underlying asset name), then `id`. @gqlField */
    public readonly payslips: PlanningPayslip[],
  ) {}
}

/**
 * Every payslip paid inside calendar `year`, pre-grouped into 12 month buckets so the result is suitable for a fixed-height grid view. Each bucket's payslips are ordered by destination account display name; empty months come back with an empty list rather than being omitted.
 *
 * @gqlQueryField
 * @gqlAnnotate semanticNonNull
 */
export async function payslipsByYear(
  /** Calendar year (e.g. 2026). */
  year: Int,
): Promise<PayslipsByYearMonth[] | null> {
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const yearEnd = new Date(Date.UTC(year + 1, 0, 1));

  const rows = await db
    .select({ payslip: PlanningPayslips })
    .from(PlanningPayslips)
    .innerJoin(
      PlanningAccounts,
      eq(PlanningPayslips.toAccountId, PlanningAccounts.accountId),
    )
    .innerJoin(
      NetWorthCategoryAssets,
      eq(PlanningAccounts.accountId, NetWorthCategoryAssets.id),
    )
    .where(
      and(
        gte(PlanningPayslips.date, yearStart),
        lt(PlanningPayslips.date, yearEnd),
      ),
    )
    .orderBy(
      asc(
        sql`coalesce(${PlanningAccounts.alias}, ${NetWorthCategoryAssets.name})`,
      ),
      asc(PlanningPayslips.id),
    );

  const buckets: PlanningPayslip[][] = Array.from({ length: 12 }, () => []);
  for (const { payslip } of rows) {
    const m = payslip.date.getUTCMonth();
    buckets[m].push(PlanningPayslip.load(payslip));
  }
  return buckets.map(
    (payslips, i) => new PayslipsByYearMonth((i + 1) as Int, payslips),
  );
}

import { strict as assert } from "node:assert";

import { and, desc, eq, lt, or } from "drizzle-orm";
import type { ID, Int } from "grats";

import { db } from "@/db";
import {
  NetWorthCategoryAssets,
  NetWorthCategoryLiabilities,
} from "@/db/schema/net-worth";
import { PlanningAccounts, PlanningBills } from "@/db/schema/planning";
import { UnreachableCaseError } from "@/errors";

import type { Date as CalendarDate } from "../date";
import {
  getMoneyInputFractionalAmount,
  Money,
  type MoneyInput,
} from "../money";
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
import { VOID, type Void } from "../void";
import { PlanningAccount } from "./index";

/** How often a `PlanningBill` recurs. @gqlEnum */
export type PlanningBillsFrequency = "MONTHLY" | "QUARTERLY" | "YEARLY";

/** A recurring bill that projects forward into future months' balances as a provisional outgoing transaction until an actual transaction is recorded for that month. @gqlType */
export class PlanningBill {
  constructor(
    /** @gqlField */
    public readonly id: ID,
    /** First day the bill is in effect. @gqlField */
    public readonly start: CalendarDate,
    /** Last day the bill is in effect; null if ongoing. @gqlField */
    public readonly end: CalendarDate | null,
    /** @gqlField */
    public readonly frequency: PlanningBillsFrequency,
    /** In-year occurrences, one `M-D` entry each (MONTHLY uses a bare day, no month prefix). See `billCreate` for the encoding. @gqlField */
    public readonly collectionDate: string[],
    /** Amount charged per occurrence. @gqlField */
    public readonly amount: Money,
    /** @gqlField */
    public readonly name: string,
    public readonly fromAccountId: string,
    private readonly liabilityId: string | null,
  ) {}

  static load(row: typeof PlanningBills.$inferSelect): PlanningBill {
    return new PlanningBill(
      row.id as ID,
      row.start,
      row.end,
      row.frequency,
      decodeCollectionDate(row.frequency, row.collectionDate),
      Money.fromMinorDenomination(row.amount, row.currency),
      row.name,
      row.fromAccountId,
      row.liabilityId,
    );
  }

  /** Liability this bill services — e.g. a credit-card paid off by a monthly direct debit, or a mortgage principal. Null if the bill isn't tied to a liability. @gqlField */
  async liability(): Promise<NetWorthCategoryLiability | null> {
    if (!this.liabilityId) return null;
    const [row] = await db
      .select()
      .from(NetWorthCategoryLiabilities)
      .where(eq(NetWorthCategoryLiabilities.id, this.liabilityId));
    return row ? NetWorthCategoryLiability.load(row) : null;
  }

  /** Planning account (asset + alias) the bill is paid from. @gqlField */
  async fromAccount(): Promise<PlanningAccount> {
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
      .where(eq(PlanningAccounts.accountId, this.fromAccountId));
    assert(
      row,
      `PlanningAccount for asset ${this.fromAccountId} referenced by PlanningBill ${this.id} is missing — assign it via planningAccountAssign first.`,
    );
    return new PlanningAccount({
      assetId: row.assetId,
      alias: row.alias,
      asset: NetWorthCategoryAsset.load(row.asset),
    });
  }
}

/** Assert the right number and per-entry shape for the given frequency: MONTHLY takes one bare day `D`; QUARTERLY takes four `M-D`; YEARLY takes one `M-D`. Digit-range validity is enforced by the `@constraint` directive before this runs. */
function assertCollectionDateShape(
  frequency: PlanningBillsFrequency,
  collectionDate: string[],
): void {
  const expected = frequency === "QUARTERLY" ? 4 : 1;
  assert(
    collectionDate.length === expected,
    `${frequency} collectionDate must have ${expected} entr${expected === 1 ? "y" : "ies"}, got ${collectionDate.length}.`,
  );
  const requiresMonth = frequency !== "MONTHLY";
  for (const entry of collectionDate) {
    const hasMonth = entry.includes("-");
    assert(
      requiresMonth === hasMonth,
      requiresMonth
        ? `${frequency} collectionDate entries must be in "M-D" form, got "${entry}".`
        : `MONTHLY collectionDate entries must be a bare day with no month, got "${entry}".`,
    );
  }
}

/** Map the GraphQL `string[]` form to the DB-native encoding stored in `PlanningBills.collectionDate`. MONTHLY keeps a single bare day (`"15"`); QUARTERLY joins with `", "`; YEARLY passes through the single `M-D` entry. */
function encodeCollectionDate(
  frequency: PlanningBillsFrequency,
  collectionDate: string[],
): string {
  switch (frequency) {
    case "MONTHLY":
      return collectionDate[0];
    case "YEARLY":
      return collectionDate[0];
    case "QUARTERLY":
      return collectionDate.join(", ");
    default:
      throw new UnreachableCaseError(frequency);
  }
}

/** Inverse of `encodeCollectionDate`. */
function decodeCollectionDate(
  frequency: PlanningBillsFrequency,
  stored: string,
): string[] {
  switch (frequency) {
    case "MONTHLY":
      return [stored];
    case "YEARLY":
      return [stored];
    case "QUARTERLY":
      return stored.split(/,\s*/);
    default:
      throw new UnreachableCaseError(frequency);
  }
}

/**
 * Register a recurring bill (subscription, utility, rent, mortgage direct debit, credit-card statement, …) that should project forward into future months' balances as a provisional outgoing transaction. Every month the bill's cadence fires, the planner deducts `amount` from the `fromAccountId`'s projected balance; once an actual transaction is recorded against that month the provisional figure is replaced.
 *
 * @gqlMutationField
 */
export async function billCreate(
  /** First day the bill is in effect. */
  start: CalendarDate,
  frequency: PlanningBillsFrequency,
  /**
   * One `M-D` entry per in-year occurrence (`M` omitted for MONTHLY). Shape per frequency: MONTHLY → one bare day (e.g. `["15"]`); QUARTERLY → four `M-D` entries (e.g. `["4-01", "7-01", "10-01", "1-01"]`); YEARLY → one `M-D` entry (e.g. `["4-06"]`).
   * @gqlAnnotate constraint(pattern: "^(\\d{1,2}-)?\\d{1,2}$")
   */
  collectionDate: string[],
  /** Amount charged per occurrence. Currency must match the asset account. */
  amount: MoneyInput,
  /** Human-readable label, e.g. "Broadband", "Council tax". */
  name: string,
  /** Planning account (`PlanningAccount.id`) the bill is paid from. The asset must already have a planning account assigned via `planningAccountAssign`. */
  fromAccountId: ID,
  /** The liability (`NetWorthCategoryLiability.id`) this bill services, if any — e.g. a credit-card liability paid off by a monthly direct debit, or a mortgage principal. Paying the bill reduces the liability's outstanding balance. */
  liabilityId?: ID | null,
  /** Last day the bill is in effect; null / omitted for ongoing. */
  end?: CalendarDate | null,
): Promise<PlanningBill> {
  assertCollectionDateShape(frequency, collectionDate);
  const { currency, amount: minor } = getMoneyInputFractionalAmount(amount);
  const [row] = await db
    .insert(PlanningBills)
    .values({
      start,
      end: end ?? null,
      frequency,
      collectionDate: encodeCollectionDate(frequency, collectionDate),
      amount: minor,
      currency,
      name,
      fromAccountId,
      liabilityId: liabilityId ?? null,
    })
    .returning();
  return PlanningBill.load(row);
}

/**
 * Partially update an existing bill. Only fields passed in are changed — omit a field to leave it untouched. The projected-transaction stream for every affected month is recomputed from the new values; months that already had actual transactions recorded keep those and simply use the new bill as a fallback where no actual exists.
 *
 * @gqlMutationField
 */
export async function billUpdate(
  id: ID,
  /** New first day in effect. */
  start?: CalendarDate | null,
  /** New recurrence cadence. */
  frequency?: PlanningBillsFrequency | null,
  /**
   * New collection-day entries — see `billCreate` for the format per frequency.
   * @gqlAnnotate constraint(pattern: "^(\\d{1,2}-)?\\d{1,2}$")
   */
  collectionDate?: string[] | null,
  /** New amount per occurrence. Currency must match the asset account. */
  amount?: MoneyInput | null,
  /** New label. */
  name?: string | null,
  /** New paying planning account (`PlanningAccount.id`). */
  fromAccountId?: ID | null,
  /** New serviced liability (`NetWorthCategoryLiability.id`) — e.g. swap from a credit-card to a mortgage. Pass null explicitly to unset. */
  liabilityId?: ID | null,
  /** New last day in effect; pass null explicitly to mark ongoing. */
  end?: CalendarDate | null,
): Promise<PlanningBill> {
  const [existing] = await db
    .select()
    .from(PlanningBills)
    .where(eq(PlanningBills.id, id));
  assert(existing, `Bill ${id} not found`);

  const nextFrequency = frequency ?? existing.frequency;
  let encodedCollectionDate: string | undefined;
  if (collectionDate != null) {
    assertCollectionDateShape(nextFrequency, collectionDate);
    encodedCollectionDate = encodeCollectionDate(nextFrequency, collectionDate);
  }

  const moneyPatch =
    amount != null ? getMoneyInputFractionalAmount(amount) : null;

  const [row] = await db
    .update(PlanningBills)
    .set({
      ...(start != null && { start }),
      ...(end !== undefined && { end }),
      ...(frequency != null && { frequency }),
      ...(encodedCollectionDate !== undefined && {
        collectionDate: encodedCollectionDate,
      }),
      ...(moneyPatch && {
        amount: moneyPatch.amount,
        currency: moneyPatch.currency,
      }),
      ...(name != null && { name }),
      ...(fromAccountId != null && { fromAccountId: fromAccountId }),
      ...(liabilityId !== undefined && { liabilityId }),
      updatedAt: new Date(),
    })
    .where(eq(PlanningBills.id, id))
    .returning();
  return PlanningBill.load(row);
}

/**
 * Delete a bill and every projection derived from it. Any actual transactions that had been recorded against this bill's months (via `PlanningMonthBills` overrides) are removed too, since they no longer have a parent bill. Use this when a subscription is cancelled or a mortgage is paid off.
 *
 * @gqlMutationField
 */
export async function billDelete(id: ID): Promise<Void> {
  await db.delete(PlanningBills).where(eq(PlanningBills.id, id));
  return VOID;
}

const DEFAULT_PAGE_SIZE = 20;

/**
 * Every registered bill, paginated and sorted by `start` descending (most-recently-starting first, `id` tiebreak).
 *
 * @gqlQueryField
 * @gqlAnnotate semanticNonNull
 */
export async function bills(
  first?: Int | null,
  after?: ID | null,
): Promise<Connection<PlanningBill> | null> {
  const limit = first ?? DEFAULT_PAGE_SIZE;
  const cursor = after ? decodeCursor(after) : null;

  const cursorWhere = cursor
    ? or(
        lt(PlanningBills.start, new Date(cursor.c)),
        and(
          eq(PlanningBills.start, new Date(cursor.c)),
          lt(PlanningBills.id, cursor.i),
        ),
      )
    : undefined;

  const rows = await db
    .select()
    .from(PlanningBills)
    .where(cursorWhere)
    .orderBy(desc(PlanningBills.start), desc(PlanningBills.id))
    .limit(limit + 1);

  const hasExtra = rows.length > limit;
  const page = hasExtra ? rows.slice(0, limit) : rows;

  const startByNode = new Map(page.map((row) => [row.id, row.start]));
  return buildConnection<PlanningBill>(
    page.map((row) => PlanningBill.load(row)),
    (node) => encodeCursor(startByNode.get(node.id)!.toISOString(), node.id),
    { hasNextPage: hasExtra, hasPreviousPage: cursor != null },
  );
}

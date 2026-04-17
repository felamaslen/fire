import { strict as assert } from "node:assert";

import { eq } from "drizzle-orm";
import type { ID } from "grats";

import { db } from "@/db";
import { PlanningBills } from "@/db/schema/planning";

import type { Date as CalendarDate } from "../date";
import { getMoneyInputFractionalAmount, type MoneyInput } from "../money";
import { type PlanningYear, planningYearsForYears } from "./index";
import { yearsOverlapping } from "./months";

/** How often a `PlanningBill` recurs. @gqlEnum */
export type PlanningBillsFrequency = "MONTHLY" | "QUARTERLY" | "YEARLY";

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
  if (frequency === "MONTHLY") return collectionDate[0];
  return collectionDate.join(", ");
}

/**
 * Register a recurring bill (subscription, utility, rent, mortgage direct debit, credit-card statement, …) that should project forward into future months' balances as a provisional outgoing transaction. Every month the bill's cadence fires, the planner deducts `amount` from the `accountIdFrom`'s projected balance; once an actual transaction is recorded against that month the provisional figure is replaced.
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
  /** Asset account (`NetWorthCategoryAsset.id`) the bill is paid from. */
  accountIdFrom: ID,
  /** Liability (`NetWorthCategoryLiability.id`) this bill services, if any — e.g. a credit-card liability paid off by a monthly direct debit, or a mortgage principal. Paying the bill reduces the liability's outstanding balance. */
  liabilityId?: ID | null,
  /** Last day the bill is in effect; null / omitted for ongoing. */
  end?: CalendarDate | null,
): Promise<PlanningYear[]> {
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
      accountIdFrom,
      liabilityId: liabilityId ?? null,
    })
    .returning();
  return planningYearsForYears(yearsOverlapping(row.start, row.end));
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
  /** New paying asset account (`NetWorthCategoryAsset.id`). */
  accountIdFrom?: ID | null,
  /** New serviced liability (`NetWorthCategoryLiability.id`) — e.g. swap from a credit-card to a mortgage. Pass null explicitly to unset. */
  liabilityId?: ID | null,
  /** New last day in effect; pass null explicitly to mark ongoing. */
  end?: CalendarDate | null,
): Promise<PlanningYear[]> {
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
      ...(accountIdFrom != null && { accountIdFrom }),
      ...(liabilityId !== undefined && { liabilityId }),
      updatedAt: new Date(),
    })
    .where(eq(PlanningBills.id, id))
    .returning();

  const affectedYears = new Set<number>([
    ...yearsOverlapping(existing.start, existing.end),
    ...yearsOverlapping(row.start, row.end),
  ]);
  return planningYearsForYears([...affectedYears]);
}

/**
 * Delete a bill and every projection derived from it. Any actual transactions that had been recorded against this bill's months (via `PlanningMonthBills` overrides) are removed too, since they no longer have a parent bill. Use this when a subscription is cancelled or a mortgage is paid off.
 *
 * @gqlMutationField
 */
export async function billDelete(id: ID): Promise<PlanningYear[]> {
  const [row] = await db
    .delete(PlanningBills)
    .where(eq(PlanningBills.id, id))
    .returning();
  if (!row) return [];
  return planningYearsForYears(yearsOverlapping(row.start, row.end));
}

import { strict as assert } from "node:assert";

import { and, asc, desc, eq, lt, or } from "drizzle-orm";
import type { Float, ID, Int } from "grats";

import { db } from "@/db";
import { assertCountryCode } from "@/db/schema/country";
import { NetWorthCategoryAssets } from "@/db/schema/net-worth";
import {
  PlanningAccounts,
  PlanningEarnings,
  PlanningEarningsUKTaxCodes,
} from "@/db/schema/planning";

import type { Date as CalendarDate } from "../date";
import {
  getMoneyInputFractionalAmount,
  Money,
  type MoneyInput,
} from "../money";
import { NetWorthCategoryAsset } from "../net-worth/categories";
import type { PageInfo } from "../net-worth/index";
import { decodeCursor, encodeCursor } from "../pagination";
import {
  PlanningAccount,
  type PlanningYear,
  planningYearsForYears,
} from "./index";
import { yearsOverlapping } from "./months";

/** A stream of gross earnings (salary, contract income, …) paid into a specific asset account. @gqlType */
export class PlanningEarning {
  constructor(
    /** @gqlField */
    public readonly id: ID,
    /** @gqlField */
    public readonly name: string,
    /** @gqlField */
    public readonly start: CalendarDate,
    /** @gqlField */
    public readonly end: CalendarDate | null,
    /** @gqlField */
    public readonly amountGross: Money,
    /** ISO-3166-1 alpha-2 country where the earnings are taxed. @gqlField */
    public readonly countryCode: string,
    /** Human-readable summary of the earning's pension and student-loan attributes, comma-joined (e.g. `"5% salary sacrifice, 3% net pay pension, student loan plan 2"`). Empty string if none apply. @gqlField */
    public readonly attributes: string,
    public readonly accountIdTo: string,
  ) {}

  static load(row: typeof PlanningEarnings.$inferSelect): PlanningEarning {
    return new PlanningEarning(
      row.id as ID,
      row.name,
      row.start,
      row.end,
      Money.fromMinorDenomination(row.amountGross, row.currency),
      row.countryCode,
      formatAttributes({
        pensionSalarySacrifice: row.pensionSalarySacrifice,
        pensionNetPay: row.pensionNetPay,
        pensionReliefAtSource: row.pensionReliefAtSource,
        studentLoanPlan2: row.studentLoanPlan2,
      }),
      row.accountIdTo,
    );
  }

  /** Destination planning account for the net earnings. @gqlField */
  async accountTo(): Promise<PlanningAccount> {
    const [row] = await db
      .select({
        accountId: PlanningAccounts.accountId,
        alias: PlanningAccounts.alias,
        asset: NetWorthCategoryAssets,
      })
      .from(PlanningAccounts)
      .innerJoin(
        NetWorthCategoryAssets,
        eq(PlanningAccounts.accountId, NetWorthCategoryAssets.id),
      )
      .where(eq(PlanningAccounts.accountId, this.accountIdTo));
    assert(
      row,
      `PlanningAccount for asset ${this.accountIdTo} referenced by PlanningEarning ${this.id} is missing — assign it via planningAccountAssign first.`,
    );
    return new PlanningAccount({
      assetId: row.accountId,
      alias: row.alias,
      asset: NetWorthCategoryAsset.load(row.asset),
    });
  }

  /** Tax codes applied to this earnings stream over time. Used when projecting predicted withholding. @gqlField */
  async ukTaxCodes(): Promise<PlanningEarningUKTaxCode[]> {
    const rows = await db
      .select()
      .from(PlanningEarningsUKTaxCodes)
      .where(eq(PlanningEarningsUKTaxCodes.earningsId, this.id))
      .orderBy(asc(PlanningEarningsUKTaxCodes.start));
    return rows.map((r) => PlanningEarningUKTaxCode.load(r));
  }
}

function formatAttributes(p: {
  pensionSalarySacrifice: number | null;
  pensionNetPay: number;
  pensionReliefAtSource: number;
  studentLoanPlan2: boolean;
}): string {
  const parts: string[] = [];
  const pct = (f: number): string => `${Math.round(f * 100)}%`;
  if (p.pensionSalarySacrifice && p.pensionSalarySacrifice > 0) {
    parts.push(`${pct(p.pensionSalarySacrifice)} salary sacrifice`);
  }
  if (p.pensionNetPay > 0) {
    parts.push(`${pct(p.pensionNetPay)} net pay pension`);
  }
  if (p.pensionReliefAtSource > 0) {
    parts.push(`${pct(p.pensionReliefAtSource)} relief-at-source pension`);
  }
  if (p.studentLoanPlan2) parts.push("student loan plan 2");
  return parts.join(", ");
}

/** An edge within a `PlanningEarningConnection`. @gqlType */
export type PlanningEarningEdge = {
  /** @gqlField */
  cursor: ID;
  /** @gqlField */
  node: PlanningEarning;
};

/** A cursor-paginated list of `PlanningEarning`, newest-`start` first. @gqlType */
export type PlanningEarningConnection = {
  /** @gqlField */
  edges: PlanningEarningEdge[];
  /** @gqlField */
  pageInfo: PageInfo;
};

/** A UK tax code active on a `PlanningEarning` over a date range. Has no `id` on purpose: keyed by (earnings, start), so cache libraries should invalidate the parent `PlanningEarning` when entries change rather than try to normalise these rows individually. @gqlType */
export class PlanningEarningUKTaxCode {
  constructor(
    /** @gqlField */
    public readonly start: CalendarDate,
    /** Last day the code applies (inclusive); null while ongoing. @gqlField */
    public readonly end: CalendarDate | null,
    /** HMRC tax code (e.g. `1257L`, `3420X`). @gqlField */
    public readonly taxCode: string,
  ) {}

  static load(
    row: typeof PlanningEarningsUKTaxCodes.$inferSelect,
  ): PlanningEarningUKTaxCode {
    return new PlanningEarningUKTaxCode(row.start, row.end, row.taxCode);
  }
}

/** A tax-code entry to attach to a PlanningEarning. Rows are upserted by (earnings, start) — re-supplying the same `start` overwrites the previous code/end. @gqlInput */
export type PlanningEarningUKTaxCodeInput = {
  start: CalendarDate;
  end?: CalendarDate | null;
  taxCode: string;
};

async function writeTaxCodes(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  earningsId: string,
  codes: PlanningEarningUKTaxCodeInput[],
): Promise<void> {
  await tx
    .delete(PlanningEarningsUKTaxCodes)
    .where(eq(PlanningEarningsUKTaxCodes.earningsId, earningsId));
  if (codes.length === 0) return;
  await tx.insert(PlanningEarningsUKTaxCodes).values(
    codes.map((c) => ({
      earningsId,
      start: c.start,
      end: c.end ?? null,
      taxCode: c.taxCode,
    })),
  );
}

/**
 * Register a new earnings stream (salary, contract income, …). Each month the stream is active and no actual payslip covers it, the planner predicts a net transaction into `accountIdTo` using the country's tax rules: for `GB`, it applies PAYE income tax, NIC, and — when enabled — Student Loan plan 2, using the year's tax rates and any attached UK tax codes.
 *
 * @gqlMutationField
 */
export async function earningsCreate(
  name: string,
  start: CalendarDate,
  amountGross: MoneyInput,
  /** ISO-3166-1 alpha-2 country where the earnings are taxed (e.g. `"GB"`). */
  countryCode: string,
  pensionReliefAtSource: Float,
  pensionNetPay: Float,
  accountIdTo: ID,
  end?: CalendarDate | null,
  pensionSalarySacrifice?: Float | null,
  /** Whether Student Loan plan 2 is being repaid on this income. Defaults to false. */
  studentLoanPlan2?: boolean | null,
  ukTaxCodes?: PlanningEarningUKTaxCodeInput[] | null,
): Promise<PlanningYear[]> {
  assertCountryCode(countryCode);
  const { currency, amount } = getMoneyInputFractionalAmount(amountGross);
  const row = await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(PlanningEarnings)
      .values({
        name,
        start,
        end: end ?? null,
        amountGross: amount,
        currency,
        countryCode,
        pensionSalarySacrifice: pensionSalarySacrifice ?? null,
        pensionReliefAtSource,
        pensionNetPay,
        studentLoanPlan2: studentLoanPlan2 ?? false,
        accountIdTo,
      })
      .returning();
    if (ukTaxCodes != null) await writeTaxCodes(tx, inserted.id, ukTaxCodes);
    return inserted;
  });
  return planningYearsForYears(yearsOverlapping(row.start, row.end));
}

/**
 * Partially update an earnings stream. Only fields passed in are changed — omit a field to leave it untouched. Passing `ukTaxCodes` replaces the full tax-code history (existing rows are deleted, then the supplied list is inserted). Months affected by the old or new date range have their projections recomputed.
 *
 * @gqlMutationField
 */
export async function earningsUpdate(
  id: ID,
  name?: string | null,
  start?: CalendarDate | null,
  amountGross?: MoneyInput | null,
  countryCode?: string | null,
  pensionReliefAtSource?: Float | null,
  pensionNetPay?: Float | null,
  accountIdTo?: ID | null,
  end?: CalendarDate | null,
  pensionSalarySacrifice?: Float | null,
  studentLoanPlan2?: boolean | null,
  ukTaxCodes?: PlanningEarningUKTaxCodeInput[] | null,
): Promise<PlanningYear[]> {
  const [existing] = await db
    .select()
    .from(PlanningEarnings)
    .where(eq(PlanningEarnings.id, id));
  assert(existing, `Earning ${id} not found`);

  let narrowedCountry: "GB" | undefined;
  if (countryCode != null) {
    assertCountryCode(countryCode);
    narrowedCountry = countryCode;
  }
  const moneyPatch =
    amountGross != null ? getMoneyInputFractionalAmount(amountGross) : null;

  const row = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(PlanningEarnings)
      .set({
        ...(name != null && { name }),
        ...(start != null && { start }),
        ...(end !== undefined && { end }),
        ...(moneyPatch && {
          amountGross: moneyPatch.amount,
          currency: moneyPatch.currency,
        }),
        ...(narrowedCountry != null && { countryCode: narrowedCountry }),
        ...(pensionSalarySacrifice !== undefined && {
          pensionSalarySacrifice,
        }),
        ...(pensionReliefAtSource != null && { pensionReliefAtSource }),
        ...(pensionNetPay != null && { pensionNetPay }),
        ...(studentLoanPlan2 != null && { studentLoanPlan2 }),
        ...(accountIdTo != null && { accountIdTo }),
        updatedAt: new Date(),
      })
      .where(eq(PlanningEarnings.id, id))
      .returning();
    if (ukTaxCodes != null) await writeTaxCodes(tx, id, ukTaxCodes);
    return updated;
  });

  const affected = new Set<number>([
    ...yearsOverlapping(existing.start, existing.end),
    ...yearsOverlapping(row.start, row.end),
  ]);
  return planningYearsForYears([...affected]);
}

/**
 * Delete an earnings stream and stop all future projections it was driving. Attached UK tax codes are removed via cascade. Use this when a role ends and no further income is expected from this source.
 *
 * @gqlMutationField
 */
export async function earningsDelete(id: ID): Promise<PlanningYear[]> {
  const [row] = await db
    .delete(PlanningEarnings)
    .where(eq(PlanningEarnings.id, id))
    .returning();
  if (!row) return [];
  return planningYearsForYears(yearsOverlapping(row.start, row.end));
}

const DEFAULT_PAGE_SIZE = 20;

/**
 * Every registered earnings stream, paginated and sorted by `start` descending (most-recently-starting first, `id` tiebreak).
 *
 * @gqlQueryField
 * @gqlAnnotate semanticNonNull
 */
export async function earnings(
  first?: Int | null,
  after?: ID | null,
): Promise<PlanningEarningConnection | null> {
  const limit = first ?? DEFAULT_PAGE_SIZE;
  const cursor = after ? decodeCursor(after) : null;

  const cursorWhere = cursor
    ? or(
        lt(PlanningEarnings.start, new Date(cursor.c)),
        and(
          eq(PlanningEarnings.start, new Date(cursor.c)),
          lt(PlanningEarnings.id, cursor.i),
        ),
      )
    : undefined;

  const rows = await db
    .select()
    .from(PlanningEarnings)
    .where(cursorWhere)
    .orderBy(desc(PlanningEarnings.start), desc(PlanningEarnings.id))
    .limit(limit + 1);

  const hasExtra = rows.length > limit;
  const page = hasExtra ? rows.slice(0, limit) : rows;

  const edges: PlanningEarningEdge[] = page.map((row) => ({
    cursor: encodeCursor(row.start.toISOString(), row.id),
    node: PlanningEarning.load(row),
  }));

  return {
    edges,
    pageInfo: {
      hasNextPage: hasExtra,
      hasPreviousPage: cursor != null,
      startCursor: edges.length > 0 ? edges[0].cursor : null,
      endCursor: edges.length > 0 ? edges[edges.length - 1].cursor : null,
    },
  };
}

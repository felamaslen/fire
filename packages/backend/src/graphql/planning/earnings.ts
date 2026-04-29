import { strict as assert } from "node:assert";

import { and, asc, desc, eq, lt, or } from "drizzle-orm";
import type { Float, ID, Int } from "grats";

import { db } from "@/db";
import { model } from "@/db/drizzle-model";
import { assertCountryCode } from "@/db/schema/country";
import {
  PlanningEarnings,
  PlanningEarningsParentalLeave,
  PlanningEarningsUKTaxCodes,
} from "@/db/schema/planning";

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
    /** Fraction of gross diverted via salary sacrifice. Null when the concept doesn't apply for this earning (e.g. non-UK). @gqlField */
    public readonly pensionSalarySacrifice: Float | null,
    /** Fraction of gross contributed via relief-at-source. Null when the concept doesn't apply. @gqlField */
    public readonly pensionReliefAtSource: Float | null,
    /** Fraction of gross contributed via net-pay arrangement. Null when the concept doesn't apply. @gqlField */
    public readonly pensionNetPay: Float | null,
    /** Whether Student Loan plan 2 is being repaid on this income. Null when the concept doesn't apply (e.g. non-UK earnings). @gqlField */
    public readonly studentLoanPlan2: boolean | null,
    public readonly toAccountId: string,
    private readonly studentLoanLiabilityId: string | null,
    private readonly pensionAssetId: string | null,
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
      row.pensionSalarySacrifice,
      row.pensionReliefAtSource,
      row.pensionNetPay,
      row.studentLoanPlan2,
      row.toAccountId,
      row.studentLoanLiabilityId,
      row.pensionAssetId,
    );
  }

  /** Liability the predicted student-loan deduction pays down. Null when `studentLoanPlan2` is false or no liability has been linked. @gqlField */
  async studentLoanLiability(): Promise<NetWorthCategoryLiability | null> {
    if (!this.studentLoanLiabilityId) return null;
    const row = await model("NetWorthCategoryLiabilities").findById(
      this.studentLoanLiabilityId,
    );
    return NetWorthCategoryLiability.load(row);
  }

  /** Pension asset the predicted pension deductions contribute to. Null when no pension fractions are configured or no asset has been linked. @gqlField */
  async pensionAsset(): Promise<NetWorthCategoryAsset | null> {
    if (!this.pensionAssetId) return null;
    const row = await model("NetWorthCategoryAssets").findById(
      this.pensionAssetId,
    );
    return NetWorthCategoryAsset.load(row);
  }

  /** Destination planning account for the net earnings. @gqlField */
  async toAccount(): Promise<PlanningAccount> {
    const account = await model("PlanningAccounts").findById(this.toAccountId);
    const asset = await model("NetWorthCategoryAssets").findById(
      account.accountId,
    );
    return PlanningAccount.load({
      assetId: account.accountId,
      alias: account.alias,
      asset: NetWorthCategoryAsset.load(asset),
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

  /** Parental-leave stages for this earnings stream, sorted by `start` ascending. Each stage reduces the gross pay used for the predicted projections during its date range — months covered by an actual payslip are unaffected. @gqlField */
  async parentalLeaves(): Promise<PlanningEarningParentalLeave[]> {
    const rows = await db
      .select()
      .from(PlanningEarningsParentalLeave)
      .where(eq(PlanningEarningsParentalLeave.earningsId, this.id))
      .orderBy(asc(PlanningEarningsParentalLeave.start));
    return rows.map((r) => PlanningEarningParentalLeave.load(r));
  }
}

function formatAttributes(p: {
  pensionSalarySacrifice: number | null;
  pensionNetPay: number | null;
  pensionReliefAtSource: number | null;
  studentLoanPlan2: boolean;
}): string {
  const parts: string[] = [];
  const pct = (f: number): string => `${Math.round(f * 100)}%`;
  if (p.pensionSalarySacrifice && p.pensionSalarySacrifice > 0) {
    parts.push(`${pct(p.pensionSalarySacrifice)} salary sacrifice`);
  }
  if (p.pensionNetPay && p.pensionNetPay > 0) {
    parts.push(`${pct(p.pensionNetPay)} net pay pension`);
  }
  if (p.pensionReliefAtSource && p.pensionReliefAtSource > 0) {
    parts.push(`${pct(p.pensionReliefAtSource)} relief-at-source pension`);
  }
  if (p.studentLoanPlan2) parts.push("student loan plan 2");
  return parts.join(", ");
}

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

/** A parental-leave stage on a `PlanningEarning`. Each stage represents a single, constant pay level over a date range — an enhanced employer scheme is modelled as several stages in sequence (e.g. 6 weeks at `0.9`, then 33 weeks at `0.0` with `isSMP` set, then 13 weeks unpaid). Has no `id` on purpose: keyed by (earnings, start), so cache libraries should invalidate the parent `PlanningEarning` when entries change rather than try to normalise these rows individually. During a stage the effective gross is `max(fractionOfGross × normal, statutoryFloor)` where `statutoryFloor` is `min(year's statutory weekly rate, 90% of normal weekly gross)` when the stage is statutorily eligible. The two eligibility flags are mutually exclusive. @gqlType */
export class PlanningEarningParentalLeave {
  constructor(
    /** @gqlField */
    public readonly start: CalendarDate,
    /** Last day this stage applies (inclusive); null while the stage is ongoing. @gqlField */
    public readonly end: CalendarDate | null,
    /** Fraction of the earning's normal gross paid during this stage, in `[0, 1]`. `0` means unpaid; `1` means full pay. The statutory floor (when `isSMP` or `isSPP` is set) may raise the effective pay above this. @gqlField */
    public readonly fractionOfGross: Float,
    /** Whether this stage qualifies for Statutory Maternity Pay (also covers Shared Parental Pay and Statutory Adoption Pay — they share a weekly rate). When set, the statutory floor applies during this stage. Mutually exclusive with `isSPP`. @gqlField */
    public readonly isSMP: boolean,
    /** Whether this stage qualifies for Statutory Paternity Pay. When set, the statutory floor applies during this stage. Mutually exclusive with `isSMP`. @gqlField */
    public readonly isSPP: boolean,
  ) {}

  static load(
    row: typeof PlanningEarningsParentalLeave.$inferSelect,
  ): PlanningEarningParentalLeave {
    return new PlanningEarningParentalLeave(
      row.start,
      row.end,
      row.fractionOfGross,
      row.isSMP,
      row.isSPP,
    );
  }
}

/** A parental-leave stage to attach to a `PlanningEarning`. Rows are upserted by (earnings, start) — re-supplying the same `start` overwrites the previous stage. `isSMP` and `isSPP` are mutually exclusive. @gqlInput */
export type PlanningEarningParentalLeaveInput = {
  start: CalendarDate;
  end?: CalendarDate | null;
  /** Fraction of normal gross paid during this stage, in `[0, 1]`. */
  fractionOfGross: Float;
  isSMP?: boolean | null;
  isSPP?: boolean | null;
};

async function writeParentalLeaves(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  earningsId: string,
  leaves: PlanningEarningParentalLeaveInput[],
): Promise<void> {
  await tx
    .delete(PlanningEarningsParentalLeave)
    .where(eq(PlanningEarningsParentalLeave.earningsId, earningsId));
  if (leaves.length === 0) return;
  for (const l of leaves) {
    assert(
      !(l.isSMP && l.isSPP),
      "isSMP and isSPP are mutually exclusive on a parental leave stage",
    );
    assert(
      l.fractionOfGross >= 0 && l.fractionOfGross <= 1,
      "fractionOfGross must be between 0 and 1",
    );
  }
  await tx.insert(PlanningEarningsParentalLeave).values(
    leaves.map((l) => ({
      earningsId,
      start: l.start,
      end: l.end ?? null,
      fractionOfGross: l.fractionOfGross,
      isSMP: l.isSMP ?? false,
      isSPP: l.isSPP ?? false,
    })),
  );
}

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
 * Register a new earnings stream (salary, contract income, …). Each month the stream is active and no actual payslip covers it, the planner predicts a net transaction into `toAccountId` using the country's tax rules: for `GB`, it applies PAYE income tax, NIC, and — when enabled — Student Loan plan 2, using the year's tax rates and any attached UK tax codes.
 *
 * @gqlMutationField
 */
export async function earningsCreate(
  name: string,
  start: CalendarDate,
  amountGross: MoneyInput,
  /** ISO-3166-1 alpha-2 country where the earnings are taxed (e.g. `"GB"`). */
  countryCode: string,
  /** Planning account (`PlanningAccount.id`) the net earnings land in. The asset must already have a planning account assigned via `planningAccountAssign`. */
  toAccountId: ID,
  end?: CalendarDate | null,
  /** Fraction (0-1) contributed via relief-at-source. Leave null when the concept doesn't apply. */
  pensionReliefAtSource?: Float | null,
  /** Fraction (0-1) contributed via net-pay arrangement. Leave null when the concept doesn't apply. */
  pensionNetPay?: Float | null,
  pensionSalarySacrifice?: Float | null,
  /** Whether Student Loan plan 2 is being repaid on this income. Null when the concept doesn't apply. */
  studentLoanPlan2?: boolean | null,
  /** Liability the predicted student-loan deduction pays down. May only be set when `studentLoanPlan2` is true. */
  studentLoanLiabilityId?: ID | null,
  /** Pension asset (`NetWorthCategoryAsset` of type `PENSION`) the predicted pension deductions contribute to. May only be set when at least one pension fraction is configured. */
  pensionAssetId?: ID | null,
  ukTaxCodes?: PlanningEarningUKTaxCodeInput[] | null,
  /** Parental-leave stages affecting predicted gross during their date ranges. Provide one row per stage of an enhanced scheme (e.g. 6 weeks at `0.9`, then 33 weeks at `0.0` with `isSMP` set, then 13 weeks unpaid). */
  parentalLeaves?: PlanningEarningParentalLeaveInput[] | null,
): Promise<PlanningEarning> {
  assertCountryCode(countryCode);
  const slp2 = studentLoanPlan2 ?? false;
  assert(
    studentLoanLiabilityId == null || slp2,
    "studentLoanLiabilityId may only be set when studentLoanPlan2 is true",
  );
  const hasPensionFraction =
    pensionSalarySacrifice != null ||
    pensionNetPay != null ||
    pensionReliefAtSource != null;
  assert(
    pensionAssetId == null || hasPensionFraction,
    "pensionAssetId may only be set when at least one pension fraction is configured",
  );
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
        pensionReliefAtSource: pensionReliefAtSource ?? null,
        pensionNetPay: pensionNetPay ?? null,
        studentLoanPlan2: slp2,
        studentLoanLiabilityId: studentLoanLiabilityId ?? null,
        pensionAssetId: pensionAssetId ?? null,
        toAccountId: toAccountId,
      })
      .returning();
    if (ukTaxCodes != null) await writeTaxCodes(tx, inserted.id, ukTaxCodes);
    if (parentalLeaves != null)
      await writeParentalLeaves(tx, inserted.id, parentalLeaves);
    return inserted;
  });
  return PlanningEarning.load(row);
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
  /** New destination planning account (`PlanningAccount.id`) the net earnings land in. */
  toAccountId?: ID | null,
  end?: CalendarDate | null,
  pensionSalarySacrifice?: Float | null,
  studentLoanPlan2?: boolean | null,
  /** New linked liability; pass null explicitly to clear. Must be null whenever `studentLoanPlan2` ends up false (after this patch applies). */
  studentLoanLiabilityId?: ID | null,
  /** New linked pension asset; pass null explicitly to clear. Must be null whenever every pension fraction ends up null (after this patch applies). */
  pensionAssetId?: ID | null,
  ukTaxCodes?: PlanningEarningUKTaxCodeInput[] | null,
  /** New full parental-leave history; pass to replace the existing list (every supplied row is upserted, and any rows not in the list are removed). Omit to leave the history untouched. */
  parentalLeaves?: PlanningEarningParentalLeaveInput[] | null,
): Promise<PlanningEarning> {
  const [existing] = await db
    .select()
    .from(PlanningEarnings)
    .where(eq(PlanningEarnings.id, id));
  assert(existing, `Earning ${id} not found`);

  const nextStudentLoanPlan2 =
    studentLoanPlan2 !== undefined
      ? (studentLoanPlan2 ?? false)
      : existing.studentLoanPlan2;
  const nextLiabilityId =
    studentLoanLiabilityId !== undefined
      ? studentLoanLiabilityId
      : existing.studentLoanLiabilityId;
  assert(
    nextLiabilityId == null || nextStudentLoanPlan2,
    "studentLoanLiabilityId may only be set when studentLoanPlan2 is true",
  );

  const nextPensionSacrifice =
    pensionSalarySacrifice !== undefined
      ? pensionSalarySacrifice
      : existing.pensionSalarySacrifice;
  const nextPensionNetPay =
    pensionNetPay !== undefined ? pensionNetPay : existing.pensionNetPay;
  const nextPensionRelief =
    pensionReliefAtSource !== undefined
      ? pensionReliefAtSource
      : existing.pensionReliefAtSource;
  const nextPensionAssetId =
    pensionAssetId !== undefined ? pensionAssetId : existing.pensionAssetId;
  const nextHasPensionFraction =
    nextPensionSacrifice != null ||
    nextPensionNetPay != null ||
    nextPensionRelief != null;
  assert(
    nextPensionAssetId == null || nextHasPensionFraction,
    "pensionAssetId may only be set when at least one pension fraction is configured",
  );

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
        ...(pensionReliefAtSource !== undefined && {
          pensionReliefAtSource,
        }),
        ...(pensionNetPay !== undefined && {
          pensionNetPay,
        }),
        ...(studentLoanPlan2 !== undefined && {
          studentLoanPlan2: studentLoanPlan2 ?? false,
        }),
        ...(studentLoanLiabilityId !== undefined && {
          studentLoanLiabilityId,
        }),
        ...(pensionAssetId !== undefined && { pensionAssetId }),
        ...(toAccountId != null && { toAccountId: toAccountId }),
        updatedAt: new Date(),
      })
      .where(eq(PlanningEarnings.id, id))
      .returning();
    if (ukTaxCodes != null) await writeTaxCodes(tx, id, ukTaxCodes);
    if (parentalLeaves != null)
      await writeParentalLeaves(tx, id, parentalLeaves);
    return updated;
  });
  return PlanningEarning.load(row);
}

/**
 * Delete an earnings stream and stop all future projections it was driving. Attached UK tax codes are removed via cascade. Use this when a role ends and no further income is expected from this source.
 *
 * @gqlMutationField
 */
export async function earningsDelete(id: ID): Promise<Void> {
  await db.delete(PlanningEarnings).where(eq(PlanningEarnings.id, id));
  return VOID;
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
): Promise<Connection<PlanningEarning> | null> {
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

  const startByNode = new Map(page.map((row) => [row.id, row.start]));
  return buildConnection<PlanningEarning>(
    page.map((row) => PlanningEarning.load(row)),
    (node) => encodeCursor(startByNode.get(node.id)!.toISOString(), node.id),
    { hasNextPage: hasExtra, hasPreviousPage: cursor != null },
  );
}

import { strict as assert } from "node:assert";

import { eq, inArray } from "drizzle-orm";
import type { ID } from "grats";

import { db } from "@/db";
import { NetWorthCategoryAssets } from "@/db/schema/net-worth";
import {
  PlanningAccounts,
  PlanningMonths,
  PlanningYears,
  PlanningYearUKTaxRates,
} from "@/db/schema/planning";

import type { Date as CalendarDate } from "../date";
import { Money } from "../money";
import {
  NetWorthCategoryAsset,
  toNetWorthCategoryAsset,
} from "../net-worth/categories";
import { VOID, type Void } from "../void";
import { monthId, monthsInFYYear } from "./months";
import {
  type PlanningYearTaxRates,
  type PlanningYearTaxRatesInput,
  PlanningYearTaxRatesUK,
} from "./tax";

/** A financial year inside the planner. `id` is the starting calendar year as a string. Tax rates are country-specific (see `PlanningYearTaxRates`). @gqlType */
export class PlanningYear {
  /** @gqlField */
  id!: ID;
  yearNumber!: number;

  constructor(data: { yearNumber: number }) {
    this.id = String(data.yearNumber) as ID;
    this.yearNumber = data.yearNumber;
  }

  /** Tax parameters for this year (`null` if none configured). @gqlField */
  async taxRates(): Promise<PlanningYearTaxRates | null> {
    const [row] = await db
      .select()
      .from(PlanningYearUKTaxRates)
      .where(eq(PlanningYearUKTaxRates.year, this.yearNumber));
    return row ? new PlanningYearTaxRatesUK(row) : null;
  }

  /** The months making up this financial year. @gqlField */
  async months(): Promise<PlanningMonth[]> {
    const rows = await db
      .select()
      .from(PlanningMonths)
      .where(eq(PlanningMonths.year, this.yearNumber));
    return rows
      .sort((a, b) => a.date.getTime() - b.date.getTime())
      .map((r) => new PlanningMonth({ year: this.yearNumber, date: r.date }));
  }

  /** All assigned planning accounts (not year-scoped — returned here for convenience). @gqlField */
  async accounts(): Promise<PlanningAccount[]> {
    const rows = await db
      .select({
        accountId: PlanningAccounts.accountId,
        alias: PlanningAccounts.alias,
        asset: NetWorthCategoryAssets,
      })
      .from(PlanningAccounts)
      .innerJoin(
        NetWorthCategoryAssets,
        eq(PlanningAccounts.accountId, NetWorthCategoryAssets.id),
      );
    return rows.map(
      (r) =>
        new PlanningAccount({
          assetId: r.accountId,
          alias: r.alias,
          asset: toNetWorthCategoryAsset(r.asset),
        }),
    );
  }
}

/** A single month inside a PlanningYear. `id` is the lowercased short month + year (e.g. `"dec-2024"`). @gqlType */
export class PlanningMonth {
  /** @gqlField */
  id!: ID;
  /** @gqlField */
  date!: CalendarDate;
  year!: number;

  constructor(data: { year: number; date: CalendarDate }) {
    this.id = monthId(data.date) as ID;
    this.date = data.date;
    this.year = data.year;
  }

  /** Per-account rollups for this month. @gqlField */
  async accounts(): Promise<PlanningMonthAccount[]> {
    const rows = await db
      .select({
        accountId: PlanningAccounts.accountId,
        alias: PlanningAccounts.alias,
        asset: NetWorthCategoryAssets,
      })
      .from(PlanningAccounts)
      .innerJoin(
        NetWorthCategoryAssets,
        eq(PlanningAccounts.accountId, NetWorthCategoryAssets.id),
      );
    return rows.map(
      (r) =>
        new PlanningMonthAccount({
          monthId: this.id,
          date: this.date,
          year: this.year,
          assetId: r.accountId,
          alias: r.alias,
          asset: toNetWorthCategoryAsset(r.asset),
        }),
    );
  }
}

/** A single (month × planning-account) roll-up: name, running balance, and the merged transactions (actual + predicted) for that cell. @gqlType */
export class PlanningMonthAccount {
  /** @gqlField */
  id!: ID;
  date!: CalendarDate;
  year!: number;
  assetId!: string;
  alias!: string | null;
  asset!: NetWorthCategoryAsset;

  constructor(data: {
    monthId: ID;
    date: CalendarDate;
    year: number;
    assetId: string;
    alias: string | null;
    asset: NetWorthCategoryAsset;
  }) {
    this.id = `${data.monthId}::${data.assetId}` as ID;
    this.date = data.date;
    this.year = data.year;
    this.assetId = data.assetId;
    this.alias = data.alias;
    this.asset = data.asset;
  }

  /** Display name — alias if set, otherwise the underlying asset's name. @gqlField */
  get name(): string {
    return this.alias ?? this.asset.name;
  }

  /** Transactions (actual + predicted) affecting this account in this month. @gqlField */
  async transactions(): Promise<PlanningTransaction[]> {
    // TODO: merge explicit PlanningTransactions + PlanningPayslips + PlanningEarnings predictions + PlanningBills predictions (with PlanningMonthBills overrides).
    return [];
  }

  /** Opening balance for the month. @gqlField */
  async valueStart(): Promise<Money> {
    // TODO: baseline from latest NetWorthValueAmounts snapshot before this month + cumulative planning transactions.
    return Money.fromMinorDenomination(0, "GBP");
  }

  /** Closing balance for the month. @gqlField */
  async valueEnd(): Promise<Money> {
    return Money.fromMinorDenomination(0, "GBP");
  }
}

/** A single row in a PlanningMonthAccount — mix of actual and predicted sources. @gqlType */
export type PlanningTransaction = {
  /** @gqlField */
  id: ID;
  /** @gqlField */
  name: string;
  /** Signed amount — negative for outflows (bills, taxes, transfers out). @gqlField */
  amount: Money;
  /** True when the transaction is a prediction (e.g. forthcoming bill, predicted salary). @gqlField */
  isProvisional: boolean;
  /** True when the transaction can be edited directly; usually `!isProvisional`, but derived transfers (the `to`-side of a manual transaction) are neither provisional nor editable. @gqlField */
  isEditable: boolean;
};

/** A NetWorthCategoryAsset that's been tagged for planning, optionally with a display alias. @gqlType */
export class PlanningAccount {
  /** @gqlField */
  id!: ID;
  alias!: string | null;
  /** @gqlField */
  asset!: NetWorthCategoryAsset;

  constructor(data: {
    assetId: string;
    alias: string | null;
    asset: NetWorthCategoryAsset;
  }) {
    this.id = data.assetId as ID;
    this.alias = data.alias;
    this.asset = data.asset;
  }

  /** Display name — the alias if one was set, otherwise the underlying asset's name. @gqlField */
  get name(): string {
    return this.alias ?? this.asset.name;
  }
}

/**
 * Look up a planning year by its id (the starting calendar year, e.g. `"2025"`).
 *
 * @gqlQueryField
 */
export async function planningYear(id: ID): Promise<PlanningYear | null> {
  const yearNumber = parsePlanningYearId(id);
  if (yearNumber == null) return null;
  const [row] = await db
    .select()
    .from(PlanningYears)
    .where(eq(PlanningYears.year, yearNumber));
  return row ? new PlanningYear({ yearNumber: row.year }) : null;
}

/**
 * List every configured planning year.
 *
 * @gqlQueryField
 */
export async function planningYears(): Promise<PlanningYear[] | null> {
  const rows = await db.select().from(PlanningYears);
  return rows
    .sort((a, b) => a.year - b.year)
    .map((r) => new PlanningYear({ yearNumber: r.year }));
}

/**
 * Upsert a planning year plus (optionally) its tax rates. Creates the 12 monthly buckets on first write.
 *
 * @gqlMutationField
 */
export async function planningYearSet(
  year: ID,
  taxRates?: PlanningYearTaxRatesInput | null,
): Promise<PlanningYear> {
  const yearNumber = parsePlanningYearId(year);
  assert(yearNumber != null, `Invalid planning year id: ${year}`);

  return db.transaction(async (tx) => {
    await tx
      .insert(PlanningYears)
      .values({ year: yearNumber })
      .onConflictDoUpdate({
        target: PlanningYears.year,
        set: { updatedAt: new Date() },
      });

    const existing = await tx
      .select({ date: PlanningMonths.date })
      .from(PlanningMonths)
      .where(eq(PlanningMonths.year, yearNumber));
    const existingTimes = new Set(existing.map((r) => r.date.getTime()));
    const toCreate = monthsInFYYear(yearNumber).filter(
      (d) => !existingTimes.has(d.getTime()),
    );
    if (toCreate.length > 0) {
      await tx
        .insert(PlanningMonths)
        .values(toCreate.map((date) => ({ year: yearNumber, date })));
    }

    if (taxRates?.uk) {
      await tx
        .insert(PlanningYearUKTaxRates)
        .values({ year: yearNumber, ...taxRates.uk })
        .onConflictDoUpdate({
          target: PlanningYearUKTaxRates.year,
          set: { ...taxRates.uk, updatedAt: new Date() },
        });
    }

    return new PlanningYear({ yearNumber });
  });
}

/**
 * Attach a NetWorthCategoryAsset as a planning account, optionally with a display alias.
 *
 * @gqlMutationField
 */
export async function planningAccountAssign(
  assetId: ID,
  alias?: string | null,
): Promise<PlanningAccount> {
  const [asset] = await db
    .select()
    .from(NetWorthCategoryAssets)
    .where(eq(NetWorthCategoryAssets.id, assetId));
  assert(asset, `NetWorthCategoryAsset ${assetId} not found`);

  const [row] = await db
    .insert(PlanningAccounts)
    .values({ accountId: assetId, alias: alias ?? null })
    .onConflictDoUpdate({
      target: PlanningAccounts.accountId,
      set: { alias: alias ?? null, updatedAt: new Date() },
    })
    .returning();

  return new PlanningAccount({
    assetId: row.accountId,
    alias: row.alias,
    asset: toNetWorthCategoryAsset(asset),
  });
}

/**
 * Remove a planning account. Idempotent — returns `Void` even if the account wasn't assigned.
 *
 * @gqlMutationField
 */
export async function planningAccountUnassign(assetId: ID): Promise<Void> {
  await db
    .delete(PlanningAccounts)
    .where(eq(PlanningAccounts.accountId, assetId));
  return VOID;
}

/**
 * Resolve a list of UK FY starting years into the corresponding PlanningYear objects (those that exist in the DB).
 */
export async function planningYearsForYears(
  yearNumbers: number[],
): Promise<PlanningYear[]> {
  if (yearNumbers.length === 0) return [];
  const rows = await db
    .select()
    .from(PlanningYears)
    .where(inArray(PlanningYears.year, yearNumbers));
  return rows
    .sort((a, b) => a.year - b.year)
    .map((r) => new PlanningYear({ yearNumber: r.year }));
}

function parsePlanningYearId(id: string): number | null {
  if (!/^\d{4}$/.test(id)) return null;
  const n = Number(id);
  return Number.isFinite(n) ? n : null;
}

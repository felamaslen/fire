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
import { NetWorthCategoryAsset } from "../net-worth/categories";
import { VOID, type Void } from "../void";
import {
  loadPlanningAccountInfos,
  loadPlanningYearData,
  monthTransactionsFor,
  type PlanningYearData,
  valueStartFor,
} from "./balance";
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
  /** Pre-loaded bundle of every row the year's downstream resolvers might want. Built once at `PlanningYear.load` so no resolver below this point issues SQL. */
  data!: PlanningYearData;
  monthDates!: Date[];

  constructor(data: { yearData: PlanningYearData; monthDates: Date[] }) {
    this.yearNumber = data.yearData.year;
    this.id = String(this.yearNumber) as ID;
    this.data = data.yearData;
    this.monthDates = data.monthDates;
  }

  /** Load a planning year by its starting calendar year — returns null if the year isn't configured. Pre-fetches every row needed for downstream resolvers in a single batch. */
  static async load(yearNumber: number): Promise<PlanningYear | null> {
    const [[yearRow], monthRows, accounts] = await Promise.all([
      db.select().from(PlanningYears).where(eq(PlanningYears.year, yearNumber)),
      db
        .select()
        .from(PlanningMonths)
        .where(eq(PlanningMonths.year, yearNumber)),
      loadPlanningAccountInfos(),
    ]);
    if (!yearRow) return null;
    const yearData = await loadPlanningYearData(yearNumber, accounts);
    const monthDates = monthRows
      .map((r) => r.date)
      .sort((a, b) => a.getTime() - b.getTime());
    return new PlanningYear({ yearData, monthDates });
  }

  /** Tax parameters for this year (`null` if none configured). @gqlField */
  taxRates(): PlanningYearTaxRates | null {
    return this.data.rates ? new PlanningYearTaxRatesUK(this.data.rates) : null;
  }

  /** The months making up this financial year. @gqlField */
  months(): PlanningMonth[] {
    return this.monthDates.map(
      (date) =>
        new PlanningMonth({ year: this.yearNumber, date, yearData: this.data }),
    );
  }

  /** All assigned planning accounts (not year-scoped — returned here for convenience). @gqlField */
  accounts(): PlanningAccount[] {
    return this.data.accounts.map(
      (info) =>
        new PlanningAccount({
          assetId: info.assetId,
          alias: info.alias,
          asset: info.asset,
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
  yearData!: PlanningYearData;

  constructor(data: {
    year: number;
    date: CalendarDate;
    yearData: PlanningYearData;
  }) {
    this.id = monthId(data.date) as ID;
    this.date = data.date;
    this.year = data.year;
    this.yearData = data.yearData;
  }

  /** Per-account rollups for this month. Each account is built with pre-filtered transactions + value-start so downstream resolvers are synchronous. @gqlField */
  accounts(): PlanningMonthAccount[] {
    return this.yearData.accounts.map((info) => {
      const transactions = monthTransactionsFor(
        this.yearData,
        info.assetId,
        this.date,
      );
      const valueStart = valueStartFor(this.yearData, info.assetId, this.date);
      return new PlanningMonthAccount({
        monthId: this.id,
        date: this.date,
        year: this.year,
        assetId: info.assetId,
        alias: info.alias,
        asset: info.asset,
        transactions,
        valueStart,
      });
    });
  }
}

/** A single (month × planning-account) roll-up: name, running balance, and the merged transactions (actual + predicted) for that cell. All fields resolve synchronously from pre-filtered data — no per-field SQL. @gqlType */
export class PlanningMonthAccount {
  /** @gqlField */
  id!: ID;
  date!: CalendarDate;
  year!: number;
  assetId!: string;
  alias!: string | null;
  asset!: NetWorthCategoryAsset;
  monthTransactions!: PlanningTransaction[];
  monthValueStart!: Money;

  constructor(data: {
    monthId: ID;
    date: CalendarDate;
    year: number;
    assetId: string;
    alias: string | null;
    asset: NetWorthCategoryAsset;
    transactions: PlanningTransaction[];
    valueStart: Money;
  }) {
    this.id = `${data.monthId}::${data.assetId}` as ID;
    this.date = data.date;
    this.year = data.year;
    this.assetId = data.assetId;
    this.alias = data.alias;
    this.asset = data.asset;
    this.monthTransactions = data.transactions;
    this.monthValueStart = data.valueStart;
  }

  /** Display name — alias if set, otherwise the underlying asset's name. @gqlField */
  get name(): string {
    return this.alias ?? this.asset.name;
  }

  /** Transactions (actual + predicted) affecting this account in this month. @gqlField */
  transactions(): PlanningTransaction[] {
    return this.monthTransactions;
  }

  /** Opening balance for the month — the latest NetWorthValueAmounts snapshot strictly before the month rolled forward through any intervening planning transactions. Defaults to zero when there's no prior snapshot. @gqlField */
  valueStart(): Money {
    return this.monthValueStart;
  }

  /** Closing balance for the month — `valueStart` plus the sum of this month's transactions. @gqlField */
  valueEnd(): Money {
    const delta = this.monthTransactions.reduce(
      (sum, tx) => sum + Math.round(tx.amount.amount * 100),
      0,
    );
    const endMinor = Math.round(this.monthValueStart.amount * 100) + delta;
    return Money.fromMinorDenomination(endMinor, this.monthValueStart.currency);
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
  return PlanningYear.load(yearNumber);
}

/**
 * List every configured planning year.
 *
 * @gqlQueryField
 */
export async function planningYears(): Promise<PlanningYear[] | null> {
  const rows = await db.select().from(PlanningYears);
  return Promise.all(
    rows
      .map((r) => r.year)
      .sort((a, b) => a - b)
      .map(async (y) => {
        const loaded = await PlanningYear.load(y);
        assert(loaded, `PlanningYear ${y} disappeared between queries`);
        return loaded;
      }),
  );
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

  await db.transaction(async (tx) => {
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
  });

  const loaded = await PlanningYear.load(yearNumber);
  assert(loaded, `Failed to reload PlanningYear ${yearNumber} after set`);
  return loaded;
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
    asset: NetWorthCategoryAsset.load(asset),
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
 * Resolve a list of starting-calendar-year numbers into the corresponding PlanningYear objects (those that exist in the DB).
 */
export async function planningYearsForYears(
  yearNumbers: number[],
): Promise<PlanningYear[]> {
  if (yearNumbers.length === 0) return [];
  const rows = await db
    .select()
    .from(PlanningYears)
    .where(inArray(PlanningYears.year, yearNumbers));
  return Promise.all(
    rows
      .map((r) => r.year)
      .sort((a, b) => a - b)
      .map(async (y) => {
        const loaded = await PlanningYear.load(y);
        assert(loaded, `PlanningYear ${y} disappeared between queries`);
        return loaded;
      }),
  );
}

function parsePlanningYearId(id: string): number | null {
  if (!/^\d{4}$/.test(id)) return null;
  const n = Number(id);
  return Number.isFinite(n) ? n : null;
}

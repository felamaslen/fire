import { strict as assert } from "node:assert";

import { eq, sql } from "drizzle-orm";
import type { ID, Int } from "grats";

import { db } from "@/db";
import { NetWorthCategoryAssets, NetWorthEntries } from "@/db/schema/net-worth";
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
  NetWorthCategoryLiability,
} from "../net-worth/categories";
import {
  buildConnection,
  type Connection,
  decodeCursor,
  encodeCursor,
} from "../pagination";
import { VOID, type Void } from "../void";
import {
  loadPlanningAccountInfos,
  loadPlanningYearData,
  monthEndSnapshotFor,
  monthTransactionsFor,
  type PlanningYearData,
  valueStartFor,
  valueStartProvisionalFor,
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

  /** Load a planning year by its starting calendar year. Always returns a `PlanningYear`: if no `PlanningYears` row exists, the returned year is a synthetic view — months are generated from the year number, tax rates are null, and transactions/bills/earnings are whatever happens to overlap the FY. A `PlanningYears` row is only needed as a parent for tax-rate and month-scoped writes. */
  static async load(yearNumber: number): Promise<PlanningYear> {
    const [monthRows, accounts] = await Promise.all([
      db
        .select()
        .from(PlanningMonths)
        .where(eq(PlanningMonths.year, yearNumber)),
      loadPlanningAccountInfos(),
    ]);
    const yearData = await loadPlanningYearData(yearNumber, accounts);
    const monthDates =
      monthRows.length > 0
        ? monthRows.map((r) => r.date).sort((a, b) => a.getTime() - b.getTime())
        : monthsInFYYear(yearNumber);
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
    return this.data.accounts.map((info) =>
      PlanningAccount.load({
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
      const valueStartProvisional = valueStartProvisionalFor(
        this.yearData,
        info.assetId,
        this.date,
      );
      const monthEndSnapshot = monthEndSnapshotFor(
        this.yearData,
        info.assetId,
        this.date,
      );
      return new PlanningMonthAccount({
        monthId: this.id,
        date: this.date,
        year: this.year,
        assetId: info.assetId,
        alias: info.alias,
        asset: info.asset,
        transactions,
        valueStart,
        valueStartProvisional,
        monthEndSnapshot,
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
  monthValueStartProvisional!: boolean;
  monthEndSnapshot!: Money | null;

  constructor(data: {
    monthId: ID;
    date: CalendarDate;
    year: number;
    assetId: string;
    alias: string | null;
    asset: NetWorthCategoryAsset;
    transactions: PlanningTransaction[];
    valueStart: Money;
    valueStartProvisional: boolean;
    monthEndSnapshot: Money | null;
  }) {
    this.id = `${data.monthId}::${data.assetId}` as ID;
    this.date = data.date;
    this.year = data.year;
    this.assetId = data.assetId;
    this.alias = data.alias;
    this.asset = data.asset;
    this.monthTransactions = data.transactions;
    this.monthValueStart = data.valueStart;
    this.monthValueStartProvisional = data.valueStartProvisional;
    this.monthEndSnapshot = data.monthEndSnapshot;
  }

  /** Display name — alias if set, otherwise the underlying asset's name. @gqlField */
  async name(): Promise<string> {
    return this.alias ?? (await this.asset.name());
  }

  /** Transactions (actual + predicted) affecting this account in this month. @gqlField */
  transactions(): PlanningTransaction[] {
    return this.monthTransactions;
  }

  /** Opening balance for the month — the latest recorded net-worth snapshot strictly before the month rolled forward through any intervening planning transactions. Defaults to zero when there's no prior snapshot. @gqlField */
  valueStart(): Money {
    return this.monthValueStart;
  }

  /** True when `valueStart` is projected (rolled forward through transactions from a distant snapshot, or defaulted to zero with no snapshot at all). False when it's anchored to a real recorded balance from the immediately preceding month. @gqlField */
  valueStartProvisional(): boolean {
    return this.monthValueStartProvisional;
  }

  /** Closing balance for the month. When a net-worth snapshot was recorded inside this month we use it verbatim — real recorded balance always wins over a projection. Otherwise it falls back to `valueStart` plus the sum of this month's transactions. @gqlField */
  valueEnd(): Money {
    if (this.monthEndSnapshot) return this.monthEndSnapshot;
    const delta = this.monthTransactions.reduce(
      (sum, tx) => sum + Math.round(tx.amount.amount * 100),
      0,
    );
    const endMinor = Math.round(this.monthValueStart.amount * 100) + delta;
    return Money.fromMinorDenomination(endMinor, this.monthValueStart.currency);
  }

  /** True when `valueEnd` is projected (no snapshot recorded inside this month). False when it's anchored to a real recorded balance from an in-month snapshot. @gqlField */
  valueEndProvisional(): boolean {
    return this.monthEndSnapshot == null;
  }
}

/** A single row in a PlanningMonthAccount — mix of actual and predicted sources. @gqlType */
export class PlanningTransaction {
  /** @gqlField */
  readonly id: ID;
  /** @gqlField */
  readonly name: string;
  /** Signed amount — negative for outflows (bills, taxes, transfers out). @gqlField */
  readonly amount: Money;
  /** True when the transaction is a prediction (e.g. forthcoming bill, predicted salary). @gqlField */
  readonly isProvisional: boolean;
  /** True when the transaction can be edited directly; usually `!isProvisional`, but derived transfers (the `to`-side of a manual transaction) are neither provisional nor editable. @gqlField */
  readonly isEditable: boolean;
  // The link FKs are stored opaque; we only materialise the full
  // `PlanningAccount` / `NetWorthCategoryLiability` / `NetWorthCategoryAsset`
  // instances lazily via their `fromId` factories so selecting just `{ id }`
  // doesn't hit the DB. Each lazy instance caches its row once loaded.
  private readonly toAccountId: string | null;
  private readonly liabilityId: string | null;
  private readonly assetId: string | null;

  constructor(data: {
    id: ID;
    name: string;
    amount: Money;
    isProvisional: boolean;
    isEditable: boolean;
    toAccountId: string | null;
    liabilityId: string | null;
    assetId: string | null;
  }) {
    this.id = data.id;
    this.name = data.name;
    this.amount = data.amount;
    this.isProvisional = data.isProvisional;
    this.isEditable = data.isEditable;
    this.toAccountId = data.toAccountId;
    this.liabilityId = data.liabilityId;
    this.assetId = data.assetId;
  }

  /** Destination planning account for the from-side of a manual transfer. Null on every other kind of transaction (the to-side, predictions, payslips, ...). @gqlField */
  toAccount(): PlanningAccount | null {
    return this.toAccountId == null
      ? null
      : PlanningAccount.fromId(this.toAccountId);
  }

  /** Liability this row services (e.g. a payslip adjustment tagged with a student-loan liability, a credit-card payment). Null on every other kind of transaction. @gqlField */
  liability(): NetWorthCategoryLiability | null {
    return this.liabilityId == null
      ? null
      : NetWorthCategoryLiability.fromId(this.liabilityId);
  }

  /** Asset this transaction invests into (stock or pension). Null on every other kind of transaction. @gqlField */
  asset(): NetWorthCategoryAsset | null {
    return this.assetId == null
      ? null
      : NetWorthCategoryAsset.fromId(this.assetId);
  }
}

type PlanningAccountData = {
  assetId: string;
  alias: string | null;
  asset: NetWorthCategoryAsset;
};

/** A NetWorthCategoryAsset that's been tagged for planning, optionally with a display alias. @gqlType */
export class PlanningAccount {
  private dataCache: PlanningAccountData | null = null;
  private dataPromise: Promise<PlanningAccountData> | null = null;

  constructor(
    /** @gqlField */
    public readonly id: ID,
    /** A thunk that returns the full account data. Only invoked on the first
     * access of a non-`id` field so `{ id }` selections don't trigger any DB
     * work. */
    private readonly dataLoader: () => Promise<PlanningAccountData>,
  ) {}

  static load(data: PlanningAccountData): PlanningAccount {
    const inst = new PlanningAccount(data.assetId as ID, () =>
      Promise.resolve(data),
    );
    inst.dataCache = data;
    return inst;
  }

  static fromId(id: string): PlanningAccount {
    return new PlanningAccount(id as ID, async () => {
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
        .where(eq(PlanningAccounts.accountId, id));
      assert(row, `PlanningAccount ${id} not found`);
      return {
        assetId: row.account.accountId,
        alias: row.account.alias,
        asset: NetWorthCategoryAsset.load(row.asset),
      };
    });
  }

  private async data(): Promise<PlanningAccountData> {
    if (this.dataCache) return this.dataCache;
    this.dataPromise ??= this.dataLoader().then((d) => (this.dataCache = d));
    return this.dataPromise;
  }

  /** @gqlField */
  async asset(): Promise<NetWorthCategoryAsset> {
    return (await this.data()).asset;
  }

  /** Display name — the alias if one was set, otherwise the underlying asset's name. @gqlField */
  async name(): Promise<string> {
    const d = await this.data();
    return d.alias ?? (await d.asset.name());
  }
}

/**
 * Look up a planning year by its id (the starting calendar year, e.g. `"2025"`). Returns a synthetic year (months generated, tax rates null) when no data has been written for this year yet. Only returns null when `id` isn't a 4-digit year.
 *
 * @gqlQueryField
 */
export async function planningYear(id: ID): Promise<PlanningYear | null> {
  const yearNumber = parsePlanningYearId(id);
  if (yearNumber == null) return null;
  return PlanningYear.load(yearNumber);
}

/**
 * The planning year to land the user on by default — the UK financial year covering today (6 April → 5 April cutover: dates before 6 April belong to the previous FY). Always returns a year, even when no planning data has been recorded yet (the result is synthetic in that case).
 *
 * @gqlQueryField
 * @gqlAnnotate semanticNonNull
 */
export async function planningYearCurrent(): Promise<PlanningYear | null> {
  return PlanningYear.load(currentFYStart());
}

const PLANNING_YEARS_DEFAULT_PAGE_SIZE = 9;
/** How many FYs past the last recorded / current year the planner projects into the future. */
const PLANNING_YEARS_FUTURE_HORIZON = 5;

/**
 * Every planning year the user can reasonably work in, ordered oldest first. The range spans from the first `NetWorthEntry`'s FY up to 5 FYs past today (or past the most-recent entry, whichever is later); when no entries exist yet it starts at the current FY. Years without any stored data are synthesised on the fly. Supports forward (`first` / `after`) and backward (`last` / `before`) pagination.
 *
 * @gqlQueryField
 * @gqlAnnotate semanticNonNull
 */
export async function planningYears(
  first?: Int | null,
  after?: ID | null,
  last?: Int | null,
  before?: ID | null,
): Promise<Connection<PlanningYear> | null> {
  assert(
    first == null || last == null,
    "Pass either `first` or `last`, not both.",
  );
  assert(
    after == null || before == null,
    "Pass either `after` or `before`, not both.",
  );

  // When neither `first` nor `last` is given, default to the tail of the
  // range (`last: 9`) — users almost always want the most recent years.
  const forward = first != null;
  const limit = forward ? first : (last ?? PLANNING_YEARS_DEFAULT_PAGE_SIZE);
  const cursorRaw = forward ? after : before;
  const cursor = cursorRaw ? decodeCursor(cursorRaw) : null;
  const cursorYear = cursor ? Number(cursor.c) : null;

  const [bounds] = await db
    .select({
      min: sql<Date | null>`min(${NetWorthEntries.date})`,
      max: sql<Date | null>`max(${NetWorthEntries.date})`,
    })
    .from(NetWorthEntries);

  const today = currentFYStart();
  const oldest = bounds?.min != null ? fyStartFor(new Date(bounds.min)) : today;
  const latestAnchor =
    bounds?.max != null
      ? Math.max(today, fyStartFor(new Date(bounds.max)))
      : today;
  const newest = latestAnchor + PLANNING_YEARS_FUTURE_HORIZON;

  // Ascending range.
  const allYears: number[] = [];
  for (let y = oldest; y <= newest; y++) allYears.push(y);

  let page: number[];
  let hasNextPage: boolean;
  let hasPreviousPage: boolean;
  if (forward) {
    const startIdx =
      cursorYear != null ? allYears.findIndex((y) => y > cursorYear) : 0;
    const windowStart = startIdx === -1 ? allYears.length : startIdx;
    page = allYears.slice(windowStart, windowStart + limit);
    hasNextPage = windowStart + limit < allYears.length;
    hasPreviousPage = windowStart > 0;
  } else {
    const endIdxExclusive =
      cursorYear != null
        ? (() => {
            const idx = allYears.findIndex((y) => y >= cursorYear);
            return idx === -1 ? allYears.length : idx;
          })()
        : allYears.length;
    const windowStart = Math.max(0, endIdxExclusive - limit);
    page = allYears.slice(windowStart, endIdxExclusive);
    hasNextPage = endIdxExclusive < allYears.length;
    hasPreviousPage = windowStart > 0;
  }

  const loaded = await Promise.all(page.map((y) => PlanningYear.load(y)));
  return buildConnection<PlanningYear>(
    loaded,
    (node) => encodeCursor(String(node.yearNumber), String(node.yearNumber)),
    { hasNextPage, hasPreviousPage },
  );
}

/** FY-start calendar year for an arbitrary date — 6 April is the cutover. */
function fyStartFor(d: Date): number {
  const APRIL = 3;
  const beforeCutover =
    d.getMonth() < APRIL || (d.getMonth() === APRIL && d.getDate() < 6);
  return beforeCutover ? d.getFullYear() - 1 : d.getFullYear();
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

  return PlanningYear.load(yearNumber);
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

  return PlanningAccount.load({
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
 * Resolve a list of starting-calendar-year numbers into `PlanningYear` objects. Since `PlanningYear.load` always synthesises a year, every requested year is returned (sorted ascending).
 */
export async function planningYearsForYears(
  yearNumbers: number[],
): Promise<PlanningYear[]> {
  if (yearNumbers.length === 0) return [];
  const sorted = [...new Set(yearNumbers)].sort((a, b) => a - b);
  return Promise.all(sorted.map((y) => PlanningYear.load(y)));
}

/**
 * Ensure the `PlanningYears` and `PlanningMonths` rows backing `(year, date)` exist, creating them on demand. Safe to call from any year-scoped mutation before inserting into a table that FKs to `PlanningMonths` — the row isn't materialised until a mutation actually needs it, so `planningYears` / `planningYearCurrent` can keep returning synthetic years until the user writes something.
 */
export async function ensurePlanningMonth(
  year: number,
  date: Date,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .insert(PlanningYears)
      .values({ year })
      .onConflictDoNothing({ target: PlanningYears.year });
    await tx
      .insert(PlanningMonths)
      .values({ year, date })
      .onConflictDoNothing({
        target: [PlanningMonths.year, PlanningMonths.date],
      });
  });
}

/** The UK financial year covering today — dates before 6 April belong to the previous calendar year. */
function currentFYStart(): number {
  const now = new Date();
  const APRIL = 3; // getMonth is 0-indexed
  const beforeCutover =
    now.getMonth() < APRIL || (now.getMonth() === APRIL && now.getDate() < 6);
  return beforeCutover ? now.getFullYear() - 1 : now.getFullYear();
}

function parsePlanningYearId(id: string): number | null {
  if (!/^\d{4}$/.test(id)) return null;
  const n = Number(id);
  return Number.isFinite(n) ? n : null;
}

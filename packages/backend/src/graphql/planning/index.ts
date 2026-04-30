import { strict as assert } from "node:assert";

import { eq, gt, sql } from "drizzle-orm";
import type { ID, Int } from "grats";

import { HOME_CURRENCY } from "@/config";
import { db } from "@/db";
import { NetWorthCategoryAssets, NetWorthEntries } from "@/db/schema/net-worth";
import {
  PlanningAccounts,
  PlanningMonths,
  PlanningYears,
  PlanningYearUKTaxRates,
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
import {
  type LiabilityRow,
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

  /** Memoised bundle of every row the year's downstream resolvers might want. Lazy so that resolvers reading only `{ id }` (e.g. the year-switcher footer's `planningYears(last: 9)` edge list) don't fire ~10 SQL queries per year just to materialise the object. */
  private loadedPromise: Promise<{
    data: PlanningYearData;
    monthDates: Date[];
  }> | null = null;

  constructor(yearNumber: number) {
    this.yearNumber = yearNumber;
    this.id = String(yearNumber) as ID;
  }

  /** Construct a `PlanningYear` by id without touching the database — year data is loaded lazily by the field resolvers that actually need it. A year is always returned (even when no `PlanningYears` row exists yet) because the downstream view is synthetic in that case. */
  static load(yearNumber: number): PlanningYear {
    return new PlanningYear(yearNumber);
  }

  /** Load (and memoise) the per-year data bundle and the month key dates. Shared between `taxRates` / `months` / `accounts` so a single query selecting all three fires one DB batch, not three. */
  private loaded(): Promise<{ data: PlanningYearData; monthDates: Date[] }> {
    this.loadedPromise ??= (async () => {
      const [monthRows, accounts] = await Promise.all([
        db
          .select()
          .from(PlanningMonths)
          .where(eq(PlanningMonths.year, this.yearNumber)),
        loadPlanningAccountInfos(),
      ]);
      const data = await loadPlanningYearData(this.yearNumber, accounts);
      const monthDates =
        monthRows.length > 0
          ? monthRows
              .map((r) => r.date)
              .sort((a, b) => a.getTime() - b.getTime())
          : monthsInFYYear(this.yearNumber);
      return { data, monthDates };
    })();
    return this.loadedPromise;
  }

  /** Tax parameters for this year (`null` if none configured). @gqlField */
  async taxRates(): Promise<PlanningYearTaxRates | null> {
    const { data } = await this.loaded();
    return data.rates ? new PlanningYearTaxRatesUK(data.rates) : null;
  }

  /** The months making up this financial year. @gqlField */
  async months(): Promise<PlanningMonth[]> {
    const { data, monthDates } = await this.loaded();
    return monthDates.map(
      (date) =>
        new PlanningMonth({ year: this.yearNumber, date, yearData: data }),
    );
  }

  /** All assigned planning accounts (not year-scoped — returned here for convenience). @gqlField */
  async accounts(): Promise<PlanningAccount[]> {
    const { data } = await this.loaded();
    return data.accounts.map((info) =>
      PlanningAccount.load({
        assetId: info.assetId,
        alias: info.alias,
        asset: info.asset,
        target: info.target,
        targetCurrency: info.targetCurrency,
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
      const target =
        info.target != null && info.targetCurrency != null
          ? Money.fromMinorDenomination(info.target, info.targetCurrency)
          : null;
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
        target,
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
  /** Target month-end closing balance for the underlying planning account, or null if no target is set. Constant across the year — the field lives here so a single grid query selecting `accounts.target` and `valueEnd` can drive cell highlighting in one fetch. @gqlField */
  target!: Money | null;

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
    target: Money | null;
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
    this.target = data.target;
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
  /** True when the transaction is an engine-generated prediction (forthcoming bill, predicted salary, projected liability payment, …) rather than something the user has recorded. Distinct from `isProvisional`, which flags a user-authored draft. @gqlField */
  readonly isProjected: boolean;
  /** True when the transaction is a user-authored draft — included in the planner's balance projections but treated as "not yet committed" by every "actual money" aggregate. Only ever true on manual transactions; engine-generated projections (`isProjected`) and payslip rows are never provisional. @gqlField */
  readonly isProvisional: boolean;
  /** True when the transaction can be edited directly; usually `!isProjected`, but the receiving side of a manual transfer is neither projected nor editable. @gqlField */
  readonly isEditable: boolean;
  /** True when the row is a recurring bill (predicted or override). Bills that service a liability also set `liability`; bills without one are generic (utilities, rent, subscriptions, ...). @gqlField */
  readonly isBill: boolean;
  /** True when the row is the gross pay line of a payslip — either a real `PlanningPayslips` row or a projected earning that will materialise into one. Payslip *deductions* (tax / NIC / student loan) are not flagged here. @gqlField */
  readonly isPayslipGross: boolean;
  /** True when the row is a payslip deduction or adjustment (income tax, NIC, student loan, pension, manual adjustment) attached to the immediately-preceding `isPayslipGross` row. Lets the UI indent these as children of their parent gross. @gqlField */
  readonly isPayslipDeduction: boolean;
  // The link FKs are stored opaque; we only materialise the full
  // `PlanningAccount` / `NetWorthCategoryLiability` / `NetWorthCategoryAsset`
  // instances lazily via their `fromId` factories so selecting just `{ id }`
  // doesn't hit the DB. Each lazy instance caches its row once loaded.
  readonly toAccountId: string | null;
  readonly fromAccountId: string | null;
  readonly liabilityId: string | null;
  readonly assetId: string | null;
  /** When constructed from inside a `PlanningYear` roll-up, a shared map of every liability referenced anywhere in the year (pre-loaded in one batch by `loadPlanningYearData`). Lets `liability()` resolve synchronously without firing a per-row `SELECT` — avoids an N+1 across the dozens of transactions a planning-grid query returns. Null on one-off constructions (e.g. mutation return values) where lazy `fromId` loading is fine. */
  private readonly liabilitiesById: Map<string, LiabilityRow> | null;

  constructor(data: {
    id: ID;
    name: string;
    amount: Money;
    isProjected: boolean;
    isProvisional?: boolean;
    isEditable: boolean;
    isBill?: boolean;
    isPayslipGross?: boolean;
    isPayslipDeduction?: boolean;
    toAccountId: string | null;
    fromAccountId?: string | null;
    liabilityId: string | null;
    assetId: string | null;
    liabilitiesById?: Map<string, LiabilityRow> | null;
  }) {
    this.id = data.id;
    this.name = data.name;
    this.amount = data.amount;
    this.isProjected = data.isProjected;
    this.isProvisional = data.isProvisional ?? false;
    this.isEditable = data.isEditable;
    this.isBill = data.isBill ?? false;
    this.isPayslipGross = data.isPayslipGross ?? false;
    this.isPayslipDeduction = data.isPayslipDeduction ?? false;
    this.toAccountId = data.toAccountId;
    this.fromAccountId = data.fromAccountId ?? null;
    this.liabilityId = data.liabilityId;
    this.assetId = data.assetId;
    this.liabilitiesById = data.liabilitiesById ?? null;
  }

  /** Destination planning account for the from-side of a manual transfer. Null on every other kind of transaction (the to-side, predictions, payslips, ...). @gqlField */
  toAccount(): PlanningAccount | null {
    return this.toAccountId == null
      ? null
      : PlanningAccount.fromId(this.toAccountId);
  }

  /** Source planning account for the to-side of a manual transfer (the mirror credit landing in the receiving account). Null on every other kind of transaction. @gqlField */
  fromAccount(): PlanningAccount | null {
    return this.fromAccountId == null
      ? null
      : PlanningAccount.fromId(this.fromAccountId);
  }

  /** Liability this row services (e.g. a payslip adjustment tagged with a student-loan liability, a credit-card payment). Null on every other kind of transaction. @gqlField */
  liability(): NetWorthCategoryLiability | null {
    if (this.liabilityId == null) return null;
    const preloaded = this.liabilitiesById?.get(this.liabilityId);
    return preloaded
      ? NetWorthCategoryLiability.load(preloaded)
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
  target: number | null;
  targetCurrency: string | null;
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
        target: row.account.target,
        targetCurrency: row.account.currency,
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

  /** Target month-end closing balance the user wants this account to hold. Null when no target is set. @gqlField */
  async target(): Promise<Money | null> {
    const d = await this.data();
    if (d.target == null || d.targetCurrency == null) return null;
    return Money.fromMinorDenomination(d.target, d.targetCurrency);
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

  const loaded = page.map((y) => PlanningYear.load(y));
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
 * Attach a NetWorthCategoryAsset as a planning account, optionally with a display alias and a target month-end closing balance. Pass `target: null` to clear an existing target. The asset's reporting currency is the home currency, so `target.currency` must match it.
 *
 * @gqlMutationField
 */
export async function planningAccountAssign(
  assetId: ID,
  alias?: string | null,
  target?: MoneyInput | null,
): Promise<PlanningAccount> {
  const [asset] = await db
    .select()
    .from(NetWorthCategoryAssets)
    .where(eq(NetWorthCategoryAssets.id, assetId));
  assert(asset, `NetWorthCategoryAsset ${assetId} not found`);

  const targetMinor =
    target == null ? null : getMoneyInputFractionalAmount(target);
  if (targetMinor != null) {
    assert(
      targetMinor.currency === HOME_CURRENCY,
      `Target currency ${targetMinor.currency} does not match the asset's currency ${HOME_CURRENCY}.`,
    );
  }

  const row = await db.transaction(async (tx) => {
    const [{ max }] = await tx
      .select({ max: sql<number | null>`max(${PlanningAccounts.sortOrder})` })
      .from(PlanningAccounts);
    const nextOrder = max == null ? 0 : max + 1;
    const [inserted] = await tx
      .insert(PlanningAccounts)
      .values({
        accountId: assetId,
        alias: alias ?? null,
        sortOrder: nextOrder,
        target: targetMinor?.amount ?? null,
        currency: targetMinor?.currency ?? null,
      })
      .onConflictDoUpdate({
        target: PlanningAccounts.accountId,
        set: {
          alias: alias ?? null,
          target: targetMinor?.amount ?? null,
          currency: targetMinor?.currency ?? null,
          updatedAt: new Date(),
        },
      })
      .returning();
    return inserted;
  });

  return PlanningAccount.load({
    assetId: row.accountId,
    alias: row.alias,
    asset: NetWorthCategoryAsset.load(asset),
    target: row.target,
    targetCurrency: row.currency,
  });
}

/**
 * Remove a planning account. Idempotent — returns `Void` even if the account wasn't assigned.
 *
 * @gqlMutationField
 */
export async function planningAccountUnassign(assetId: ID): Promise<Void> {
  await db.transaction(async (tx) => {
    const [removed] = await tx
      .delete(PlanningAccounts)
      .where(eq(PlanningAccounts.accountId, assetId))
      .returning({ sortOrder: PlanningAccounts.sortOrder });
    if (removed) {
      // Keep `sortOrder` a dense 0..N-1 range so the reorder mutation can
      // keep treating position as a direct index.
      await tx
        .update(PlanningAccounts)
        .set({ sortOrder: sql`${PlanningAccounts.sortOrder} - 1` })
        .where(gt(PlanningAccounts.sortOrder, removed.sortOrder));
    }
  });
  return VOID;
}

/**
 * Move the planning account identified by `id` (a `PlanningAccount.id`) to 0-based `position` in the user-defined order, shifting everything between its old and new slot by one. Clamps `position` to the valid range.
 *
 * @gqlMutationField
 */
export async function planningAccountReorder(
  id: ID,
  position: Int,
): Promise<PlanningAccount> {
  await db.transaction(async (tx) => {
    const [moved] = await tx
      .select({ sortOrder: PlanningAccounts.sortOrder })
      .from(PlanningAccounts)
      .where(eq(PlanningAccounts.accountId, id));
    assert(moved, `PlanningAccount ${id} not found`);

    // One `UPDATE` with a `CASE` — the moved row takes the target slot and
    // every row between old and new shifts by one, all inside a single
    // statement. The unique `sortOrder` constraint is `DEFERRABLE INITIALLY
    // DEFERRED`, so transient duplicates mid-statement are fine.
    await tx.update(PlanningAccounts).set({
      sortOrder: sql`
        CASE
          WHEN ${PlanningAccounts.accountId} = ${id} THEN ${position}
          WHEN ${position} < ${moved.sortOrder}
            AND ${PlanningAccounts.sortOrder} >= ${position}
            AND ${PlanningAccounts.sortOrder} < ${moved.sortOrder}
            THEN ${PlanningAccounts.sortOrder} + 1
          WHEN ${position} > ${moved.sortOrder}
            AND ${PlanningAccounts.sortOrder} > ${moved.sortOrder}
            AND ${PlanningAccounts.sortOrder} <= ${position}
            THEN ${PlanningAccounts.sortOrder} - 1
          ELSE ${PlanningAccounts.sortOrder}
        END
      `,
      updatedAt: new Date(),
    });
  });

  return PlanningAccount.fromId(id);
}

/**
 * Resolve a list of starting-calendar-year numbers into `PlanningYear` objects. Since `PlanningYear.load` always synthesises a year, every requested year is returned (sorted ascending).
 */
export function planningYearsForYears(yearNumbers: number[]): PlanningYear[] {
  if (yearNumbers.length === 0) return [];
  const sorted = [...new Set(yearNumbers)].sort((a, b) => a - b);
  return sorted.map((y) => PlanningYear.load(y));
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

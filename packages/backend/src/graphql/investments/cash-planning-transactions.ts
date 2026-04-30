import { and, desc, eq, gt, lt, or, sql } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import { GraphQLError } from "graphql";
import type { ID, Int } from "grats";

import { db } from "@/db";
import { InvestmentDeposits } from "@/db/schema/investments";
import {
  NetWorthCategoryAssets,
  NetWorthEntries,
  NetWorthValueAmounts,
  NetWorthValues,
} from "@/db/schema/net-worth";
import { PlanningTransactions } from "@/db/schema/planning";

import type { Context } from "../context";
import type { Date as CalendarDate } from "../date";
import {
  getMoneyInputFractionalAmount,
  Money,
  type MoneyInput,
} from "../money";
import {
  buildConnection,
  type Connection,
  decodeCursor,
  encodeCursor,
} from "../pagination";
import { ensurePlanningMonth, PlanningAccount } from "../planning/index";
import { monthId as monthIdForDate } from "../planning/months";
import {
  decodePlanningTransactionId,
  encodePlanningTransactionId,
} from "../planning/transactions";
import { VOID, type Void } from "../void";
import { InvestmentDeposit } from "./deposits";

/** A cash-account → wrapper planning transaction surfaced on the investments page. The `id` matches the composite `tx:` identifier returned by the planning grid, so it can be fed straight back into `transactionUpdate` / `transactionDelete` if needed — but the dedicated `assetCashTransaction*` mutations are the supported edit path from this view. @gqlType */
export class AssetCashPlanningTransaction {
  constructor(
    /** @gqlField */
    public readonly id: ID,
    /** Calendar date the transaction is anchored to. Drives the planning month it lives in. @gqlField */
    public readonly date: CalendarDate,
    /** @gqlField */
    public readonly name: string,
    /** Stored cash-account-POV amount in minor units. Negated when surfaced via `amount()` so the GraphQL field reads from the wrapper's perspective. */
    private readonly amountMinorCashPov: number,
    private readonly currency_: string,
    private readonly fromAccountId: string,
    /** True when the transaction is a user-authored draft — modelled in the planner's balance projections but not part of the wrapper's actual cash float. Provisional transactions are excluded from `cashContributions` server-side; this field exists so the planning grid can render them with a distinguishing style. @gqlField */
    public readonly isProvisional: boolean,
  ) {}

  /** Signed cash amount from the wrapper's perspective: positive = deposit into the wrapper, negative = withdrawal from the wrapper. Every consumer of `cashContributions` sees the same convention regardless of source. @gqlField */
  amount(): Money {
    return Money.fromMinorDenomination(
      -this.amountMinorCashPov,
      this.currency_,
    );
  }

  /** Source cash planning account the contribution flows from / to. @gqlField */
  fromAccount(): PlanningAccount {
    return PlanningAccount.fromId(this.fromAccountId);
  }
}

/** A net-worth-entry checkpoint surfaced inline in the per-wrapper cash-contributions ledger. Acts as a separator between cash-flow rows: `value` carries the wrapper's recorded value at the entry, or is `null` to mark the date the wrapper became defunct (the first entry that no longer included it). The cash-float computation anchors on these checkpoints — fees, dividends, and price drift between snapshots are silently absorbed by the next recorded value. @gqlType */
export class AssetValueSnapshot {
  constructor(
    /** Composite identifier — either `snapshot:<NetWorthValueAmounts.id>` for a recorded value, or `defunct:<assetId>` for a synthetic defunct marker. @gqlField */
    public readonly id: ID,
    /** Date the snapshot represents — the entry's date for a recorded value, or the date the wrapper first dropped out of an entry for a defunct marker. @gqlField */
    public readonly date: CalendarDate,
    /** Recorded value at this entry. `null` when this row is the synthetic defunct marker, signalling the wrapper has no active value at the latest entry. Named `value` (not `amount`) so a `... on AssetValueSnapshot { value }` selection in the same `cashContributions` query as `... on InvestmentDeposit { amount }` doesn't collide on a non-null vs. nullable `amount` field across the union. @gqlField */
    public readonly value: Money | null,
  ) {}
}

/** A single row in the per-wrapper cash-contributions ledger. Either an external `InvestmentDeposit` (dividend, tax relief, …), a manual `AssetCashPlanningTransaction` originating in a planning cash account, or an `AssetValueSnapshot` separator surfacing a `NetWorthEntries` checkpoint. @gqlUnion */
export type CashContribution =
  | InvestmentDeposit
  | AssetCashPlanningTransaction
  | AssetValueSnapshot;

const DEFAULT_PAGE_SIZE = 20;

/** Paginated, date-desc list of every cash contribution for the wrapper — external deposits, planning cash transfers, and `NetWorthEntries` snapshot checkpoints, interleaved by date. One SQL via `unionAll`: each source table projects to a common shape (with a `kind:rowId` sort key), the cursor's `(date, sortKey)` is applied as a `WHERE` predicate so we never overfetch, and the page is sliced + `LIMIT first + 1` server-side.
 *
 * On the first page (no cursor), if the wrapper has been recorded historically but is missing from the latest `NetWorthEntries`, a synthetic defunct-marker `AssetValueSnapshot` is prepended at the date of the first entry that omitted it. The marker is never returned on subsequent pages.
 */
export async function loadAssetCashContributionsConnection(
  assetId: string,
  first?: Int | null,
  after?: ID | null,
): Promise<Connection<CashContribution>> {
  const limit = first ?? DEFAULT_PAGE_SIZE;
  const cursor = after ? decodeCursor(after) : null;

  // Three branches with matching projection shape so `unionAll` types align.
  // `kind` discriminates the source table; `sortKey = kind || ':' || id`
  // (built in SQL) gives a deterministic deep-tie-break that's unique across
  // all three tables.
  //
  // Cursor predicate is pushed *down* into each branch (instead of wrapping
  // the union in an outer `WHERE`) so each branch's predicate touches only
  // its own columns. That lets Postgres pick the per-table `(assetId, date)`
  // index up front, rather than scanning + materialising the full union and
  // filtering afterwards.
  const cursorDate = cursor ? new Date(cursor.c) : null;
  const cursorSortKey = cursor ? cursor.i : null;

  function branchCursorPredicate(
    dateCol:
      | typeof InvestmentDeposits.date
      | typeof PlanningTransactions.date
      | typeof NetWorthEntries.date,
    sortKeyExpr: ReturnType<typeof sql>,
  ) {
    if (!cursorDate || cursorSortKey == null) return undefined;
    return or(
      lt(dateCol, cursorDate),
      and(eq(dateCol, cursorDate), lt(sortKeyExpr, cursorSortKey)),
    );
  }

  type Kind = "deposit" | "tx" | "snapshot";
  const depositsBranch = db
    .select({
      kind: sql<Kind>`'deposit'`.as("kind"),
      rowId: sql<string>`${InvestmentDeposits.id}::text`.as("rowId"),
      sortKey: sql<string>`'deposit:' || ${InvestmentDeposits.id}::text`.as(
        "sortKey",
      ),
      date: InvestmentDeposits.date,
      name: InvestmentDeposits.name,
      amount: InvestmentDeposits.amount,
      currency: InvestmentDeposits.currency,
      accountId: sql<string | null>`NULL::uuid`.as("accountId"),
    })
    .from(InvestmentDeposits)
    .where(
      and(
        eq(InvestmentDeposits.assetId, assetId),
        branchCursorPredicate(
          InvestmentDeposits.date,
          sql`'deposit:' || ${InvestmentDeposits.id}::text`,
        ),
      ),
    );

  const txBranch = db
    .select({
      kind: sql<Kind>`'tx'`.as("kind"),
      rowId: sql<string>`${PlanningTransactions.id}::text`.as("rowId"),
      sortKey: sql<string>`'tx:' || ${PlanningTransactions.id}::text`.as(
        "sortKey",
      ),
      date: PlanningTransactions.date,
      name: PlanningTransactions.name,
      amount: PlanningTransactions.amount,
      currency: PlanningTransactions.currency,
      accountId: sql<string | null>`${PlanningTransactions.accountId}`.as(
        "accountId",
      ),
    })
    .from(PlanningTransactions)
    .where(
      and(
        eq(PlanningTransactions.assetId, assetId),
        // Provisional rows are user-authored drafts — they sit in the
        // planner's balance projections but aren't real cash inflows /
        // outflows yet, so they don't belong on the "actual cash
        // contributions" feed.
        eq(PlanningTransactions.isProvisional, false),
        branchCursorPredicate(
          PlanningTransactions.date,
          sql`'tx:' || ${PlanningTransactions.id}::text`,
        ),
      ),
    );

  const snapshotBranch = db
    .select({
      kind: sql<Kind>`'snapshot'`.as("kind"),
      rowId: sql<string>`${NetWorthValueAmounts.id}::text`.as("rowId"),
      sortKey: sql<string>`'snapshot:' || ${NetWorthValueAmounts.id}::text`.as(
        "sortKey",
      ),
      date: NetWorthEntries.date,
      // `name` is unused for snapshot rows; project an empty string so the
      // branch shape lines up with the deposit / tx branches.
      name: sql<string>`''`.as("name"),
      amount: NetWorthValueAmounts.amount,
      currency: NetWorthValueAmounts.currency,
      accountId: sql<string | null>`NULL::uuid`.as("accountId"),
    })
    .from(NetWorthValues)
    .innerJoin(
      NetWorthValueAmounts,
      eq(NetWorthValueAmounts.valueId, NetWorthValues.id),
    )
    .innerJoin(NetWorthEntries, eq(NetWorthEntries.id, NetWorthValues.entryId))
    .where(
      and(
        eq(NetWorthValues.categoryAssetId, assetId),
        branchCursorPredicate(
          NetWorthEntries.date,
          sql`'snapshot:' || ${NetWorthValueAmounts.id}::text`,
        ),
      ),
    );

  const contributions = unionAll(depositsBranch, txBranch, snapshotBranch).as(
    "contributions",
  );

  // The synthetic defunct marker (if any) consumes one slot on the first
  // page only; reduce the SQL limit to keep the total node count at `limit`.
  const defunct = cursor === null ? await loadDefunctMarker(assetId) : null;
  const realLimit = defunct ? Math.max(0, limit - 1) : limit;

  const rows = await db
    .select()
    .from(contributions)
    .orderBy(desc(contributions.date), desc(contributions.sortKey))
    .limit(realLimit + 1);

  const hasNextPage = rows.length > realLimit;
  const page = hasNextPage ? rows.slice(0, realLimit) : rows;

  const realNodes: CashContribution[] = page.map((r) => {
    if (r.kind === "deposit") {
      return new InvestmentDeposit(
        r.rowId as ID,
        assetId,
        r.date,
        r.amount,
        r.currency,
        r.name,
      );
    }
    if (r.kind === "snapshot") {
      return new AssetValueSnapshot(
        `snapshot:${r.rowId}` as ID,
        r.date,
        Money.fromMinorDenomination(r.amount, r.currency),
      );
    }
    // `tx` branch — `accountId` is non-null in this branch, and the where
    // clause excludes provisional rows so `isProvisional` is always false
    // here. We still pass it through explicitly so the constructor stays
    // truthful if the filter ever changes.
    return new AssetCashPlanningTransaction(
      encodePlanningTransactionId({ kind: "tx", id: r.rowId }),
      r.date,
      r.name,
      r.amount,
      r.currency,
      r.accountId!,
      false,
    );
  });

  const nodes: CashContribution[] = defunct
    ? [defunct, ...realNodes]
    : realNodes;

  const cursorByNode = new Map<CashContribution, ID>();
  if (defunct) {
    // The defunct marker's cursor is never used to paginate — it's only
    // emitted on the first page. Encode something distinct so the wire
    // type stays uniform without colliding with any real row.
    cursorByNode.set(
      defunct,
      encodeCursor(new Date(defunct.date).toISOString(), `defunct:${assetId}`),
    );
  }
  page.forEach((r, idx) => {
    cursorByNode.set(
      realNodes[idx]!,
      encodeCursor(r.date.toISOString(), r.sortKey),
    );
  });
  return buildConnection<CashContribution>(
    nodes,
    (node) => cursorByNode.get(node)!,
    { hasNextPage, hasPreviousPage: cursor != null },
  );
}

/** Synthetic "defunct since" marker for a wrapper that's been recorded historically but is absent from the latest `NetWorthEntries`. The date is the first entry that no longer included it; `null` amount distinguishes it from a recorded snapshot. Returns `null` when the wrapper either has never been recorded (still pending its first entry) or is still present in the latest entry (active). */
async function loadDefunctMarker(
  assetId: string,
): Promise<AssetValueSnapshot | null> {
  // Single round-trip: subselect picks the wrapper's most recent recorded
  // date, the outer `MIN(...)` finds the first entry strictly after that.
  // When the asset has never been recorded, the subselect is `NULL` and
  // `> NULL` filters everything out → outer `MIN` is `NULL`, no marker.
  // When the latest entry still includes the asset, no rows satisfy the
  // predicate → outer `MIN` is `NULL` again.
  const lastSeen = db
    .select({ d: sql<Date | null>`MAX(${NetWorthEntries.date})` })
    .from(NetWorthValues)
    .innerJoin(NetWorthEntries, eq(NetWorthEntries.id, NetWorthValues.entryId))
    .where(eq(NetWorthValues.categoryAssetId, assetId));
  const [row] = await db
    .select({ d: NetWorthEntries.date })
    .from(NetWorthEntries)
    .where(gt(NetWorthEntries.date, lastSeen))
    .orderBy(NetWorthEntries.date)
    .limit(1);
  if (!row?.d) return null;
  return new AssetValueSnapshot(`defunct:${assetId}` as ID, row.d, null);
}

async function assertAssetIsStockOrPension(assetId: string): Promise<void> {
  const [row] = await db
    .select({ type: NetWorthCategoryAssets.type })
    .from(NetWorthCategoryAssets)
    .where(eq(NetWorthCategoryAssets.id, assetId));
  if (!row) throw new GraphQLError(`Asset ${assetId} not found`);
  if (row.type !== "STOCK" && row.type !== "PENSION") {
    throw new GraphQLError(
      `Asset ${assetId} must be STOCK or PENSION, got ${row.type}`,
    );
  }
}

async function assertCashPlanningAccount(accountId: string): Promise<void> {
  const [row] = await db
    .select({ type: NetWorthCategoryAssets.type })
    .from(NetWorthCategoryAssets)
    .where(eq(NetWorthCategoryAssets.id, accountId));
  if (!row) throw new GraphQLError(`Cash account ${accountId} not found`);
  if (row.type !== "CASH") {
    throw new GraphQLError(
      `Cash account ${accountId} must be CASH, got ${row.type}`,
    );
  }
}

/** Anchor `date` to the first of its month — `PlanningTransactions.(year, date)` FKs into `PlanningMonths`, which only ever stores the first of each month, so cash transfers shouldn't carry a free-form day component. */
function firstOfMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

async function decodeTxId(id: ID): Promise<string> {
  const parsed = decodePlanningTransactionId(id);
  if (parsed.kind !== "tx") {
    throw new GraphQLError(
      `assetCashTransaction* mutations only operate on manual planning transactions ('tx:' kind), got ${parsed.kind}`,
    );
  }
  return parsed.id;
}

async function loadCashTx(id: string): Promise<{
  date: Date;
  amount: number;
  currency: string;
  accountId: string;
  assetId: string;
  name: string;
  isProvisional: boolean;
}> {
  const [row] = await db
    .select({
      date: PlanningTransactions.date,
      amount: PlanningTransactions.amount,
      currency: PlanningTransactions.currency,
      accountId: PlanningTransactions.accountId,
      assetId: PlanningTransactions.assetId,
      name: PlanningTransactions.name,
      isProvisional: PlanningTransactions.isProvisional,
    })
    .from(PlanningTransactions)
    .where(eq(PlanningTransactions.id, id));
  if (!row || row.assetId == null) {
    throw new GraphQLError(`Cash transfer ${id} not found`);
  }
  return {
    date: row.date,
    amount: row.amount,
    currency: row.currency,
    accountId: row.accountId,
    assetId: row.assetId,
    name: row.name,
    isProvisional: row.isProvisional,
  };
}

function toContribution(row: {
  id: string;
  date: Date;
  name: string;
  amount: number;
  currency: string;
  accountId: string;
  isProvisional: boolean;
}): AssetCashPlanningTransaction {
  return new AssetCashPlanningTransaction(
    encodePlanningTransactionId({ kind: "tx", id: row.id }),
    row.date,
    row.name,
    row.amount,
    row.currency,
    row.accountId,
    row.isProvisional,
  );
}

/** Invalidate every cache slice an asset-tagged planning-transaction write can stale: the wrapper's `cashContributions` connection (lives on `NetWorthCategoryAsset` — an entity, so the typename→rootFields walker stops there and we have to invalidate the wrapper directly), the planning grid (reaches `PlanningTransaction`), and `Portfolio.cash` / `Portfolio.totalValue` (reach `Portfolio`). */
function invalidateCashTransactionReachable(ctx: Context): void {
  ctx.invalidate({ typename: "AssetCashPlanningTransaction", id: null });
  ctx.invalidate({ typename: "NetWorthCategoryAsset", id: null });
  ctx.invalidate({ typename: "PlanningTransaction", id: null });
  ctx.invalidate({ typename: "Portfolio", id: null });
}

/** Create a cash-account → wrapper planning transaction. `amount` is signed from the **wrapper's** perspective: positive = deposit into the wrapper, negative = withdrawal from it. The resolver flips the sign internally before persisting (the underlying `PlanningTransactions` row stores everything from the cash account's perspective). @gqlMutationField */
export async function assetCashTransactionCreate(
  ctx: Context,
  /** Wrapper to credit / debit. Must be a `STOCK` or `PENSION` net-worth asset. */
  assetId: ID,
  /** Source cash planning account (`PlanningAccount.id`). */
  fromAccountId: ID,
  date: CalendarDate,
  /** Wrapper-perspective amount: positive = into the wrapper, negative = out. */
  amount: MoneyInput,
  name: string,
  /** Mark the row as a user-authored draft. Provisional rows are excluded from the wrapper's actual cash float and the `cashContributions` list, but still surface in the planner's balance projections. Defaults to `false`. */
  isProvisional?: boolean | null,
): Promise<AssetCashPlanningTransaction> {
  await assertAssetIsStockOrPension(assetId);
  await assertCashPlanningAccount(fromAccountId);
  const { currency, amount: amountMinorWrapper } =
    getMoneyInputFractionalAmount(amount);
  const monthAnchored = firstOfMonth(date);
  const monthId = monthIdForDate(monthAnchored);
  const { year } = await ensurePlanningMonthForId(monthId);
  const [row] = await db
    .insert(PlanningTransactions)
    .values({
      year,
      date: monthAnchored,
      // Cash-account POV: a deposit into the wrapper is a debit on the cash
      // account, so the stored amount is the negation of the wrapper-POV
      // amount the caller passed.
      amount: -amountMinorWrapper,
      currency,
      name,
      accountId: fromAccountId,
      assetId,
      isProvisional: isProvisional ?? false,
    })
    .returning();
  invalidateCashTransactionReachable(ctx);
  return toContribution(row);
}

/** Partial update for a cash transfer. `amount`, when supplied, is wrapper-POV (positive = into the wrapper). Omitted / null fields are left unchanged. @gqlMutationField */
export async function assetCashTransactionUpdate(
  ctx: Context,
  /** Composite `tx:` id as returned on `AssetCashPlanningTransaction.id`. */
  id: ID,
  date?: CalendarDate | null,
  amount?: MoneyInput | null,
  name?: string | null,
  /** New source cash planning account (`PlanningAccount.id`). */
  fromAccountId?: ID | null,
  /** Toggle the user-authored-draft flag. */
  isProvisional?: boolean | null,
): Promise<AssetCashPlanningTransaction> {
  const rowId = await decodeTxId(id);
  // Asserts the row exists + is asset-tagged before we patch.
  await loadCashTx(rowId);

  const patch: Partial<typeof PlanningTransactions.$inferInsert> = {};
  if (name != null) patch.name = name;
  if (fromAccountId != null) {
    await assertCashPlanningAccount(fromAccountId);
    patch.accountId = fromAccountId;
  }
  if (amount != null) {
    const { currency, amount: amountMinorWrapper } =
      getMoneyInputFractionalAmount(amount);
    patch.amount = -amountMinorWrapper;
    patch.currency = currency;
  }
  if (date != null) {
    const monthAnchored = firstOfMonth(date);
    const monthId = monthIdForDate(monthAnchored);
    const { year } = await ensurePlanningMonthForId(monthId);
    patch.year = year;
    patch.date = monthAnchored;
  }
  if (isProvisional != null) {
    patch.isProvisional = isProvisional;
  }

  if (Object.keys(patch).length > 0) {
    await db
      .update(PlanningTransactions)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(PlanningTransactions.id, rowId));
  }
  const updated = await loadCashTx(rowId);
  invalidateCashTransactionReachable(ctx);
  return toContribution({
    id: rowId,
    date: updated.date,
    name: updated.name,
    amount: updated.amount,
    currency: updated.currency,
    accountId: updated.accountId,
    isProvisional: updated.isProvisional,
  });
}

/** Delete a cash transfer. @gqlMutationField */
export async function assetCashTransactionDelete(
  ctx: Context,
  /** Composite `tx:` id as returned on `AssetCashPlanningTransaction.id`. */
  id: ID,
): Promise<Void> {
  const rowId = await decodeTxId(id);
  await db
    .delete(PlanningTransactions)
    .where(eq(PlanningTransactions.id, rowId));
  invalidateCashTransactionReachable(ctx);
  return VOID;
}

/** Resolve a `mon-YYYY` id to the `(year, monthStart)` pair `PlanningTransactions` FKs into, creating the `PlanningMonths` row if it doesn't exist yet. */
async function ensurePlanningMonthForId(
  monthId: string,
): Promise<{ year: number; date: Date }> {
  // Re-derive `(year, monthStart)` from the id so we don't have to plumb the
  // already-parsed value through every caller.
  const m = /^([a-z]{3})-(\d{4})$/.exec(monthId);
  if (!m) throw new GraphQLError(`Bad month id: ${monthId}`);
  const monthIdx = MONTH_SHORT.indexOf(m[1]);
  if (monthIdx < 0) throw new GraphQLError(`Bad month id: ${monthId}`);
  const calendarYear = Number(m[2]);
  const monthStart = new Date(Date.UTC(calendarYear, monthIdx, 1));
  // UK FY: April (3) onwards belongs to the FY that started this calendar
  // year; January–March belong to the previous FY.
  const fyYear = monthIdx >= 3 ? calendarYear : calendarYear - 1;
  await ensurePlanningMonth(fyYear, monthStart);
  return { year: fyYear, date: monthStart };
}

const MONTH_SHORT = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];

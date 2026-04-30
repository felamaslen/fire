import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import { GraphQLError } from "graphql";
import type { ID, Int } from "grats";

import { db } from "@/db";
import { InvestmentDeposits } from "@/db/schema/investments";
import { NetWorthCategoryAssets } from "@/db/schema/net-worth";
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
  ) {}

  /** Signed cash amount from the *wrapper's* perspective: positive = deposit into the wrapper, negative = withdrawal from the wrapper. The underlying `PlanningTransactions` row stores the sign from the cash account's perspective; this resolver flips it so every consumer of `cashContributions` sees the same convention regardless of source. @gqlField */
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

/** A single row in the per-wrapper cash-contributions ledger. Either an external `InvestmentDeposit` (dividend, tax relief, …) or a manual `AssetCashPlanningTransaction` originating in a planning cash account. @gqlUnion */
export type CashContribution = InvestmentDeposit | AssetCashPlanningTransaction;

const DEFAULT_PAGE_SIZE = 20;

/** Paginated, date-desc list of every cash contribution for the wrapper — both external deposits and planning cash transfers, interleaved by date. One SQL via `unionAll`: both source tables project to a common shape (with a `kind:rowId` sort key), the cursor's `(date, sortKey)` is applied as a `WHERE` predicate so we never overfetch, and the page is sliced + `LIMIT first + 1` server-side. */
export async function loadAssetCashContributionsConnection(
  assetId: string,
  first?: Int | null,
  after?: ID | null,
): Promise<Connection<CashContribution>> {
  const limit = first ?? DEFAULT_PAGE_SIZE;
  const cursor = after ? decodeCursor(after) : null;

  // Two branches with matching projection shape so `unionAll` types align.
  // `kind` discriminates the source table; `sortKey = kind || ':' || id`
  // (built in SQL) gives a deterministic deep-tie-break that's unique across
  // both tables.
  //
  // Cursor predicate is pushed *down* into each branch (instead of wrapping
  // the union in an outer `WHERE`) so each branch's predicate touches only
  // its own columns. That lets Postgres pick the per-table `(assetId, date)`
  // index up front, rather than scanning + materialising the full union and
  // filtering afterwards.
  const cursorDate = cursor ? new Date(cursor.c) : null;
  const cursorSortKey = cursor ? cursor.i : null;

  function branchCursorPredicate(
    dateCol: typeof InvestmentDeposits.date | typeof PlanningTransactions.date,
    sortKeyExpr: ReturnType<typeof sql>,
  ) {
    if (!cursorDate || cursorSortKey == null) return undefined;
    return or(
      lt(dateCol, cursorDate),
      and(eq(dateCol, cursorDate), lt(sortKeyExpr, cursorSortKey)),
    );
  }

  const depositsBranch = db
    .select({
      kind: sql<"deposit" | "tx">`'deposit'`.as("kind"),
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
      kind: sql<"deposit" | "tx">`'tx'`.as("kind"),
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
        branchCursorPredicate(
          PlanningTransactions.date,
          sql`'tx:' || ${PlanningTransactions.id}::text`,
        ),
      ),
    );

  const contributions = unionAll(depositsBranch, txBranch).as("contributions");

  const rows = await db
    .select()
    .from(contributions)
    .orderBy(desc(contributions.date), desc(contributions.sortKey))
    .limit(limit + 1);

  const hasNextPage = rows.length > limit;
  const page = hasNextPage ? rows.slice(0, limit) : rows;

  const nodes: CashContribution[] = page.map((r) => {
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
    // `tx` branch — `accountId` is non-null in this branch.
    return new AssetCashPlanningTransaction(
      encodePlanningTransactionId({ kind: "tx", id: r.rowId }),
      r.date,
      r.name,
      r.amount,
      r.currency,
      r.accountId!,
    );
  });

  const cursorByNode = new Map<CashContribution, ID>();
  page.forEach((r, idx) => {
    cursorByNode.set(
      nodes[idx]!,
      encodeCursor(r.date.toISOString(), r.sortKey),
    );
  });
  return buildConnection<CashContribution>(
    nodes,
    (node) => cursorByNode.get(node)!,
    { hasNextPage, hasPreviousPage: cursor != null },
  );
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
}> {
  const [row] = await db
    .select({
      date: PlanningTransactions.date,
      amount: PlanningTransactions.amount,
      currency: PlanningTransactions.currency,
      accountId: PlanningTransactions.accountId,
      assetId: PlanningTransactions.assetId,
      name: PlanningTransactions.name,
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
  };
}

function toContribution(row: {
  id: string;
  date: Date;
  name: string;
  amount: number;
  currency: string;
  accountId: string;
}): AssetCashPlanningTransaction {
  return new AssetCashPlanningTransaction(
    encodePlanningTransactionId({ kind: "tx", id: row.id }),
    row.date,
    row.name,
    row.amount,
    row.currency,
    row.accountId,
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

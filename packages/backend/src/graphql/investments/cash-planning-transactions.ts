import { and, desc, eq, gt, lt, or, sql } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import { GraphQLError } from "graphql";
import type { Float, ID, Int } from "grats";

import { db } from "@/db";
import {
  InvestmentDeposits,
  Investments,
  InvestmentTransactions,
} from "@/db/schema/investments";
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
    private readonly runningBalanceMinor_: number | null = null,
  ) {}

  /** Signed cash amount from the wrapper's perspective: positive = deposit into the wrapper, negative = withdrawal from the wrapper. Every consumer of `cashContributions` sees the same convention regardless of source. @gqlField */
  amount(): Money {
    return Money.fromMinorDenomination(
      -this.amountMinorCashPov,
      this.currency_,
    );
  }

  /** Wrapper cash balance after this row — cumulative sum of every cash-affecting contribution (deposits, planning transfers, non-DRIP trades) up to and including this entry, in oldest-first order. `null` outside the cash-contributions feed. @gqlField */
  runningBalance(): Money | null {
    return this.runningBalanceMinor_ === null
      ? null
      : Money.fromMinorDenomination(this.runningBalanceMinor_, this.currency_);
  }

  /** Source cash planning account the contribution flows from / to. @gqlField */
  fromAccount(): PlanningAccount {
    return PlanningAccount.fromId(this.fromAccountId);
  }
}

/** A non-DRIP unit-trade booked against this wrapper, surfaced inline in the cash-contributions ledger as a pseudo-deposit so the running cash balance reflects the cash spent on the buy (or received from a sell), inclusive of taxes and broker fees. Read-only from this feed — edit the underlying `InvestmentTransaction` directly to change. DRIP rows are excluded since they don't move cash. @gqlType */
export class InvestmentTradePseudoTransaction {
  constructor(
    /** Composite `trade:<uuid>` id formed from the underlying `InvestmentTransaction.id`. @gqlField */
    public readonly id: ID,
    /** Calendar date the trade was executed. @gqlField */
    public readonly date: CalendarDate,
    /** Display label for the security — its ticker (e.g. `SMT.L`), falling back to the investment's display name when no ticker is set (i.e. funds). @gqlField */
    public readonly name: string,
    /** Signed units traded. Positive = buy, negative = sell. Mirrors the underlying `InvestmentTransaction.units`. @gqlField */
    public readonly units: Float,
    private readonly amountMinor: number,
    private readonly currency_: string,
    private readonly runningBalanceMinor_: number | null,
  ) {}

  /** Signed cash impact on the wrapper, including taxes and broker fees. Negative for buys (cash leaves the wrapper to cover units, taxes, and fees), positive for sells. @gqlField */
  amount(): Money {
    return Money.fromMinorDenomination(this.amountMinor, this.currency_);
  }

  /** Wrapper cash balance after this row — cumulative sum of every cash-affecting contribution (deposits, planning transfers, non-DRIP trades) up to and including this entry, in oldest-first order. `null` outside the cash-contributions feed. @gqlField */
  runningBalance(): Money | null {
    return this.runningBalanceMinor_ === null
      ? null
      : Money.fromMinorDenomination(this.runningBalanceMinor_, this.currency_);
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
    /** Wrapper cash balance at this snapshot — cumulative sum of every cash-affecting contribution (deposits, planning transfers, non-DRIP trades) up to and including this date. `null` for the synthetic defunct marker and outside the cash-contributions feed. @gqlField */
    public readonly runningBalance: Money | null = null,
  ) {}
}

/** A single row in the per-wrapper cash-contributions ledger. Either an external `InvestmentDeposit` (dividend, tax relief, …), a manual `AssetCashPlanningTransaction` originating in a planning cash account, an `InvestmentTradePseudoTransaction` mirroring a non-DRIP unit trade as its cash impact, or an `AssetValueSnapshot` separator surfacing a `NetWorthEntries` checkpoint. @gqlUnion */
export type CashContribution =
  | InvestmentDeposit
  | AssetCashPlanningTransaction
  | InvestmentTradePseudoTransaction
  | AssetValueSnapshot;

const DEFAULT_PAGE_SIZE = 20;

/** Paginated, date-desc list of every cash contribution for the wrapper — external deposits, planning cash transfers, non-DRIP unit trades surfaced as their cash impact, and `NetWorthEntries` snapshot checkpoints, interleaved by date. Built as a `unionAll` of four branches projecting a common shape (with a `kind:rowId` sort key), wrapped in a per-row running-balance window function (cumulative cash flow oldest-first; snapshot rows contribute zero so they carry forward the latest flow balance), then filtered by the cursor's `(date, sortKey)` and sliced server-side at `LIMIT first + 1`.
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

  // The synthetic defunct marker (if any) consumes one slot on the first
  // page only; reduce the SQL limit to keep the total node count at `limit`.
  const defunct = cursor === null ? await loadDefunctMarker(assetId) : null;
  const realLimit = defunct ? Math.max(0, limit - 1) : limit;

  type Kind = "deposit" | "tx" | "trade" | "snapshot";
  // Each branch projects the same 12-column shape so `unionAll` types align.
  // `flow` is the per-row cash impact (zero on snapshot rows so they don't
  // perturb the running balance). `amount` carries the source-specific
  // signed amount (wrapper-POV cash for flow rows; the recorded snapshot
  // value for snapshots). `units` and `snapshot*` are populated only on
  // their owning branch.
  const depositsBranch = db
    .select({
      kind: sql<Kind>`'deposit'`.as("kind"),
      rowId: sql<string>`${InvestmentDeposits.id}::text`.as("rowId"),
      sortKey: sql<string>`'deposit:' || ${InvestmentDeposits.id}::text`.as(
        "sortKey",
      ),
      date: InvestmentDeposits.date,
      name: InvestmentDeposits.name,
      amount: sql<number>`${InvestmentDeposits.amount}::bigint`.as("amount"),
      flow: sql<number>`${InvestmentDeposits.amount}::bigint`.as("flow"),
      currency: InvestmentDeposits.currency,
      accountId: sql<string | null>`NULL::uuid`.as("accountId"),
      units: sql<number | null>`NULL::float8`.as("units"),
      snapshotAmount: sql<number | null>`NULL::bigint`.as("snapshotAmount"),
      snapshotCurrency: sql<string | null>`NULL::text`.as("snapshotCurrency"),
    })
    .from(InvestmentDeposits)
    .where(eq(InvestmentDeposits.assetId, assetId));

  const txBranch = db
    .select({
      kind: sql<Kind>`'tx'`.as("kind"),
      rowId: sql<string>`${PlanningTransactions.id}::text`.as("rowId"),
      sortKey: sql<string>`'tx:' || ${PlanningTransactions.id}::text`.as(
        "sortKey",
      ),
      date: PlanningTransactions.date,
      name: PlanningTransactions.name,
      amount: sql<number>`(-${PlanningTransactions.amount})::bigint`.as(
        "amount",
      ),
      flow: sql<number>`(-${PlanningTransactions.amount})::bigint`.as("flow"),
      currency: PlanningTransactions.currency,
      accountId: sql<string | null>`${PlanningTransactions.accountId}`.as(
        "accountId",
      ),
      units: sql<number | null>`NULL::float8`.as("units"),
      snapshotAmount: sql<number | null>`NULL::bigint`.as("snapshotAmount"),
      snapshotCurrency: sql<string | null>`NULL::text`.as("snapshotCurrency"),
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
      ),
    );

  // Cash impact of a unit trade including taxes & fees:
  // `-(round(units*price) + taxes + fees)`. Buys (units > 0) are negative
  // (cash leaves the wrapper to pay the broker); sells (units < 0) are
  // positive (proceeds, reduced by taxes & fees).
  const tradeCashImpact = sql<number>`(-(ROUND(${InvestmentTransactions.units} * ${InvestmentTransactions.price})::bigint + ${InvestmentTransactions.taxes} + ${InvestmentTransactions.fees}))::bigint`;
  const tradeBranch = db
    .select({
      kind: sql<Kind>`'trade'`.as("kind"),
      rowId: sql<string>`${InvestmentTransactions.id}::text`.as("rowId"),
      sortKey: sql<string>`'trade:' || ${InvestmentTransactions.id}::text`.as(
        "sortKey",
      ),
      date: InvestmentTransactions.date,
      name: sql<string>`COALESCE(${Investments.stockCode}, ${Investments.name})`.as(
        "name",
      ),
      amount: tradeCashImpact.as("amount"),
      flow: tradeCashImpact.as("flow"),
      currency: InvestmentTransactions.currency,
      accountId: sql<string | null>`NULL::uuid`.as("accountId"),
      units: sql<number | null>`${InvestmentTransactions.units}`.as("units"),
      snapshotAmount: sql<number | null>`NULL::bigint`.as("snapshotAmount"),
      snapshotCurrency: sql<string | null>`NULL::text`.as("snapshotCurrency"),
    })
    .from(InvestmentTransactions)
    .innerJoin(
      Investments,
      eq(Investments.id, InvestmentTransactions.investmentId),
    )
    .where(
      and(
        eq(InvestmentTransactions.assetId, assetId),
        // DRIPs reinvest dividends back into units without moving cash, so
        // they don't surface here.
        eq(InvestmentTransactions.drip, false),
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
      // branch shape lines up with the flow branches.
      name: sql<string>`''`.as("name"),
      // `amount` is unread for snapshot rows (the union member exposes
      // `value` instead), but pad the shape with the recorded value so the
      // column stays bigint across all four branches. `flow` is zero so
      // snapshots leave the running balance unchanged.
      amount: sql<number>`${NetWorthValueAmounts.amount}::bigint`.as("amount"),
      flow: sql<number>`0::bigint`.as("flow"),
      currency: NetWorthValueAmounts.currency,
      accountId: sql<string | null>`NULL::uuid`.as("accountId"),
      units: sql<number | null>`NULL::float8`.as("units"),
      snapshotAmount: sql<
        number | null
      >`${NetWorthValueAmounts.amount}::bigint`.as("snapshotAmount"),
      // Cast `CurrencyCode` to `text` so the union with the other branches'
      // `NULL::text` doesn't trip Postgres's "UNION types ... cannot be
      // matched" check.
      snapshotCurrency: sql<
        string | null
      >`${NetWorthValueAmounts.currency}::text`.as("snapshotCurrency"),
    })
    .from(NetWorthValues)
    .innerJoin(
      NetWorthValueAmounts,
      eq(NetWorthValueAmounts.valueId, NetWorthValues.id),
    )
    .innerJoin(NetWorthEntries, eq(NetWorthEntries.id, NetWorthValues.entryId))
    .where(eq(NetWorthValues.categoryAssetId, assetId));

  const allRows = unionAll(
    depositsBranch,
    txBranch,
    tradeBranch,
    snapshotBranch,
  ).as("all_rows");

  // Layer the running-balance window function on top of the union. The
  // cursor predicate has to apply *after* the window function — pushing it
  // into the union branches would make the window see only a tail of the
  // history and break per-page balance continuity.
  const withBalance = db
    .select({
      kind: allRows.kind,
      rowId: allRows.rowId,
      sortKey: allRows.sortKey,
      date: allRows.date,
      name: allRows.name,
      amount: allRows.amount,
      currency: allRows.currency,
      accountId: allRows.accountId,
      units: allRows.units,
      snapshotAmount: allRows.snapshotAmount,
      snapshotCurrency: allRows.snapshotCurrency,
      balance:
        sql<number>`SUM(${allRows.flow}) OVER (ORDER BY ${allRows.date} ASC, ${allRows.sortKey} ASC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)`.as(
          "balance",
        ),
    })
    .from(allRows)
    .as("with_balance");

  const cursorWhere =
    cursor !== null
      ? or(
          lt(withBalance.date, new Date(cursor.c)),
          and(
            eq(withBalance.date, new Date(cursor.c)),
            lt(withBalance.sortKey, cursor.i),
          ),
        )
      : undefined;

  const rows = await db
    .select()
    .from(withBalance)
    .where(cursorWhere)
    .orderBy(desc(withBalance.date), desc(withBalance.sortKey))
    .limit(realLimit + 1);

  const hasNextPage = rows.length > realLimit;
  const page = hasNextPage ? rows.slice(0, realLimit) : rows;

  const realNodes: CashContribution[] = page.map((r) => {
    const balanceMinor = r.balance === null ? null : Number(r.balance);
    if (r.kind === "deposit") {
      return new InvestmentDeposit(
        r.rowId as ID,
        assetId,
        r.date,
        Number(r.amount),
        r.currency,
        r.name,
        balanceMinor,
      );
    }
    if (r.kind === "snapshot") {
      const snapshotMoney =
        r.snapshotAmount !== null && r.snapshotCurrency !== null
          ? Money.fromMinorDenomination(
              Number(r.snapshotAmount),
              r.snapshotCurrency,
            )
          : null;
      const balanceMoney =
        balanceMinor === null
          ? null
          : Money.fromMinorDenomination(balanceMinor, r.currency);
      return new AssetValueSnapshot(
        `snapshot:${r.rowId}` as ID,
        r.date,
        snapshotMoney,
        balanceMoney,
      );
    }
    if (r.kind === "trade") {
      return new InvestmentTradePseudoTransaction(
        `trade:${r.rowId}` as ID,
        r.date,
        r.name,
        (r.units ?? 0) as Float,
        Number(r.amount),
        r.currency,
        balanceMinor,
      );
    }
    // `tx` branch — `accountId` is non-null and the where clause excludes
    // provisional rows so `isProvisional` is always false here. We still
    // pass it through explicitly so the constructor stays truthful if the
    // filter ever changes.
    return new AssetCashPlanningTransaction(
      encodePlanningTransactionId({ kind: "tx", id: r.rowId }),
      r.date,
      r.name,
      // The `tx` branch projects `amount = -storedAmount` (wrapper POV),
      // but the class constructor expects the raw cash-account-POV amount
      // and negates again inside `amount()`. Flip the sign back so the
      // GraphQL field lands on the wrapper-POV value.
      -Number(r.amount),
      r.currency,
      r.accountId!,
      false,
      balanceMinor,
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

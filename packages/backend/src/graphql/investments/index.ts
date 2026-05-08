import { strict as assert } from "node:assert";

import {
  and,
  eq,
  exists,
  inArray,
  not,
  or,
  type SQL,
  sql,
  sum,
} from "drizzle-orm";
import { GraphQLError } from "graphql";
import type { Float, ID, Int } from "grats";

import { db, runInTransaction } from "@/db";
import { Investments, InvestmentTransactions } from "@/db/schema/investments";
import { NetWorthCategoryAssets } from "@/db/schema/net-worth";

import type { Context } from "../context";
import type { Date as CalendarDate } from "../date";
import type { DateTime } from "../date-time";
import { assertCurrencyCode, Money, type MoneyInput } from "../money";
import { NetWorthCategoryAsset } from "../net-worth/categories";
import {
  buildConnection,
  type Connection,
  decodeCursor,
  encodeCursor,
} from "../pagination";
import { VOID, type Void } from "../void";
import { effectiveAssetFilter } from "./effective-filter";
import {
  InvestmentPosition,
  InvestmentWrapper,
  loadInvestmentWrappers,
} from "./position";
import {
  InvestmentPriceHistory,
  loadInvestmentPriceHistory,
} from "./price-history";
import { loadInvestmentStats } from "./stats";
import {
  InvestmentStockSplit,
  loadInvestmentStockSplits,
} from "./stock-splits";
import {
  InvestmentTransaction,
  investmentTransactionCreate,
  loadInvestmentTransactions,
  loadInvestmentTransactionsConnection,
} from "./transactions";
import { primeInvestmentTransferLoaders } from "./transfers";

// `effectiveAssetFilter` is re-exported from `./effective-filter` for
// existing call sites; the module owns the DataLoader cache.
export { effectiveAssetFilter } from "./effective-filter";

/** The real-time unit price of a stock investment. `tickAt` is the time of the price tick reported by the upstream provider; `capturedAt` is the wall-clock time we last refreshed it. @gqlType */
export class InvestmentPriceLatest {
  constructor(
    /** Live quote, in the currency reported by the quote provider. @gqlField */
    public readonly price: Money,
    /** When we last refreshed this quote from the upstream provider. @gqlField */
    public readonly capturedAt: DateTime,
    /** Time of the actual price tick reported by the upstream provider — i.e. the moment the market last printed this price. Use this (not `capturedAt`) when surfacing "how recent is this price" to the user. @gqlField */
    public readonly tickAt: DateTime,
  ) {}
}

/** A listed security identified by its ticker on the relevant exchange. @gqlType */
export class InvestmentStock {
  readonly __typename = "InvestmentStock" as const;
  constructor(
    /** Ticker on the relevant exchange (e.g. `SMT.L`, `AAPL`). @gqlField */
    public readonly code: string,
  ) {}
}

/** A fund identified by a URL to its product page (e.g. a fund platform's page). @gqlType */
export class InvestmentFund {
  readonly __typename = "InvestmentFund" as const;
  constructor(
    /** Link to the fund's product page. @gqlField */
    public readonly url: string,
  ) {}
}

/** The underlying instrument an `Investment` represents: a listed stock or a fund. @gqlUnion */
export type InvestmentAsset = InvestmentStock | InvestmentFund;

/** A tradable holding — either a listed stock or a fund. `position` gives the aggregate across every wrapper that holds this investment; per-wrapper numbers live on each `wrappers[].position`. @gqlType */
export class Investment {
  constructor(
    /** @gqlField */
    public readonly id: ID,
    /** @gqlField */
    public readonly name: string,
    /** What kind of instrument this investment represents. @gqlField */
    public readonly asset: InvestmentAsset,
    /** ISO-4217 code of the currency every price and transaction for this investment is quoted in. @gqlField */
    public readonly currency: string,
  ) {}

  static load(row: typeof Investments.$inferSelect): Investment {
    const asset: InvestmentAsset =
      row.stockCode !== null
        ? new InvestmentStock(row.stockCode)
        : (assert(
            row.fundLink !== null,
            "Investment missing stockCode and fundLink",
          ),
          new InvestmentFund(row.fundLink));
    return new Investment(row.id as ID, row.name, asset, row.currency);
  }

  /** Transactions booked against this investment, oldest-first. Full history — for large lists prefer `transactionsPaged`.
   *
   * @gqlField
   * @gqlAnnotate semanticNonNull
   */
  async transactions(): Promise<InvestmentTransaction[] | null> {
    return loadInvestmentTransactions(this.id);
  }

  /** Paginated transactions (newest-first) for this investment. Returns the 15 most recent by default. Pass `filterAssetId` to scope to a single wrapper.
   *
   * @gqlField
   * @gqlAnnotate semanticNonNull
   */
  async transactionsPaged(
    first?: Int | null,
    after?: ID | null,
    /** When set, only transactions booked against this wrapper are returned. */
    filterAssetId?: ID | null,
  ): Promise<Connection<InvestmentTransaction> | null> {
    return loadInvestmentTransactionsConnection(
      this.id,
      first,
      after,
      filterAssetId,
    );
  }

  /** Stock-split events on this investment, oldest-first.
   *
   * @gqlField
   * @gqlAnnotate semanticNonNull
   */
  async stockSplits(): Promise<InvestmentStockSplit[] | null> {
    return loadInvestmentStockSplits(this.id);
  }

  /** Most recent split-adjusted unit price known for this investment. When `filterAssetIdIn` resolves to a single transferred-out wrapper, the price is frozen at the most recent quote on or before the day of the transfer (the live overlay is skipped). `null` if no qualifying prices have been recorded yet. @gqlField */
  async unitPriceCached(
    ctx: Context,
    /** When set and non-empty, used to derive a frozen-pre-transfer view: a single transferred-out wrapper caps the price at its transfer date. Has no other effect on the price itself (which is investment-level). */
    filterAssetIdIn?: ID[] | null,
  ): Promise<Money | null> {
    // Only the transfer-out cap applies to price-of-instrument fields:
    // a transferred-away wrapper has no live price (the wrapper is gone),
    // but a sold-out wrapper's underlying instrument still trades, so the
    // user sees today's live/cached close.
    const { transferDateCap } = await effectiveAssetFilter(
      ctx,
      filterAssetIdIn,
    );
    const s = await loadInvestmentStats(ctx, {
      investmentId: this.id,
      currency: this.currency,
      ...(transferDateCap ? { dateCap: transferDateCap } : {}),
    });
    if (s.priceLatest === null || s.currency === null) return null;
    return Money.fromMinorDenomination(s.priceLatest, s.currency);
  }

  /** When the most recent cached unit price was first recorded for this investment (DB-row creation timestamp). `null` if no prices have been recorded yet. @gqlField */
  async unitPriceCachedAt(
    ctx: Context,
    /** When set, used to derive a frozen-pre-transfer view (see `unitPriceCached`). */
    filterAssetIdIn?: ID[] | null,
  ): Promise<DateTime | null> {
    // Only the transfer-out cap applies to price-of-instrument fields:
    // a transferred-away wrapper has no live price (the wrapper is gone),
    // but a sold-out wrapper's underlying instrument still trades, so the
    // user sees today's live/cached close.
    const { transferDateCap } = await effectiveAssetFilter(
      ctx,
      filterAssetIdIn,
    );
    const s = await loadInvestmentStats(ctx, {
      investmentId: this.id,
      currency: this.currency,
      ...(transferDateCap ? { dateCap: transferDateCap } : {}),
    });
    return (s.priceLatestCachedAt as DateTime | null) ?? null;
  }

  /** Calendar date the most recent cached unit price applies to — i.e. the trading day the close price represents, distinct from when it was first stored (`unitPriceCachedAt`). When the wrapper filter resolves to a transferred-out wrapper, returns the date of the most recent quote on or before the day of the transfer. `null` if no prices have been recorded yet. @gqlField */
  async unitPriceCachedDate(
    ctx: Context,
    /** When set, used to derive a frozen-pre-transfer view (see `unitPriceCached`). */
    filterAssetIdIn?: ID[] | null,
  ): Promise<CalendarDate | null> {
    // Only the transfer-out cap applies to price-of-instrument fields:
    // a transferred-away wrapper has no live price (the wrapper is gone),
    // but a sold-out wrapper's underlying instrument still trades, so the
    // user sees today's live/cached close.
    const { transferDateCap } = await effectiveAssetFilter(
      ctx,
      filterAssetIdIn,
    );
    const s = await loadInvestmentStats(ctx, {
      investmentId: this.id,
      currency: this.currency,
      ...(transferDateCap ? { dateCap: transferDateCap } : {}),
    });
    return s.priceLatestCachedDate ?? null;
  }

  /** Live unit price and the timestamp it was captured at, sourced from the real-time quote provider. `null` for non-stock investments, when no quote is available, or when `filterAssetIdIn` resolves to a single transferred-out wrapper (a frozen pre-transfer view never reads the live tick). The persisted `InvestmentPricesLive` row is read directly; if it's stale (> 5 minutes) and we're inside the currency's business-hours window, the stats loader fires a background refresh whose result surfaces on the next request. @gqlField */
  async unitPriceLatest(
    ctx: Context,
    /** When set and non-empty, used to suppress the live overlay for transferred-out wrappers (see `unitPriceCached`). */
    filterAssetIdIn?: ID[] | null,
  ): Promise<InvestmentPriceLatest | null> {
    if (!(this.asset instanceof InvestmentStock)) return null;
    // Same rule as the cached-price family: live overlay suppressed only
    // when the wrapper has been transferred away. A sold-out wrapper still
    // shows the live price.
    const { transferDateCap } = await effectiveAssetFilter(
      ctx,
      filterAssetIdIn,
    );
    if (transferDateCap) return null;
    const s = await loadInvestmentStats(ctx, {
      investmentId: this.id,
      currency: this.currency,
    });
    if (!s.live) return null;
    return new InvestmentPriceLatest(
      Money.fromMinorDenomination(s.live.priceMinor, s.live.currency),
      s.live.refreshedAt as DateTime,
      s.live.tickAt as DateTime,
    );
  }

  /** Holdings, cost basis, and gain/loss aggregated across every wrapper, or scoped to the union of a set of wrappers when `filterAssetIdIn` is supplied (non-empty). When `filterAssetIdIn` resolves to a single transferred-out wrapper, holdings are frozen at the day before the transfer. When it resolves to a single transferred-into wrapper, each source's pre-transfer transactions are folded into the result. @gqlField */
  async position(
    ctx: Context,
    /** When set and non-empty, scopes the position to the union of these wrappers. */
    filterAssetIdIn?: ID[] | null,
  ): Promise<InvestmentPosition> {
    const { effectiveAssetIds, extraScopes, transferDateCap, dateCap } =
      await effectiveAssetFilter(ctx, filterAssetIdIn);
    // Pass `currency` so the stats DataLoader's `cacheKeyFn` matches the key
    // used by `Portfolio.timeseries`'s per-investment live overlay (which
    // always passes `currency: HOME_CURRENCY`). Without it, the same
    // `(investmentId)` slice gets two distinct cache slots and fires twice
    // per request — once when the chart resolves the live overlay, again
    // here when each `node.investment.position` runs in a later tick.
    const s = await loadInvestmentStats(ctx, {
      investmentId: this.id,
      currency: this.currency,
      assetIds:
        effectiveAssetIds && effectiveAssetIds.length > 0
          ? effectiveAssetIds
          : undefined,
      ...(dateCap ? { dateCap } : {}),
      ...(extraScopes.length > 0 ? { extraScopes } : {}),
    });
    return new InvestmentPosition(s, {
      ctx,
      investmentId: this.id,
      ...(effectiveAssetIds && effectiveAssetIds.length > 0
        ? { assetIds: effectiveAssetIds }
        : {}),
      ...(transferDateCap ? { transferDateCap } : {}),
      ...(dateCap ? { chartDateCap: dateCap } : {}),
      ...(extraScopes.length > 0 ? { extraScopes } : {}),
    });
  }

  /** Per-wrapper breakdown of the investment. One entry per `(investment, asset)` pairing with at least one recorded transaction.
   *
   * @gqlField
   * @gqlAnnotate semanticNonNull
   */
  async wrappers(): Promise<InvestmentWrapper[] | null> {
    return loadInvestmentWrappers(this.id);
  }

  /** Full split-adjusted unit-price history for this investment, oldest sample first. Drives the compact price-preview chart on the investments list. `null` when no daily-close quotes have been recorded yet. @gqlField */
  async priceHistory(): Promise<InvestmentPriceHistory | null> {
    return loadInvestmentPriceHistory(this.id, this.currency);
  }
}

/** Identifies the underlying instrument when creating or updating an `Investment`. Exactly one field must be set. @gqlInput */
export type InvestmentAssetInput =
  | { stock: InvestmentStockInput }
  | { fund: InvestmentFundInput };

/** @gqlInput */
export type InvestmentStockInput = {
  /** Ticker on the relevant exchange (e.g. `SMT.L`, `AAPL`). */
  code: string;
};

/** @gqlInput */
export type InvestmentFundInput = {
  /** Link to the fund's product page. */
  url: string;
};

function assetInputToColumns(input: InvestmentAssetInput): {
  stockCode: string | null;
  fundLink: string | null;
} {
  if ("stock" in input) {
    return { stockCode: input.stock.code, fundLink: null };
  }
  return { stockCode: null, fundLink: input.fund.url };
}

/** Initial transaction to book against a freshly-created `Investment` from `investmentCreate`. The investment's id is filled in by the resolver, and the price currency must match the investment's currency. @gqlInput */
export type InvestmentInitialTransactionInput = {
  /** Wrapper to book the trade into. Must be a `STOCK` or `PENSION` net-worth asset. */
  assetId: ID;
  /** Calendar date the trade was executed. */
  date: CalendarDate;
  /** Signed number of units traded. Positive = buy / DRIP, negative = sell. Fractional units are supported. */
  units: Float;
  /** Unit price at execution. */
  price: MoneyInput;
  /** Taxes paid on the trade. Defaults to 0. */
  taxes?: MoneyInput | null;
  /** Broker / platform fees paid. Defaults to 0. */
  fees?: MoneyInput | null;
  /** Set `true` to mark this as a dividend reinvestment rather than a cash buy. Defaults to `false`. */
  drip?: boolean | null;
};

/** Create a new investment, optionally booking one or more initial transactions in the same round-trip. @gqlMutationField */
export async function investmentCreate(
  ctx: Context,
  name: string,
  /** ISO-4217 currency code every price and transaction for this investment will be quoted in. */
  currency: string,
  /** What kind of instrument this investment represents. */
  asset: InvestmentAssetInput,
  /** Optional list of transactions to book against the new investment. Each is created with the same semantics as `investmentTransactionCreate`. */
  transactions?: InvestmentInitialTransactionInput[] | null,
): Promise<Investment> {
  assertCurrencyCode(currency);
  const columns = assetInputToColumns(asset);
  return runInTransaction(async () => {
    const [row] = await db
      .insert(Investments)
      .values({ name, currency, ...columns })
      .returning();
    if (transactions && transactions.length > 0) {
      for (const tx of transactions) {
        await investmentTransactionCreate(
          ctx,
          row.id as ID,
          tx.assetId,
          tx.date,
          tx.units,
          tx.price,
          tx.taxes,
          tx.fees,
          tx.drip,
        );
      }
    }
    return Investment.load(row);
  });
}

/** Partially update an investment. Omitted (or `null`) fields are left unchanged. @gqlMutationField */
export async function investmentUpdate(
  id: ID,
  name?: string | null,
  /** New underlying instrument. When set, the supplied variant fully replaces the previous one (e.g. switching from a stock to a fund). */
  asset?: InvestmentAssetInput | null,
): Promise<Investment> {
  const patch: Partial<typeof Investments.$inferInsert> = {};
  if (name != null) patch.name = name;
  if (asset != null) Object.assign(patch, assetInputToColumns(asset));
  if (Object.keys(patch).length === 0) {
    const [row] = await db
      .select()
      .from(Investments)
      .where(eq(Investments.id, id));
    if (!row) throw new GraphQLError(`Investment ${id} not found`);
    return Investment.load(row);
  }
  const [row] = await db
    .update(Investments)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(Investments.id, id))
    .returning();
  if (!row) throw new GraphQLError(`Investment ${id} not found`);
  return Investment.load(row);
}

/** Delete an investment and all its transactions, stock splits, and prices. @gqlMutationField */
export async function investmentDelete(id: ID): Promise<Void> {
  await db.delete(Investments).where(eq(Investments.id, id));
  return VOID;
}

/** Ascending or descending order for a sort input. @gqlEnum */
export type SortDirection = "ASC" | "DESC";

/** Choose how to order `Query.investments`. Exactly one field must be set. When omitted entirely the list is newest-first by creation time. @gqlInput */
export type InvestmentSort =
  | { value: SortDirection }
  | { gainAbs: SortDirection }
  | { gainPercent: SortDirection };

type SortKey = "createdAt" | "value" | "gainAbs" | "gainPercent";

const DEFAULT_PAGE_SIZE = 50;

function parseSortInput(sort: InvestmentSort | null | undefined): {
  key: SortKey;
  direction: SortDirection;
} {
  if (sort == null) return { key: "createdAt", direction: "DESC" };
  if ("value" in sort) return { key: "value", direction: sort.value };
  if ("gainAbs" in sort) return { key: "gainAbs", direction: sort.gainAbs };
  return { key: "gainPercent", direction: sort.gainPercent };
}

/** Paginated list of investments, sorted by the requested key. Computed sorts (`value`, `gainAbs`, `gainPercent`) use current cached values; cursors are only stable while those values don't change.
 *
 * @gqlQueryField
 * @gqlAnnotate semanticNonNull
 */
export async function investments(
  ctx: Context,
  first?: Int | null,
  after?: ID | null,
  sort?: InvestmentSort | null,
  /** When set and non-empty, only investments with at least one transaction booked against any of these wrappers are returned (in addition to investments with no transactions at all), and computed sort keys (`value`, `gainAbs`, `gainPercent`) are scoped to the union of those wrappers. When the filter resolves to a single transferred-out wrapper, predicates and sort keys are evaluated at the day before the transfer (so a position that's still held then is not classified as sold). */
  filterAssetIdIn?: ID[] | null,
  /** Filter on whether the investment is fully sold — i.e. has at least one transaction but a net-zero unit count (scoped to `filterAssetIdIn` when set and non-empty). `false` excludes sold investments, `true` keeps only sold ones, `null` / omitted applies no filter. Investments with no transactions are never considered sold. */
  filterIsSold?: boolean | null,
): Promise<Connection<Investment> | null> {
  const {
    effectiveAssetIds,
    extraScopes,
    transferDateCap,
    dateCap: dateCapIso,
  } = await effectiveAssetFilter(ctx, filterAssetIdIn);
  const limit = first ?? DEFAULT_PAGE_SIZE;
  const afterCursor = after ? decodeCursor(after) : null;
  const { key, direction } = parseSortInput(sort);
  const wrapperFilter =
    effectiveAssetIds && effectiveAssetIds.length > 0
      ? effectiveAssetIds
      : null;

  // SQL `WHERE` predicate that selects transactions in scope: the main
  // wrapper(s) (capped by `dateCapIso` when set) OR each `extraScope`'s
  // source asset capped at its transfer date. Mirrors `loadInvestmentStats`
  // so the per-investment "is this investment in scope?" check sees the
  // same rows the stats loader aggregates.
  const txInScope = (() => {
    if (!wrapperFilter && extraScopes.length === 0) return undefined;
    const branches: SQL[] = [];
    if (wrapperFilter) {
      const dateClause = dateCapIso
        ? sql` AND ${InvestmentTransactions.date} <= ${dateCapIso}::date`
        : sql``;
      branches.push(
        sql`(${inArray(InvestmentTransactions.assetId, wrapperFilter)}${dateClause})`,
      );
    }
    for (const s of extraScopes) {
      branches.push(
        sql`(${InvestmentTransactions.assetId} = ${s.assetId} AND ${InvestmentTransactions.date} <= ${s.dateCap}::date)`,
      );
    }
    return sql`(${sql.join(branches, sql` OR `)})`;
  })();

  // Net units across all transactions for `Investments.id` in the scope
  // computed above. Returns `NULL` for investments with no matching
  // transactions, which is treated as "not sold" below.
  const unitsSum = db
    .select({ s: sum(InvestmentTransactions.units) })
    .from(InvestmentTransactions)
    .where(
      and(eq(InvestmentTransactions.investmentId, Investments.id), txInScope),
    );
  // `hasAnyTransaction` deliberately ignores `dateCapIso` / `extraScopes`.
  // Its sole purpose is to spare freshly-created, zero-tx investments from
  // being filtered out of the wrapper-scoped view. Capping it would
  // falsely surface investments whose only txs are out-of-scope.
  const hasAnyTransaction = exists(
    db
      .select({ id: InvestmentTransactions.id })
      .from(InvestmentTransactions)
      .where(eq(InvestmentTransactions.investmentId, Investments.id)),
  );
  const hasTransactionInWrapper = txInScope
    ? exists(
        db
          .select({ id: InvestmentTransactions.id })
          .from(InvestmentTransactions)
          .where(
            and(
              eq(InvestmentTransactions.investmentId, Investments.id),
              txInScope,
            ),
          ),
      )
    : undefined;

  const rows = await db
    .select()
    .from(Investments)
    .where(
      and(
        // Investments with zero transactions overall are surfaced regardless
        // of the wrapper filter, so a freshly-created investment stays visible
        // (and thus actionable) before its first transaction is booked.
        hasTransactionInWrapper
          ? or(hasTransactionInWrapper, not(hasAnyTransaction))
          : undefined,
        // A "sold" investment has at least one transaction and a net-zero unit
        // count (scoped to the wrapper when set). Newly-created zero-tx
        // investments are never classified as sold. Units are stored in double
        // precision so summing buys + sells of fractional shares can leave a
        // sub-unit residue (e.g. ~1e-13) instead of an exact zero — compare
        // against a small epsilon, not `= 0`, so those positions still hide.
        //
        // When the effective scope is defunct (`dateCapIso` set: every
        // selected wrapper is either transferred out or fully sold), treat
        // every in-scope investment as sold regardless of its pre-cap units.
        // Pre-cap holdings on a defunct wrapper aren't currently held — they
        // exist only to keep the frozen chart / totals meaningful — so the
        // hide-sold toggle should still hide them.
        filterIsSold === true
          ? dateCapIso
            ? hasTransactionInWrapper
            : and(hasAnyTransaction, sql`abs(coalesce(${unitsSum}, 0)) < 1e-9`)
          : undefined,
        filterIsSold === false
          ? dateCapIso
            ? not(hasTransactionInWrapper ?? sql`false`)
            : or(
                not(hasAnyTransaction),
                sql`abs(coalesce(${unitsSum}, 0)) >= 1e-9`,
              )
          : undefined,
      ),
    );

  // Only load stats for rows when the caller actually needs them to sort.
  const enriched: {
    row: (typeof rows)[number];
    sortable: number;
    raw: string;
  }[] =
    key === "createdAt"
      ? rows.map((row) => ({
          row,
          sortable: row.createdAt.getTime(),
          raw: String(row.createdAt.getTime()),
        }))
      : await Promise.all(
          rows.map(async (row) => {
            // Sort key picks the cap flavour: `value` mirrors the table's
            // displayed `totalValue` (chart-flavoured — frozen at peak for
            // wound-down wrappers). `gainAbs` / `gainPercent` mirror the
            // displayed `totalGain` (transfer-flavoured — wind-down sells
            // flow through realised gain).
            const sortCap =
              key === "value"
                ? (dateCapIso ?? null)
                : (transferDateCap ?? null);
            const s = await loadInvestmentStats(ctx, {
              investmentId: row.id,
              assetIds: wrapperFilter ?? undefined,
              ...(sortCap ? { dateCap: sortCap } : {}),
              ...(extraScopes.length > 0 ? { extraScopes } : {}),
            });
            const totalValue = s.totalValueMinor;
            // Total return uses the same convention as
            // `Portfolio.totalCost` / `InvestmentPosition.totalCost`: gross
            // buy cost excluding DRIP (DRIP buys are dividends-as-shares, not
            // new capital), plus fees and taxes (real outlays that reduce
            // return). Counting DRIPs as cost would double-count the dividend.
            const totalCost =
              s.buyCostSum - s.reinvestedCostSum + s.feesSum + s.taxesSum;
            const totalGain =
              totalValue === null
                ? null
                : totalValue + s.sellValueSum - totalCost;
            const percentGain =
              totalGain === null || totalCost === 0
                ? null
                : totalGain / totalCost;
            const sortable =
              key === "value"
                ? (totalValue ?? Number.NEGATIVE_INFINITY)
                : key === "gainAbs"
                  ? (totalGain ?? Number.NEGATIVE_INFINITY)
                  : (percentGain ?? Number.NEGATIVE_INFINITY);
            return { row, sortable, raw: String(sortable) };
          }),
        );

  const multiplier = direction === "ASC" ? 1 : -1;
  enriched.sort((a, b) => {
    const d = (a.sortable - b.sortable) * multiplier;
    if (d !== 0) return d;
    return a.row.id.localeCompare(b.row.id);
  });

  let startIndex = 0;
  if (afterCursor) {
    const idx = enriched.findIndex((e) => e.row.id === afterCursor.i);
    if (idx === -1) throw new GraphQLError("cursor references unknown row");
    startIndex = idx + 1;
  }
  const slice = enriched.slice(startIndex, startIndex + limit + 1);
  const hasNextPage = slice.length > limit;
  const page = hasNextPage ? slice.slice(0, limit) : slice;

  return buildConnection<Investment>(
    page.map((p) => Investment.load(p.row)),
    (_node) => {
      const entry = page.find((p) => p.row.id === _node.id)!;
      return encodeCursor(entry.raw, entry.row.id);
    },
    { hasNextPage, hasPreviousPage: afterCursor != null },
  );
}

/** Look up a single investment by id. Returns `null` if no investment with that id exists.
 *
 * @gqlQueryField
 */
export async function investment(id: ID): Promise<Investment | null> {
  const [row] = await db
    .select()
    .from(Investments)
    .where(eq(Investments.id, id));
  if (!row) return null;
  return Investment.load(row);
}

/** Every wrapper (a `STOCK` or `PENSION` `NetWorthCategoryAsset`) that has at least one `InvestmentTransaction` booked against it, ordered with `STOCK` wrappers before `PENSION`s and alphabetically by `name` within each group. Drives the portfolio switcher on the investments page.
 *
 * @gqlQueryField
 * @gqlAnnotate semanticNonNull
 */
export async function investmentPortfolios(
  ctx: Context,
): Promise<NetWorthCategoryAsset[] | null> {
  const rows = await db
    .selectDistinct({ row: NetWorthCategoryAssets })
    .from(NetWorthCategoryAssets)
    .innerJoin(
      InvestmentTransactions,
      eq(InvestmentTransactions.assetId, NetWorthCategoryAssets.id),
    )
    .where(inArray(NetWorthCategoryAssets.type, ["STOCK", "PENSION"]));
  // Custom order: STOCK before PENSION, then by name. SQL DISTINCT can't
  // express the priority cleanly without a CASE, so sort in JS.
  rows.sort((a, b) => {
    if (a.row.type !== b.row.type) return a.row.type === "STOCK" ? -1 : 1;
    return a.row.name.localeCompare(b.row.name);
  });
  // Pre-warm transfer DataLoaders so the per-wrapper `transferOut` /
  // `transfersIn` / `soldOutOn` resolvers don't each fire their own
  // single-id batch as they resolve across separate microtask ticks.
  // Fire-and-forget — `.load()` from each resolver still awaits the same
  // promise the DataLoader caches here.
  const ids = rows.map((r) => r.row.id);
  primeInvestmentTransferLoaders(ctx, ids);
  return rows.map((r) => NetWorthCategoryAsset.load(r.row));
}

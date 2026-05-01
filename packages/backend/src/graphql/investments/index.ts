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

import { HOME_CURRENCY } from "@/config";
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
import { loadAssetSoldOutCaps } from "./portfolio";
import {
  InvestmentPosition,
  InvestmentWrapper,
  loadInvestmentWrappers,
} from "./position";
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
import {
  loadInvestmentTransferInScopesForAsset,
  loadInvestmentTransferOutScopeForAsset,
} from "./transfers";

/** Resolve the transfer-aware view of `filterAssetIdIn`. Mirrors `Portfolio.loadEffectiveFilter`:
 *
 * - `effectiveAssetIds`: the user's filter with assets whose outgoing transfer destination is also in the filter dropped (so a `[src, dest]` shape collapses to `[dest]` and the source is folded via `extraScopes` instead of double-counted).
 * - `extraScopes`: union of every surviving asset's inbound transfers, each capped at the day before the transfer. Sources may be the dropped assets.
 * - `dateCap`: only set when `effectiveAssetIds` is a single transferred-out wrapper whose destination is *not* in the filter — the standalone defunct view.
 */
async function effectiveAssetFilter(
  filterAssetIdIn: readonly ID[] | null | undefined,
): Promise<{
  effectiveAssetIds: string[] | null;
  extraScopes: ReadonlyArray<{ assetId: string; dateCap: string }>;
  dateCap: string | null;
}> {
  if (!filterAssetIdIn || filterAssetIdIn.length === 0) {
    return { effectiveAssetIds: null, extraScopes: [], dateCap: null };
  }
  const filterSet = new Set(filterAssetIdIn);
  const outgoing = await Promise.all(
    filterAssetIdIn.map((id) => loadInvestmentTransferOutScopeForAsset(id)),
  );
  const effective: string[] = [];
  for (let i = 0; i < filterAssetIdIn.length; i++) {
    const t = outgoing[i];
    if (t && filterSet.has(t.assetIdTo as ID)) continue;
    effective.push(filterAssetIdIn[i]);
  }
  const dayBefore = (date: Date | string): string => {
    const d = new Date(date as unknown as Date);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  };
  const extras: { assetId: string; dateCap: string }[] = [];
  const seen = new Set<string>();
  for (const assetId of effective) {
    const incoming = await loadInvestmentTransferInScopesForAsset(assetId);
    for (const t of incoming) {
      const cap = dayBefore(t.date);
      const key = `${t.assetIdFrom}@${cap}`;
      if (seen.has(key)) continue;
      seen.add(key);
      extras.push({ assetId: t.assetIdFrom, dateCap: cap });
    }
  }
  // Per-asset "defunct cap": outgoing transfer (cap = transferDate − 1)
  // or a fully sold-out wrapper (every position netted to zero, cap =
  // lastTxDate − 1). When every effective asset has a cap, freeze the
  // request at the latest such date.
  const soldOutCaps = await loadAssetSoldOutCaps(effective, HOME_CURRENCY);
  let dateCap: string | null = null;
  if (effective.length >= 1) {
    const caps = effective.flatMap((id) => {
      const t = outgoing[filterAssetIdIn.indexOf(id as ID)];
      if (t) return [dayBefore(t.date)];
      const sold = soldOutCaps.get(id);
      return sold ? [sold] : [];
    });
    if (caps.length === effective.length) {
      dateCap = caps.reduce((acc, d) => (d > acc ? d : acc));
    }
  }
  return { effectiveAssetIds: effective, extraScopes: extras, dateCap };
}

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
    const { dateCap } = await effectiveAssetFilter(filterAssetIdIn);
    const s = await loadInvestmentStats(ctx, {
      investmentId: this.id,
      ...(dateCap ? { dateCap } : {}),
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
    const { dateCap } = await effectiveAssetFilter(filterAssetIdIn);
    const s = await loadInvestmentStats(ctx, {
      investmentId: this.id,
      ...(dateCap ? { dateCap } : {}),
    });
    return (s.priceLatestCachedAt as DateTime | null) ?? null;
  }

  /** Calendar date the most recent cached unit price applies to — i.e. the trading day the close price represents, distinct from when it was first stored (`unitPriceCachedAt`). When the wrapper filter resolves to a transferred-out wrapper, returns the date of the most recent quote on or before the day of the transfer. `null` if no prices have been recorded yet. @gqlField */
  async unitPriceCachedDate(
    ctx: Context,
    /** When set, used to derive a frozen-pre-transfer view (see `unitPriceCached`). */
    filterAssetIdIn?: ID[] | null,
  ): Promise<CalendarDate | null> {
    const { dateCap } = await effectiveAssetFilter(filterAssetIdIn);
    const s = await loadInvestmentStats(ctx, {
      investmentId: this.id,
      ...(dateCap ? { dateCap } : {}),
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
    const { dateCap } = await effectiveAssetFilter(filterAssetIdIn);
    if (dateCap) return null;
    const s = await loadInvestmentStats(ctx, { investmentId: this.id });
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
    const { effectiveAssetIds, extraScopes, dateCap } =
      await effectiveAssetFilter(filterAssetIdIn);
    const s = await loadInvestmentStats(ctx, {
      investmentId: this.id,
      assetIds:
        effectiveAssetIds && effectiveAssetIds.length > 0
          ? effectiveAssetIds
          : undefined,
      ...(dateCap ? { dateCap } : {}),
      ...(extraScopes.length > 0 ? { extraScopes } : {}),
    });
    return new InvestmentPosition(s);
  }

  /** Per-wrapper breakdown of the investment. One entry per `(investment, asset)` pairing with at least one recorded transaction.
   *
   * @gqlField
   * @gqlAnnotate semanticNonNull
   */
  async wrappers(): Promise<InvestmentWrapper[] | null> {
    return loadInvestmentWrappers(this.id);
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
    dateCap: dateCapIso,
  } = await effectiveAssetFilter(filterAssetIdIn);
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
        filterIsSold === true
          ? and(hasAnyTransaction, sql`abs(coalesce(${unitsSum}, 0)) < 1e-9`)
          : undefined,
        filterIsSold === false
          ? or(
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
            const s = await loadInvestmentStats(ctx, {
              investmentId: row.id,
              assetIds: wrapperFilter ?? undefined,
              ...(dateCapIso ? { dateCap: dateCapIso } : {}),
              ...(extraScopes.length > 0 ? { extraScopes } : {}),
            });
            const totalValue = s.totalValueMinor;
            const totalGain =
              totalValue === null ? null : totalValue - s.unitsPriceSum;
            const percentGain =
              totalGain === null || s.unitsPriceSum === 0
                ? null
                : totalGain / s.unitsPriceSum;
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

/** Every wrapper (a `STOCK` or `PENSION` `NetWorthCategoryAsset`) that has at least one `InvestmentTransaction` booked against it, ordered with `STOCK` wrappers before `PENSION`s and alphabetically by `name` within each group. Drives the portfolio switcher on the investments page.
 *
 * @gqlQueryField
 * @gqlAnnotate semanticNonNull
 */
export async function investmentPortfolios(): Promise<
  NetWorthCategoryAsset[] | null
> {
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
  return rows.map((r) => NetWorthCategoryAsset.load(r.row));
}

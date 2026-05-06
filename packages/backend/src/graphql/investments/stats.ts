import DataLoader from "dataloader";
import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  InvestmentPrices,
  InvestmentPricesLive,
  Investments,
  InvestmentStockSplits,
  InvestmentTransactions,
} from "@/db/schema/investments";
import {
  fetchQuote,
  isInBusinessHours,
  LIVE_QUOTE_STALE_MS,
} from "@/tasks/yahoo";

import { type Context, contextAwareDataLoader } from "../context";

/**
 * Aggregated numbers for an arbitrary slice of the portfolio — a single investment, a single portfolio (`assetId`), a single `(investment, portfolio)` pair, or everything at once.
 *
 * All minor-denomination fields are in the investment's currency when the slice is scoped to a single investment (meaning `unitsHeld` and `priceLatest` are meaningful), and `null` for the scalar metadata (`currency`, `stockCode`, `priceLatest`) when the slice spans multiple investments.
 *
 * `totalValueMinor` and `dailyGainValueMinor` are pre-computed using the "portfolio" convention: every investment contributes `unitsHeld_in_filter × priceLatest_investment` to `totalValueMinor` (so fully-sold slices contribute zero — their realised proceeds flow through `unitsPriceSum` / `buyCostSum` instead), and every held investment with a usable live quote contributes `(live − previousClose) × unitsHeld_in_filter` to `dailyGainValueMinor`. Callers that need the "position" convention for a single-investment slice (where a fully-sold slice reports `sellValueSum` as `totalValue`) can use `totalValuePosition` / `totalCostPosition` below.
 */
export type InvestmentStats = {
  /** Investment currency when the slice spans a single investment, `null` otherwise. */
  currency: string | null;
  /** Stock ticker when the slice spans a single listed investment, `null` for funds or multi-investment slices. */
  stockCode: string | null;
  /** Live-overlaid latest price when the slice spans a single investment: the Yahoo live price (or `previousClose` under `skipLive`) when a matching quote exists, otherwise the `InvestmentPrices` row with `isLatest = true`. `null` for multi-investment slices. */
  priceLatest: number | null;
  /** When the latest cached `InvestmentPrices` row for this investment was created. `null` for multi-investment slices, or when no price history exists yet. */
  priceLatestCachedAt: Date | null;
  /** Calendar date the latest cached `InvestmentPrices` row applies to (i.e. `InvestmentPrices.date`, not the row's DB-creation timestamp). Useful in tooltips to show what *day* the cached price represents — distinct from when we first stored it. `null` for multi-investment slices, or when no price history exists yet. */
  priceLatestCachedDate: Date | null;

  /** Net split-adjusted units matching the slice. Meaningful per-investment; across investments it's a meaningless sum (leave to callers that know the slice is single-investment). */
  unitsHeld: number;
  /** Units acquired via DRIP (drip = true, units > 0). */
  reinvestedUnits: number;
  /** Σ (units × price) across matching transactions. Buys add, sells subtract. */
  unitsPriceSum: number;
  /** Σ (units × price) across DRIP buys only. */
  reinvestedCostSum: number;
  /** Σ (units × price) across buys only (units > 0). */
  buyCostSum: number;
  /** Σ (|units| × price) across sells only (units < 0). */
  sellValueSum: number;
  /** Σ taxes across matching transactions (always non-negative). */
  taxesSum: number;
  /** Σ fees across matching transactions (always non-negative). */
  feesSum: number;

  /** Portfolio-convention total value: Σ per-contributing-investment of `unitsHeld_in_filter × priceLatest_investment` (live-overlaid). Fully-sold slices contribute 0. `null` when any contributing held investment is missing a price. */
  totalValueMinor: number | null;
  /** Live-quote-only daily gain: Σ per-contributing-held-investment-with-live-quote of `(live − previousClose) × unitsHeld_in_filter`. `null` when `skipLive` was set, or when no contributing investment has a usable live quote. */
  dailyGainValueMinor: number | null;
  /** Denominator for the aggregate daily-gain percentage — Σ of `previousClose × unitsHeld` over the same investments that fed `dailyGainValueMinor`. `null` with the same conditions. */
  dailyGainPrevValueMinor: number | null;

  /** Raw live-quote row for the investment, lifted off `InvestmentPricesLive`. Populated only on single-investment slices (`key.investmentId` set); `null` everywhere else and for non-stock investments / investments that have never been quoted. */
  live: LiveQuoteSnapshot | null;
};

/** What `InvestmentStats.live` exposes — the persisted live row for one investment. */
export type LiveQuoteSnapshot = {
  /** Live unit price in fractional units of `currency`. */
  priceMinor: number;
  /** Yahoo's `regularMarketPreviousClose` in the same fractional units. `null` when the upstream provider doesn't report it. */
  previousClosePriceMinor: number | null;
  /** Currency reported by the quote provider. */
  currency: string;
  /** Wall-clock time we last refreshed this entry. */
  refreshedAt: Date;
  /** Time of the actual price tick reported by the provider. */
  tickAt: Date;
};

/** Filter combination. `undefined` on any side drops that filter — so `{}` = the entire portfolio across every investment, `{investmentId}` = that stock across every portfolio, `{assetId}` = that portfolio across every stock, `{currency}` = every investment in that currency (used by `Portfolio` to avoid summing across currencies). `skipLive` toggles between the live-price and previous-close overlays for `priceLatest` and nulls out `dailyGain*`; it's part of the key because two callers that disagree on it need distinct results, but it never changes the underlying SQL — reconciliation happens in memory from the same slice rows. */
export type InvestmentStatsFilter = {
  investmentId?: string;
  /** Asset scope: union of slices whose `assetId` is in this set. Omit for the aggregate across every wrapper. */
  assetIds?: string[];
  currency?: string;
  skipLive?: boolean;
  /** Optional ISO-`YYYY-MM-DD` cap. When set, only `InvestmentTransactions` with `date <= dateCap` are aggregated, and `priceLatest` is the most recent `InvestmentPrices` row with `date <= dateCap` (live-quote overlay is skipped). Used to value a transferred-out wrapper as of the day before its transfer. */
  dateCap?: string;
  /** Additional asset scopes to fold in, each with its own capped date — used to render a transferred-into wrapper that inherits the source's pre-transfer transaction history. Each entry adds `(assetId = entry.assetId AND date <= entry.dateCap)` to the transactions filter, OR-combined with the main scope. `priceLatest` is unaffected (it stays "now" — the destination is live). Empty / omitted = no extra scope. */
  extraScopes?: ReadonlyArray<{ assetId: string; dateCap: string }>;
};

/**
 * Load the slice stats matching `filter`, batched per `Context` by a `DataLoader` that fires one SQL per tick regardless of how many keys are resolved. The SQL does every per-investment aggregation in the database (split multipliers, unit sums, value buckets, latest price) so the JS side only has to sum per-slice rows into the caller's requested filter shape and apply the live-quote overlay.
 *
 * Cross-request state is limited to the Drizzle `model(...)` row cache — the stats loader itself lives for the lifetime of the `Context`, so each request pays one DB roundtrip and then answers every filter combination from memory.
 */
export function loadInvestmentStats(
  ctx: Context,
  filter: InvestmentStatsFilter,
): Promise<InvestmentStats> {
  // Must stay synchronous up to `loader.load(...)` — any `await` between the
  // loader lookup and the load call drops the call into the next microtask,
  // which splits DataLoader's batch. When the `Portfolio` resolver fans its
  // filters out into N `loadInvestmentStats` calls across the same request
  // tick, we want them all to flush as one batch → one SQL.
  return getLoader(ctx).load(filter);
}

/**
 * Drop every cached entry on the stats `DataLoader` for `ctx`. Used by the
 * `portfolioLive` subscription so each tick's resolver pass recomputes
 * stats against the latest live-quote overlay instead of replaying the
 * first tick's snapshot.
 */
export function clearInvestmentStatsLoader(ctx: Context): void {
  getLoader(ctx).clearAll();
}

// One `DataLoader` per request, memoised on the `Context`. The wrapper is
// intentionally sync (see `contextAwareDataLoader`'s docstring) so the
// `.load(...)` above runs in the same microtask as every sibling call.
const getLoader = contextAwareDataLoader(
  () =>
    new DataLoader<InvestmentStatsFilter, InvestmentStats, string>(
      async (keys) => {
        // Group by `(dateCap, extraScopes)` so each batch hits one SQL whose
        // `WHERE` shape and `latestPrices` selection match. Mixing different
        // shapes would corrupt the per-key aggregates.
        const groupId = (k: InvestmentStatsFilter) => {
          const extra = k.extraScopes
            ? [...k.extraScopes]
                .sort((a, b) =>
                  a.assetId === b.assetId
                    ? a.dateCap.localeCompare(b.dateCap)
                    : a.assetId.localeCompare(b.assetId),
                )
                .map((s) => `${s.assetId}@${s.dateCap}`)
                .join(",")
            : "";
          return `${k.dateCap ?? ""}|${extra}`;
        };
        const byGroup = new Map<string, InvestmentStatsFilter[]>();
        for (const k of keys) {
          const id = groupId(k);
          const list = byGroup.get(id) ?? [];
          list.push(k);
          byGroup.set(id, list);
        }
        const sliceCtxByGroup = new Map<string, SliceContext>();
        await Promise.all(
          [...byGroup.entries()].map(async ([id, group]) => {
            sliceCtxByGroup.set(id, await fetchSlices(group));
          }),
        );
        return keys.map((k) =>
          aggregateKey(sliceCtxByGroup.get(groupId(k))!, k),
        );
      },
      { cacheKeyFn },
    ),
);

function cacheKeyFn(k: InvestmentStatsFilter): string {
  const assetIds = k.assetIds ? [...k.assetIds].sort().join(",") : "";
  const extra = k.extraScopes
    ? [...k.extraScopes]
        .sort((a, b) =>
          a.assetId === b.assetId
            ? a.dateCap.localeCompare(b.dateCap)
            : a.assetId.localeCompare(b.assetId),
        )
        .map((s) => `${s.assetId}@${s.dateCap}`)
        .join(",")
    : "";
  return `${k.investmentId ?? ""}|${assetIds}|${k.currency ?? ""}|${k.skipLive ? "1" : "0"}|${k.dateCap ?? ""}|${extra}`;
}

type SliceRow = {
  investmentId: string;
  /** `null` on the "no transactions at all" row that still exists for an investment (from the LEFT JOIN), never on a real slice. */
  assetId: string | null;
  currency: string;
  stockCode: string | null;
  priceLatestCached: number | null;
  priceLatestCachedAt: Date | null;
  /** Calendar date the cached price applies to. Postgres returns the `date`
   * column through the `sql` template as the raw `YYYY-MM-DD` string. */
  priceLatestCachedDate: string | null;
  unitsHeld: number;
  unitsPriceSum: number;
  buyCostSum: number;
  sellValueSum: number;
  taxesSum: number;
  feesSum: number;
  reinvestedUnits: number;
  reinvestedCostSum: number;

  /** Live-quote columns lifted off `InvestmentPricesLive` via `LEFT JOIN`. All five are non-null together, or all five are null (no live row for the investment yet, or the investment is a fund). */
  livePrice: number | null;
  livePricePreviousClose: number | null;
  liveCurrency: string | null;
  liveRefreshedAt: Date | null;
  liveTickAt: Date | null;
};

type SliceContext = {
  all: SliceRow[];
  byInvestment: Map<string, SliceRow[]>;
  byAsset: Map<string, SliceRow[]>;
  byBoth: Map<string, SliceRow>;
};

async function fetchSlices(
  keys: ReadonlyArray<InvestmentStatsFilter>,
): Promise<SliceContext> {
  // Every key in the batch shares the same `(dateCap, extraScopes)` (see
  // the loader's grouping), so we read them from the first key.
  const dateCap = keys[0]?.dateCap;
  const extraScopes = keys[0]?.extraScopes ?? [];
  // Tighten the SQL's scan to the union of the batch's filters — but only on
  // dimensions *every* key constrains. A single key that drops a dimension
  // (e.g. `{assetId: A}` without `investmentId`) would be answered wrongly
  // if we pre-filtered the other dimension on the batch's partial union, so
  // we fall back to "no filter" for that dimension.
  const investmentIds = keys.every((k) => k.investmentId !== undefined)
    ? [...new Set(keys.map((k) => k.investmentId as string))]
    : null;
  // Asset narrowing: only valid when *every* key constrains the asset
  // dimension via a non-empty `assetIds` set. Union the per-key sets into
  // the SQL filter. A single key that drops it would force the whole batch
  // to scan unfiltered. `extraScopes` (when set) also broadens the union —
  // those source-asset rows must come back too.
  const mainAssetIdSet = keys.every((k) => k.assetIds && k.assetIds.length > 0)
    ? [...new Set(keys.flatMap((k) => k.assetIds ?? []))]
    : null;
  const currencies = keys.every((k) => k.currency !== undefined)
    ? [...new Set(keys.map((k) => k.currency as string))]
    : null;

  // `tx_adj` — one row per `InvestmentTransactions`, with its split
  // multiplier folded into `adjUnits`. `ROUND(…, 6)` absorbs the FP drift
  // that `EXP(SUM(LN(ratio)))` introduces (e.g. a 2:1 split turns `LN(2) → 0.693…`
  // → `EXP(…) ≈ 2.000000000000…2`), so `100 × split` rounds cleanly to `200`.
  const txAdj = db.$with("tx_adj").as(
    db
      .select({
        id: InvestmentTransactions.id,
        investmentId: InvestmentTransactions.investmentId,
        assetId: InvestmentTransactions.assetId,
        units: InvestmentTransactions.units,
        price: InvestmentTransactions.price,
        taxes: InvestmentTransactions.taxes,
        fees: InvestmentTransactions.fees,
        drip: InvestmentTransactions.drip,
        adjUnits:
          sql<number>`ROUND((${InvestmentTransactions.units} * COALESCE(EXP(SUM(LN(${InvestmentStockSplits.ratio}::double precision))), 1))::numeric, 6)`.as(
            "adjUnits",
          ),
      })
      .from(InvestmentTransactions)
      .leftJoin(
        InvestmentStockSplits,
        and(
          eq(
            InvestmentStockSplits.investmentId,
            InvestmentTransactions.investmentId,
          ),
          gt(InvestmentStockSplits.date, InvestmentTransactions.date),
        ),
      )
      .where(
        and(
          investmentIds
            ? inArray(InvestmentTransactions.investmentId, investmentIds)
            : undefined,
          // Asset+date predicate: when extraScopes are present, OR-combine
          // the main scope (mainAssetIds capped by `dateCap`, if set) with
          // each extra scope (its `assetId` capped by its own `dateCap`).
          // Without extraScopes this collapses back to the simple "main
          // assets, optional date cap" filter.
          (() => {
            const mainAssetIds = mainAssetIdSet;
            if (!mainAssetIds && extraScopes.length === 0) {
              return dateCap
                ? sql`${InvestmentTransactions.date} <= ${dateCap}::date`
                : undefined;
            }
            if (extraScopes.length === 0) {
              // Common path — single-scope query collapses to the existing
              // shape so we keep using `inArray` (which renders the param
              // list as the planner expects).
              return and(
                mainAssetIds
                  ? inArray(InvestmentTransactions.assetId, mainAssetIds)
                  : undefined,
                dateCap
                  ? sql`${InvestmentTransactions.date} <= ${dateCap}::date`
                  : undefined,
              );
            }
            const branches: ReturnType<typeof sql>[] = [];
            if (mainAssetIds && mainAssetIds.length > 0) {
              const dateClause = dateCap
                ? sql` AND ${InvestmentTransactions.date} <= ${dateCap}::date`
                : sql``;
              branches.push(
                sql`(${inArray(InvestmentTransactions.assetId, mainAssetIds)}${dateClause})`,
              );
            }
            for (const s of extraScopes) {
              branches.push(
                sql`(${InvestmentTransactions.assetId} = ${s.assetId} AND ${InvestmentTransactions.date} <= ${s.dateCap}::date)`,
              );
            }
            return sql`(${sql.join(branches, sql` OR `)})`;
          })(),
        ),
      )
      .groupBy(InvestmentTransactions.id),
  );

  // `latestPrices` — one row per investment (or zero if no history yet). When
  // uncapped, hits the partial unique index on `(investmentId, isLatest)`
  // (migration `0024`). When `dateCap` is set, uses `DISTINCT ON
  // ("investmentId") ORDER BY "investmentId", date DESC` against the
  // `(investmentId, date)` unique index to pick the latest pre-cap row per
  // investment — used to value a transferred-out wrapper as of its frozen
  // pre-transfer state. The earlier `NOT EXISTS (... date > ip.date)` shape
  // produced an O(N²) anti-join that scanned ~12k buffers and dominated the
  // capped-stats SQL wall time at ~17 ms.
  const latestPrices = (
    dateCap
      ? db
          .selectDistinctOn([InvestmentPrices.investmentId], {
            investmentId: InvestmentPrices.investmentId,
            priceAdjusted: InvestmentPrices.priceAdjusted,
            createdAt: InvestmentPrices.createdAt,
            date: InvestmentPrices.date,
          })
          .from(InvestmentPrices)
          .where(
            and(
              sql`${InvestmentPrices.date} <= ${dateCap}::date`,
              investmentIds
                ? inArray(InvestmentPrices.investmentId, investmentIds)
                : undefined,
            ),
          )
          .orderBy(
            asc(InvestmentPrices.investmentId),
            desc(InvestmentPrices.date),
          )
      : db
          .select({
            investmentId: InvestmentPrices.investmentId,
            priceAdjusted: InvestmentPrices.priceAdjusted,
            createdAt: InvestmentPrices.createdAt,
            date: InvestmentPrices.date,
          })
          .from(InvestmentPrices)
          .where(
            and(
              eq(InvestmentPrices.isLatest, true),
              investmentIds
                ? inArray(InvestmentPrices.investmentId, investmentIds)
                : undefined,
            ),
          )
  ).as("latestPrices");

  // Outer aggregation: one row per `(investmentId, assetId)` slice. The
  // `LEFT JOIN` from `Investments` keeps a row even for investments with no
  // transactions (so `InvestmentPosition` on an empty-history investment
  // still gets a valid zero stats object rather than an error).
  const all = await db
    .with(txAdj)
    .select({
      investmentId: Investments.id,
      assetId: txAdj.assetId,
      currency: Investments.currency,
      stockCode: Investments.stockCode,
      priceLatestCached: latestPrices.priceAdjusted,
      priceLatestCachedAt: latestPrices.createdAt,
      priceLatestCachedDate: sql<string | null>`${latestPrices.date}`.as(
        "priceLatestCachedDate",
      ),
      livePrice: InvestmentPricesLive.price,
      livePricePreviousClose: InvestmentPricesLive.pricePreviousClose,
      liveCurrency: InvestmentPricesLive.currency,
      liveRefreshedAt: InvestmentPricesLive.refreshedAt,
      liveTickAt: InvestmentPricesLive.date,
      unitsHeld:
        sql<number>`COALESCE(SUM(${txAdj.adjUnits}), 0)::double precision`.as(
          "unitsHeld",
        ),
      unitsPriceSum:
        sql<number>`COALESCE(SUM(${txAdj.units} * ${txAdj.price}), 0)::double precision`.as(
          "unitsPriceSum",
        ),
      buyCostSum:
        sql<number>`COALESCE(SUM(${txAdj.units} * ${txAdj.price}) FILTER (WHERE ${txAdj.units} > 0), 0)::double precision`.as(
          "buyCostSum",
        ),
      sellValueSum:
        sql<number>`COALESCE(SUM((-${txAdj.units}) * ${txAdj.price}) FILTER (WHERE ${txAdj.units} < 0), 0)::double precision`.as(
          "sellValueSum",
        ),
      taxesSum: sql<number>`COALESCE(SUM(${txAdj.taxes}), 0)::bigint`.as(
        "taxesSum",
      ),
      feesSum: sql<number>`COALESCE(SUM(${txAdj.fees}), 0)::bigint`.as(
        "feesSum",
      ),
      reinvestedUnits:
        sql<number>`COALESCE(SUM(${txAdj.adjUnits}) FILTER (WHERE ${txAdj.drip} AND ${txAdj.units} > 0), 0)::double precision`.as(
          "reinvestedUnits",
        ),
      reinvestedCostSum:
        sql<number>`COALESCE(SUM(${txAdj.units} * ${txAdj.price}) FILTER (WHERE ${txAdj.drip} AND ${txAdj.units} > 0), 0)::double precision`.as(
          "reinvestedCostSum",
        ),
    })
    .from(Investments)
    .leftJoin(latestPrices, eq(latestPrices.investmentId, Investments.id))
    .leftJoin(
      InvestmentPricesLive,
      eq(InvestmentPricesLive.investmentId, Investments.id),
    )
    .leftJoin(txAdj, eq(txAdj.investmentId, Investments.id))
    .where(
      and(
        investmentIds ? inArray(Investments.id, investmentIds) : undefined,
        currencies
          ? inArray(
              Investments.currency,
              currencies as (typeof Investments.currency._.data)[],
            )
          : undefined,
      ),
    )
    .groupBy(
      Investments.id,
      Investments.currency,
      Investments.stockCode,
      latestPrices.priceAdjusted,
      latestPrices.createdAt,
      latestPrices.date,
      InvestmentPricesLive.price,
      InvestmentPricesLive.pricePreviousClose,
      InvestmentPricesLive.currency,
      InvestmentPricesLive.refreshedAt,
      InvestmentPricesLive.date,
      txAdj.assetId,
    );

  // Postgres returns `numeric` (and our `::bigint` casts) as strings through
  // the `postgres` driver — JS-side arithmetic on those strings silently
  // concatenates rather than adds, corrupting every downstream aggregate.
  // Coerce to `number` at the boundary.
  const rows: SliceRow[] = all.map((r) => ({
    ...r,
    unitsHeld: Number(r.unitsHeld),
    unitsPriceSum: Number(r.unitsPriceSum),
    buyCostSum: Number(r.buyCostSum),
    sellValueSum: Number(r.sellValueSum),
    taxesSum: Number(r.taxesSum),
    feesSum: Number(r.feesSum),
    reinvestedUnits: Number(r.reinvestedUnits),
    reinvestedCostSum: Number(r.reinvestedCostSum),
    priceLatestCached:
      r.priceLatestCached === null ? null : Number(r.priceLatestCached),
    livePrice: r.livePrice === null ? null : Number(r.livePrice),
    livePricePreviousClose:
      r.livePricePreviousClose === null
        ? null
        : Number(r.livePricePreviousClose),
  }));

  triggerLiveRefreshes(rows);

  const byInvestment = new Map<string, SliceRow[]>();
  const byAsset = new Map<string, SliceRow[]>();
  const byBoth = new Map<string, SliceRow>();
  for (const r of rows) {
    let list = byInvestment.get(r.investmentId);
    if (!list) {
      list = [];
      byInvestment.set(r.investmentId, list);
    }
    list.push(r);
    if (r.assetId !== null) {
      let alist = byAsset.get(r.assetId);
      if (!alist) {
        alist = [];
        byAsset.set(r.assetId, alist);
      }
      alist.push(r);
      byBoth.set(`${r.investmentId}|${r.assetId}`, r);
    }
  }
  return { all: rows, byInvestment, byAsset, byBoth };
}

function aggregateKey(
  ctx: SliceContext,
  key: InvestmentStatsFilter,
): InvestmentStats {
  // `dateCap` forces the live row out entirely — live quotes are "now"
  // (and `previousClose` is yesterday's close), neither of which can be
  // substituted into a frozen pre-transfer valuation. The capped
  // `priceLatestCached` (price ≤ `dateCap`) is the only price we use.
  const skipLive = !!key.skipLive;
  const ignoreLive = !!key.dateCap;
  const matches = selectSlices(ctx, key);

  // Sum the raw-aggregate columns directly across every matching slice.
  let unitsHeld = 0;
  let unitsPriceSum = 0;
  let buyCostSum = 0;
  let sellValueSum = 0;
  let taxesSum = 0;
  let feesSum = 0;
  let reinvestedUnits = 0;
  let reinvestedCostSum = 0;
  for (const r of matches) {
    unitsHeld += r.unitsHeld;
    unitsPriceSum += r.unitsPriceSum;
    buyCostSum += r.buyCostSum;
    sellValueSum += r.sellValueSum;
    taxesSum += r.taxesSum;
    feesSum += r.feesSum;
    reinvestedUnits += r.reinvestedUnits;
    reinvestedCostSum += r.reinvestedCostSum;
  }

  // Per-investment pass for `totalValueMinor` / daily gain: `priceLatest`
  // lives at the investment level, so we bucket by investmentId, sum the
  // filter-matching units inside each bucket, and only then multiply by
  // the investment's (live-overlaid) priceLatest.
  const perInvestment = new Map<string, SliceRow[]>();
  for (const r of matches) {
    let list = perInvestment.get(r.investmentId);
    if (!list) {
      list = [];
      perInvestment.set(r.investmentId, list);
    }
    list.push(r);
  }

  let totalValueMinor: number | null = 0;
  let dailyGainValueMinor: number | null = null;
  let dailyGainPrevValueMinor: number | null = null;
  for (const [, slices] of perInvestment) {
    const meta = slices[0];
    const invUnits = slices.reduce((a, s) => a + s.unitsHeld, 0);
    const overlay = ignoreLive
      ? { priceLatest: meta.priceLatestCached, live: null }
      : overlayLive(meta, skipLive);
    // Portfolio-convention totalValue: fully-sold slices contribute 0.
    if (invUnits > 0) {
      if (overlay.priceLatest === null) {
        totalValueMinor = null;
      } else if (totalValueMinor !== null) {
        totalValueMinor += invUnits * overlay.priceLatest;
      }
    }
    // Daily gain requires a held position + a live quote with previousClose.
    if (!skipLive && !ignoreLive && invUnits > 0 && overlay.live) {
      const prev = overlay.live.previousClosePriceMinor;
      if (prev !== null) {
        dailyGainValueMinor =
          (dailyGainValueMinor ?? 0) +
          (overlay.live.priceMinor - prev) * invUnits;
        dailyGainPrevValueMinor =
          (dailyGainPrevValueMinor ?? 0) + prev * invUnits;
      }
    }
  }

  // Per-investment metadata surfaces only when the key pins a single
  // investment. Multi-investment slices hide it so callers can't accidentally
  // pick "the first investment's currency" as though it applied to the
  // aggregate. Pulling from `byInvestment` (rather than `matches`) handles
  // the edge case where a pinned `(investmentId, assetId)` pair has no
  // matching transactions yet — the outer `LEFT JOIN` still gives us the
  // investment's currency / stockCode / cached price.
  const metaSource = key.investmentId
    ? (ctx.byInvestment.get(key.investmentId)?.[0] ?? null)
    : null;
  const overlay = metaSource
    ? ignoreLive
      ? { priceLatest: metaSource.priceLatestCached, live: null }
      : overlayLive(metaSource, skipLive)
    : null;

  return {
    currency: metaSource?.currency ?? null,
    stockCode: metaSource?.stockCode ?? null,
    priceLatest: overlay?.priceLatest ?? null,
    priceLatestCachedAt: metaSource?.priceLatestCachedAt ?? null,
    priceLatestCachedDate: metaSource?.priceLatestCachedDate
      ? new Date(metaSource.priceLatestCachedDate)
      : null,
    unitsHeld,
    unitsPriceSum,
    buyCostSum,
    sellValueSum,
    taxesSum,
    feesSum,
    reinvestedUnits,
    reinvestedCostSum,
    totalValueMinor,
    dailyGainValueMinor,
    dailyGainPrevValueMinor,
    live: overlay?.live ?? null,
  };
}

function selectSlices(
  ctx: SliceContext,
  key: InvestmentStatsFilter,
): SliceRow[] {
  // Asset narrowing: extraScopes' asset rows must also be in scope (their
  // pre-cap rows have already been folded into the SQL aggregates by
  // `fetchSlices`).
  const baseAssets =
    key.assetIds && key.assetIds.length > 0 ? key.assetIds : [];
  const extraAssets = key.extraScopes
    ? key.extraScopes.map((s) => s.assetId)
    : [];
  const assetSet =
    baseAssets.length + extraAssets.length > 0
      ? new Set<string>([...baseAssets, ...extraAssets])
      : null;
  let candidates: SliceRow[];
  if (key.investmentId && assetSet && assetSet.size === 1) {
    const [assetId] = [...assetSet];
    const r = ctx.byBoth.get(`${key.investmentId}|${assetId}`);
    candidates = r ? [r] : [];
  } else if (key.investmentId) {
    candidates = ctx.byInvestment.get(key.investmentId) ?? [];
    if (assetSet) {
      candidates = candidates.filter(
        (r) => r.assetId !== null && assetSet.has(r.assetId),
      );
    }
  } else if (assetSet && assetSet.size === 1) {
    const [assetId] = [...assetSet];
    candidates = ctx.byAsset.get(assetId) ?? [];
  } else {
    // No narrowing hit → every row (including the "no transactions"
    // placeholder rows for investments that have no txs yet; those
    // contribute zero to every sum and no investment to the
    // per-investment pass, so they're inert).
    candidates = ctx.all;
  }
  if (assetSet && assetSet.size > 1) {
    candidates = candidates.filter(
      (r) => r.assetId !== null && assetSet.has(r.assetId),
    );
  }
  // Currency filter applies even when the SQL was issued without it — a
  // batch mixing GBP and USD keys still brings back both currencies'
  // slices, so each key has to narrow to its own currency.
  if (key.currency !== undefined) {
    candidates = candidates.filter((r) => r.currency === key.currency);
  }
  return candidates;
}

type LiveOverlay = {
  priceLatest: number | null;
  live: LiveQuoteSnapshot | null;
};

function overlayLive(row: SliceRow, skipLive: boolean): LiveOverlay {
  const live = liveSnapshot(row);
  if (!live) {
    return { priceLatest: row.priceLatestCached, live: null };
  }
  // `skipLive` doesn't change which row we *read* — the persisted live row is
  // always the source — only whether we expose `live.priceMinor` (live) or
  // `live.previousClosePriceMinor` (yesterday's close) as `priceLatest`.
  const priceLatest = skipLive
    ? (live.previousClosePriceMinor ?? live.priceMinor)
    : live.priceMinor;
  return { priceLatest, live };
}

function liveSnapshot(row: SliceRow): LiveQuoteSnapshot | null {
  if (
    row.livePrice === null ||
    row.liveCurrency === null ||
    row.liveRefreshedAt === null ||
    row.liveTickAt === null
  ) {
    return null;
  }
  if (row.liveCurrency !== row.currency) return null;
  return {
    priceMinor: row.livePrice,
    previousClosePriceMinor: row.livePricePreviousClose,
    currency: row.liveCurrency,
    refreshedAt: row.liveRefreshedAt,
    tickAt: row.liveTickAt,
  };
}

/** Scan the just-loaded slice rows and fire-and-forget a Yahoo refresh for any held stock investment whose live row is missing or older than `LIVE_QUOTE_STALE_MS`. Inside the currency's business-hours window the refresh always fires; outside, it only fires when no live row exists yet (so a never-quoted ticker still gets an initial price overnight / on weekends). The current request still answers from the row we just read; the refreshed row only surfaces on the *next* loader hit (e.g. the next `portfolioLive` tick). */
function triggerLiveRefreshes(rows: SliceRow[]): void {
  const seen = new Set<string>();
  const now = Date.now();
  for (const r of rows) {
    if (!r.stockCode) continue;
    if (seen.has(r.investmentId)) continue;
    seen.add(r.investmentId);
    const refreshedAt = r.liveRefreshedAt;
    const fresh =
      refreshedAt !== null &&
      now - refreshedAt.getTime() <= LIVE_QUOTE_STALE_MS;
    if (fresh) continue;
    if (refreshedAt !== null && !isInBusinessHours(r.currency)) continue;
    void fetchQuote(r.stockCode, {
      investmentId: r.investmentId,
      currency: r.currency,
      // Bypass the window when this would be the first quote we've ever
      // recorded for the ticker — without it, a brand-new investment added
      // overnight / on the weekend would render with `unitPriceLatest = null`
      // until Monday morning.
      bypassBusinessHours: refreshedAt === null,
    });
  }
}

// ---- Derived helpers -----------------------------------------------------
//
// Total return is computed from aggregate slice numbers, not lot-level FIFO
// ordering — the breakdown into realised vs unrealised depends on FIFO, but
// the *sum* (realised + unrealised) only needs `totalValue + sellProceeds −
// gross-buy-cost-excluding-DRIP`. DRIP buys are excluded from `totalCost`
// because the underlying dividend was already income; treating reinvested
// shares as new capital would double-count the dividend.

export function isFullySold(s: InvestmentStats): boolean {
  return s.unitsHeld === 0 && (s.buyCostSum > 0 || s.sellValueSum > 0);
}

/** Gross capital deployed: cumulative buy cost (excluding DRIP — those are dividends-as-shares, not new capital), plus paid fees and taxes (real outlays that reduce return). Independent of how much has subsequently been sold; never goes negative. */
export function totalCostPosition(s: InvestmentStats): number {
  return s.buyCostSum - s.reinvestedCostSum + s.feesSum + s.taxesSum;
}

/** Current market value of held units; for a fully-sold position falls back to realised sell proceeds so a closed-out investment still has a meaningful "value" headline. `null` until at least one price is known for a still-held position. */
export function totalValuePosition(s: InvestmentStats): number | null {
  if (isFullySold(s)) return s.sellValueSum;
  if (s.priceLatest === null) return null;
  return s.unitsHeld * s.priceLatest;
}

/** Market value of currently-held units only (no fully-sold fallback). Used as the unrealised side of total return. `null` when held units have no known price; `0` when no units are held. */
function heldMarketValue(s: InvestmentStats): number | null {
  if (s.unitsHeld === 0) return 0;
  if (s.priceLatest === null) return null;
  return s.unitsHeld * s.priceLatest;
}

/**
 * Total return = unrealised + realised. Equivalent to `marketValueOfHeld + sellProceeds − totalCost` — DRIPs at zero cost are baked in via `totalCost`.
 *
 * `null` only when there's no price for a still-held position (so unrealised value is unknown). Returns 0 for an empty investment.
 */
export function totalGainPosition(s: InvestmentStats): number | null {
  const m = heldMarketValue(s);
  if (m === null) return null;
  return m + s.sellValueSum - totalCostPosition(s);
}

export function percentGainPosition(s: InvestmentStats): number | null {
  const g = totalGainPosition(s);
  if (g === null) return null;
  const c = totalCostPosition(s);
  if (c === 0) return null;
  return g / c;
}

/** Daily gain helpers below read pre-computed fields — both are `null` under `skipLive` or when no contributing live quote exists. */
export function dailyGainPercent(s: InvestmentStats): number | null {
  if (
    s.dailyGainValueMinor === null ||
    s.dailyGainPrevValueMinor === null ||
    s.dailyGainPrevValueMinor === 0
  ) {
    return null;
  }
  return s.dailyGainValueMinor / s.dailyGainPrevValueMinor;
}

export function reinvestedValue(s: InvestmentStats): number | null {
  if (s.priceLatest === null) return null;
  return s.reinvestedUnits * s.priceLatest;
}

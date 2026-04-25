import DataLoader from "dataloader";
import { and, eq, gt, inArray, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  InvestmentPrices,
  Investments,
  InvestmentStockSplits,
  InvestmentTransactions,
} from "@/db/schema/investments";
import { readCachedQuote, readOrRefresh } from "@/tasks/yahoo";

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
};

/** Filter combination. `undefined` on any side drops that filter — so `{}` = the entire portfolio across every investment, `{investmentId}` = that stock across every portfolio, `{assetId}` = that portfolio across every stock, `{currency}` = every investment in that currency (used by `Portfolio` to avoid summing across currencies). `skipLive` toggles between the live-price and previous-close overlays for `priceLatest` and nulls out `dailyGain*`; it's part of the key because two callers that disagree on it need distinct results, but it never changes the underlying SQL — reconciliation happens in memory from the same slice rows. */
export type InvestmentStatsFilter = {
  investmentId?: string;
  /** Asset scope: union of slices whose `assetId` is in this set. Omit for the aggregate across every wrapper. */
  assetIds?: string[];
  currency?: string;
  skipLive?: boolean;
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
        const sliceCtx = await fetchSlices(keys);
        return keys.map((k) => aggregateKey(sliceCtx, k));
      },
      { cacheKeyFn },
    ),
);

function cacheKeyFn(k: InvestmentStatsFilter): string {
  const assetIds = k.assetIds ? [...k.assetIds].sort().join(",") : "";
  return `${k.investmentId ?? ""}|${assetIds}|${k.currency ?? ""}|${k.skipLive ? "1" : "0"}`;
}

type SliceRow = {
  investmentId: string;
  /** `null` on the "no transactions at all" row that still exists for an investment (from the LEFT JOIN), never on a real slice. */
  assetId: string | null;
  currency: string;
  stockCode: string | null;
  priceLatestCached: number | null;
  priceLatestCachedAt: Date | null;
  unitsHeld: number;
  unitsPriceSum: number;
  buyCostSum: number;
  sellValueSum: number;
  taxesSum: number;
  feesSum: number;
  reinvestedUnits: number;
  reinvestedCostSum: number;
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
  // to scan unfiltered.
  const assetIds = keys.every((k) => k.assetIds && k.assetIds.length > 0)
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
          assetIds
            ? inArray(InvestmentTransactions.assetId, assetIds)
            : undefined,
        ),
      )
      .groupBy(InvestmentTransactions.id),
  );

  // `latestPrices` — one row per investment (or zero if no history yet), via
  // the partial unique index on `(investmentId, isLatest)` added in migration
  // `0024`. Scoped to the batch's investment filter when all keys pin one.
  const latestPrices = db
    .select({
      investmentId: InvestmentPrices.investmentId,
      priceAdjusted: InvestmentPrices.priceAdjusted,
      createdAt: InvestmentPrices.createdAt,
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
    .as("latestPrices");

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
  }));

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
  const skipLive = !!key.skipLive;
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
    const overlay = overlayLive(meta, skipLive);
    // Portfolio-convention totalValue: fully-sold slices contribute 0.
    if (invUnits > 0) {
      if (overlay.priceLatest === null) {
        totalValueMinor = null;
      } else if (totalValueMinor !== null) {
        totalValueMinor += invUnits * overlay.priceLatest;
      }
    }
    // Daily gain requires a held position + a live quote with previousClose.
    if (!skipLive && invUnits > 0 && overlay.live) {
      const prev = overlay.live.previousClosePriceMinorUnits;
      if (prev !== null) {
        dailyGainValueMinor =
          (dailyGainValueMinor ?? 0) +
          (overlay.live.priceMinorUnits - prev) * invUnits;
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
  const overlay = metaSource ? overlayLive(metaSource, skipLive) : null;

  return {
    currency: metaSource?.currency ?? null,
    stockCode: metaSource?.stockCode ?? null,
    priceLatest: overlay?.priceLatest ?? null,
    priceLatestCachedAt: metaSource?.priceLatestCachedAt ?? null,
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
  };
}

function selectSlices(
  ctx: SliceContext,
  key: InvestmentStatsFilter,
): SliceRow[] {
  const assetSet =
    key.assetIds && key.assetIds.length > 0 ? new Set(key.assetIds) : null;
  let candidates: SliceRow[];
  if (key.investmentId && assetSet && assetSet.size === 1) {
    const [assetId] = key.assetIds as string[];
    const r = ctx.byBoth.get(`${key.investmentId}|${assetId}`);
    candidates = r ? [r] : [];
  } else if (key.investmentId) {
    candidates = ctx.byInvestment.get(key.investmentId) ?? [];
  } else if (assetSet && assetSet.size === 1) {
    const [assetId] = key.assetIds as string[];
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
  live: ReturnType<typeof readOrRefresh> | null;
};

function overlayLive(row: SliceRow, skipLive: boolean): LiveOverlay {
  if (!row.stockCode) {
    return { priceLatest: row.priceLatestCached, live: null };
  }
  // `skipLive` controls whether we *fetch* a fresh quote over the network,
  // not whether we read the in-process LRU — the cached quote is always
  // consulted so both "live" and "previous close" views stay internally
  // consistent with `Investment.unitPriceLatest`.
  const live = skipLive
    ? readCachedQuote(row.stockCode)
    : readOrRefresh(row.stockCode);
  if (!live || live.currency !== row.currency) {
    return { priceLatest: row.priceLatestCached, live: null };
  }
  const priceLatest = skipLive
    ? (live.previousClosePriceMinorUnits ?? live.priceMinorUnits)
    : live.priceMinorUnits;
  return { priceLatest, live };
}

// ---- Derived helpers -----------------------------------------------------
//
// Used by the single-investment-scoped `InvestmentPosition` resolver, which
// wants the "position" convention — a fully-sold investment reports its
// realised proceeds as `totalValue` and its gross buy-cost as `totalCost`.
// Multi-investment slices should use `totalValueMinor` / `unitsPriceSum`
// directly.

export function isFullySold(s: InvestmentStats): boolean {
  return s.unitsHeld === 0 && (s.buyCostSum > 0 || s.sellValueSum > 0);
}

export function costBasis(s: InvestmentStats): number | null {
  if (s.unitsHeld === 0) return null;
  return s.unitsPriceSum / s.unitsHeld;
}

export function costBasisWithFees(s: InvestmentStats): number | null {
  if (s.unitsHeld === 0) return null;
  return (s.unitsPriceSum + s.taxesSum + s.feesSum) / s.unitsHeld;
}

export function totalValuePosition(s: InvestmentStats): number | null {
  if (isFullySold(s)) return s.sellValueSum;
  if (s.priceLatest === null) return null;
  return s.unitsHeld * s.priceLatest;
}

export function totalCostPosition(s: InvestmentStats): number {
  if (isFullySold(s)) return s.buyCostSum;
  return s.unitsPriceSum;
}

export function totalGainPosition(s: InvestmentStats): number | null {
  const v = totalValuePosition(s);
  if (v === null) return null;
  return v - totalCostPosition(s);
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

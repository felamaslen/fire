import DataLoader from "dataloader";
import { differenceInDays, formatISO } from "date-fns";
import { sql } from "drizzle-orm";
import type { ID } from "grats";

import { HOME_CURRENCY } from "@/config";
import { db } from "@/db";

import { Context, contextAwareDataLoader } from "../context";
import { Money } from "../money";
import {
  PortfolioCandlestick,
  PortfolioCandlestickPoint,
  PortfolioCandleUnit,
} from "./portfolio";
import { loadInvestmentStats } from "./stats";

/** Per-`(unit, length)` cap on the chart's visible range — the maximum number of *days* `before` to `after` may span before the resolver throws. Calibrated to give the client roughly the same number of buckets at every zoom level (a few hundred to a few thousand), so 3D candles can't be asked to render twenty years of data. A small allowance is added on top to absorb rounding around bucket-boundary snaps. */
const RANGE_LIMIT_DAYS: Record<string, number> = {
  // 3D: 2 years of history.
  "DAY|3": 365 * 2,
  // 1W: 5 years.
  "WEEK|1": 365 * 5,
  // 2W: 10 years.
  "WEEK|2": 365 * 10,
  // 1M: 20 years.
  "MONTH|1": 365 * 20,
  // 3M: 60 years (effectively unbounded).
  "MONTH|3": 365 * 60,
};
const RANGE_LIMIT_ALLOWANCE_DAYS = 31;

function rangeLimitDays(unit: PortfolioCandleUnit, length: number): number {
  const key = `${unit}|${length}`;
  const limit = RANGE_LIMIT_DAYS[key];
  if (limit !== undefined) return limit + RANGE_LIMIT_ALLOWANCE_DAYS;
  // Fall-through for unit/length combos the UI doesn't currently expose:
  // pick a sensible default proportional to bucket width.
  const bucketDays =
    unit === "DAY" ? length : unit === "WEEK" ? length * 7 : length * 30;
  return bucketDays * 200 + RANGE_LIMIT_ALLOWANCE_DAYS;
}

/** Encode `(assetIds, size, bucketStart)` into a stable opaque ID. Apollo treats this as the cache key for `PortfolioCandlestickPoint` so the same bucket appearing in two overlapping queries (e.g. before vs after a pan) merges into one cache entry instead of duplicating. */
function encodeCandlePointId(
  assetIds: readonly string[],
  unit: PortfolioCandleUnit,
  length: number,
  bucketStart: string,
): ID {
  const assets = assetIds.length > 0 ? [...assetIds].sort().join(",") : "";
  const raw = `cp:${assets}|${unit}_${length}|${bucketStart}`;
  return Buffer.from(raw, "utf-8").toString("base64url") as ID;
}

type CandlestickKey = {
  /** When set, filters the result to the combined portfolio across these net worth asset IDs. Undefined / empty = every asset. */
  assetIds?: string[];
  /** Each candle spans `length` of `unit`s. */
  unit: PortfolioCandleUnit;
  length: number;
  /** Default bucket count when neither `after` nor `before` is set. Ignored when `after` is set (the range is then `(after, before ?? today)`). */
  max: number;
  /** When `false`, the rightmost bucket's `valueEnd` / `valueMax` / `valueMin` are overlaid with today's live-overlaid portfolio total. */
  skipLive: boolean;
  /** Right-edge cap (transferred-out wrappers freeze on the day before the transfer; `Portfolio.candlestick(before:)` also lands here). */
  dateCap?: string;
  /** Lower bound on the visible range (inclusive). When set, the leftmost bucket starts at-or-after this date. */
  after?: string;
  /** Additional asset scopes folded in for a transferred-into wrapper (the source's pre-transfer holdings flow into the destination). */
  extraScopes?: ReadonlyArray<{ assetId: string; dateCap: string }>;
};

const cacheKeyFn = (key: CandlestickKey): string => {
  const assets =
    key.assetIds && key.assetIds.length > 0
      ? [...key.assetIds].sort().join(",")
      : "";
  const extra = key.extraScopes
    ? [...key.extraScopes]
        .sort((a, b) =>
          a.assetId === b.assetId
            ? a.dateCap.localeCompare(b.dateCap)
            : a.assetId.localeCompare(b.assetId),
        )
        .map((s) => `${s.assetId}@${s.dateCap}`)
        .join(",")
    : "";
  return `${key.unit}|${key.length}|${key.max}|${assets}|${key.skipLive ? "1" : "0"}|${key.dateCap ?? ""}|${key.after ?? ""}|${extra}`;
};

/**
 * Retrieves a candlestick series of portfolio total value, optionally filtered to a set of net-worth assets (the combined position across them).
 *
 * Reads pre-aggregated daily totals from `InvestmentValuePoints` (maintained by triggers — see `db/schema/investments.ts`) and aggregates them into OHLC buckets in SQL. Per-date portfolio totals are computed *before* min/max so `lo` / `hi` reflect the true drawdown / peak of the held position across the bucket — not the sum of per-investment extrema on possibly different days (which would mis-state portfolio-level volatility).
 */
export const loadCandlestick = contextAwareDataLoader(
  (ctx) =>
    new DataLoader<CandlestickKey, PortfolioCandlestick | null, string>(
      (keys) => Promise.all(keys.map((k) => loadOne(ctx, k))),
      { cacheKeyFn },
    ),
);

type Row = {
  start: string;
  end: string;
  valueMin: number;
  valueMax: number;
  valueStart: number;
  valueEnd: number;
};

/** Snap `d` to the bucket start it belongs to, given a `(unit, length)` candle width. Bucket boundaries are anchored to a fixed epoch (1970-01-01 for DAY, the Monday 1969-12-29 for WEEK, 1970-01-01 for MONTH) and indexed in multiples of `length`, so two requests with different right-edge anchors but the same `(unit, length)` produce buckets that line up exactly — pagination via the `before` cursor returns adjoining ranges, not a shifted one. */
function snapBucketStart(
  d: Date,
  unit: PortfolioCandleUnit,
  length: number,
): Date {
  const out = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
  if (unit === "DAY") {
    const daysSinceEpoch = Math.floor(out.getTime() / 86400000);
    const offset = ((daysSinceEpoch % length) + length) % length;
    out.setUTCDate(out.getUTCDate() - offset);
    return out;
  }
  if (unit === "WEEK") {
    // Snap to ISO Monday first, then to a multiple of `length` weeks
    // since 1969-12-29 (the Monday of the week containing the Unix
    // epoch).
    const dayOfWeek = out.getUTCDay(); // 0 Sun .. 6 Sat
    const offsetToMon = (dayOfWeek + 6) % 7;
    out.setUTCDate(out.getUTCDate() - offsetToMon);
    if (length > 1) {
      const epochMon = Date.UTC(1969, 11, 29);
      const weeksSince = Math.floor(
        (out.getTime() - epochMon) / (7 * 86400000),
      );
      const offset = ((weeksSince % length) + length) % length;
      out.setUTCDate(out.getUTCDate() - offset * 7);
    }
    return out;
  }
  if (unit === "MONTH") {
    out.setUTCDate(1);
    if (length > 1) {
      const monthsSince =
        (out.getUTCFullYear() - 1970) * 12 + out.getUTCMonth();
      const offset = ((monthsSince % length) + length) % length;
      out.setUTCMonth(out.getUTCMonth() - offset);
    }
    return out;
  }
  throw new Error(`Unhandled candle unit: ${unit as string}`);
}

const loadOne = async (
  ctx: Context,
  key: CandlestickKey,
): Promise<PortfolioCandlestick | null> => {
  const currency = HOME_CURRENCY;
  const unit = sql.raw(key.unit.toLowerCase());
  const step = sql.raw(String(key.length));
  // OR-combined asset scope over `InvestmentValuePoints`. Empty filter =
  // "every asset" (the unscoped portfolio chart).
  //
  // Extra scopes (transferred-in source wrappers) include the source's
  // assetId without a per-scope `ivp.date <= s.dateCap` filter. Each
  // extra-scope's `dateCap` was meant by the original (txn-based) query
  // to limit which TXNs of the source accumulate into units; once those
  // units are accumulated, the source's contribution at any chart day is
  // `units × price-at-day`. In IVP, units remain constant after the
  // source's last txn, so reading IVP for the source across all dates
  // gives the same answer — provided the source has no post-`dateCap`
  // txns. That invariant is enforced upstream: `effectiveAssetFilter`
  // only emits extras for `InvestmentTransfers` source wrappers, which
  // by codebase convention are not booked against after the transfer.
  const ivpScopeFilter = (() => {
    const mainAssetIds = key.assetIds ?? [];
    const extraScopes = key.extraScopes ?? [];
    if (mainAssetIds.length === 0 && extraScopes.length === 0) {
      return sql``;
    }
    const branches: ReturnType<typeof sql>[] = [];
    if (mainAssetIds.length > 0) {
      const dateClause = key.dateCap
        ? sql` AND ivp.date <= ${key.dateCap}::date`
        : sql``;
      branches.push(
        sql`(ivp."assetId" in (${sql.join(
          mainAssetIds.map((id) => sql`${id}`),
          sql`, `,
        )})${dateClause})`,
      );
    }
    for (const s of extraScopes) {
      branches.push(sql`ivp."assetId" = ${s.assetId}`);
    }
    return sql`AND (${sql.join(branches, sql` OR `)})`;
  })();
  // Right edge: `dateCap` (transferred-out wrapper freeze) or "today".
  const now = key.dateCap ?? formatISO(new Date(), { representation: "date" });
  // Snap right edge to a stable bucket boundary (Mon for WEEK, 1st of
  // month for MONTH, mod-`length` since epoch for DAY) so two queries
  // for the same `(unit, length)` with overlapping windows return
  // bucket boundaries that line up exactly.
  const anchor = formatISO(
    snapBucketStart(new Date(now), key.unit, key.length),
    { representation: "date" },
  );
  // Left edge: explicit `after`, or `anchor - max × length` units back
  // for the unbounded query. Snap the explicit `after` down too —
  // the leftmost bucket of the response should start on a stable
  // boundary, and `after` itself may not land on one.
  const leftEdge = key.after
    ? formatISO(snapBucketStart(new Date(key.after), key.unit, key.length), {
        representation: "date",
      })
    : null;
  // Range guard: if the resulting window exceeds the per-(unit, length)
  // limit, refuse to render. The client enforces matching limits in the
  // zoom UX; this fence is a server-side belt to make sure a malformed
  // query can't ask for unbounded scrollback.
  if (leftEdge) {
    const spanDays = Math.round(
      (new Date(now).getTime() - new Date(leftEdge).getTime()) / 86400000,
    );
    const limitDays = rangeLimitDays(key.unit, key.length);
    if (spanDays > limitDays) {
      throw new Error(
        `Portfolio.candlestick(${key.unit}, length: ${key.length}): requested range of ${spanDays} days exceeds limit of ${limitDays} days for this candle size`,
      );
    }
  }
  // Mid-bucket "today" → emit a trailing partial bucket of 1..length
  // units' width. To keep the total bucket count at `max` (when no
  // explicit `after`), we generate one fewer full bucket in that case.
  const hasPartial = anchor !== now;
  const fullBuckets = hasPartial ? key.max - 1 : key.max;
  // When `after` is set we ignore `max` — the range is determined by
  // (leftEdge, anchor). Generate boundaries from leftEdge to anchor
  // stepping by `length unit`.
  const seriesStart = leftEdge
    ? sql`${leftEdge}::date`
    : sql`${anchor}::date - interval '${sql.raw(String(key.length * fullBuckets))} ${unit}'`;

  const result = await db.execute<Row>(sql`
    WITH
      d AS (
        SELECT date, row_number() OVER (ORDER BY date DESC) AS rn
        FROM (
          SELECT generate_series(
            ${seriesStart},
            ${anchor}::date,
            '${step} ${unit}'::interval
          ) AS date
          ${hasPartial ? sql`UNION SELECT ${now}::date AS date` : sql``}
        ) x
      ),
      b AS (
        SELECT d1.date AS start, d0.date AS "end"
        FROM d d0
        INNER JOIN d d1 ON d1.rn = d0.rn + 1
      ),
      daily AS (
        SELECT ivp.date, SUM(ivp."value")::bigint AS total
        FROM "InvestmentValuePoints" ivp
        WHERE ivp.currency = ${currency}
          ${ivpScopeFilter}
        GROUP BY ivp.date
        -- Drop days where the only contribution is from sold-out wrappers'
        -- explicit value=0 rows. Without this filter, the bucket
        -- generate_series spanning a flat-zero stretch would produce
        -- buckets with from=to=lo=hi=0 — visually misleading and
        -- divergent from the prior (txn-based) query, which used
        -- INNER JOIN "InvestmentPrices" so price-less buckets dropped out.
        HAVING SUM(ivp."value") <> 0
      )
    SELECT
      b.start,
      b."end",
      MIN(daily.total)::int AS "valueMin",
      MAX(daily.total)::int AS "valueMax",
      (array_agg(daily.total ORDER BY daily.date ASC))[1]::int AS "valueStart",
      (array_agg(daily.total ORDER BY daily.date DESC))[1]::int AS "valueEnd"
    FROM b
    INNER JOIN daily ON daily.date BETWEEN b.start AND b."end"
    GROUP BY b.start, b."end"
    ORDER BY b.start
  `);

  if (!result.rows.length) return null;

  const points = result.rows.map((row) => ({
    start: new Date(row.start),
    end: new Date(row.end),
    valueStart: row.valueStart,
    valueEnd: row.valueEnd,
    valueMin: row.valueMin,
    valueMax: row.valueMax,
  }));

  // Live overlay on the rightmost bucket — only when no `dateCap` (the
  // wrapper isn't transferred-out) and `skipLive` is off (the resolver
  // wasn't `before:`-bounded).
  if (!key.skipLive && !key.dateCap) {
    const s = await loadInvestmentStats(ctx, {
      currency,
      assetIds:
        key.assetIds && key.assetIds.length > 0 ? key.assetIds : undefined,
      skipLive: false,
      ...(key.extraScopes && key.extraScopes.length > 0
        ? { extraScopes: key.extraScopes }
        : {}),
    });
    const liveTotal: number | null = s.totalValueMinor;
    if (liveTotal !== null) {
      const last = points[points.length - 1];
      last.valueEnd = liveTotal;
      last.valueMax = Math.max(last.valueMax, liveTotal);
      last.valueMin = Math.min(last.valueMin, liveTotal);
    }
  }

  const initialDate = points[0].start;
  const rightmostEnd = points[points.length - 1].end;
  const assetIdsForId = key.assetIds ?? [];
  return {
    currency,
    initialDate,
    points: points.map<PortfolioCandlestickPoint>((row) => ({
      id: encodeCandlePointId(
        assetIdsForId,
        key.unit,
        key.length,
        formatISO(row.start, { representation: "date" }),
      ),
      x0: differenceInDays(row.start, initialDate),
      x1: differenceInDays(row.end, initialDate),
      from: Math.round(
        Money.fromMinorDenomination(row.valueStart, currency).amount,
      ),
      to: Math.round(
        Money.fromMinorDenomination(row.valueEnd, currency).amount,
      ),
      lo: Math.round(
        Money.fromMinorDenomination(row.valueMin, currency).amount,
      ),
      hi: Math.round(
        Money.fromMinorDenomination(row.valueMax, currency).amount,
      ),
    })),
    // `startCursor` = leftmost bucket's start (the chart's "initial
    // date"). When the client wants to zoom out, it passes a date
    // earlier than this as `after:` and the server snaps that down to
    // the stable bucket boundary. `endCursor` = rightmost bucket's end
    // (typically today, or `dateCap` for a frozen wrapper). Pass an
    // earlier date as `before:` to pan the right edge back.
    startCursor: initialDate,
    endCursor: rightmostEnd,
  };
};

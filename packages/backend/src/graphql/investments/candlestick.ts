import DataLoader from "dataloader";
import { differenceInDays, formatISO } from "date-fns";
import { and, eq, gt, inArray, lt, or, sql } from "drizzle-orm";
import type { ID } from "grats";

import { HOME_CURRENCY } from "@/config";
import { db } from "@/db";
import { InvestmentValuePoints } from "@/db/schema/investments";

import { Context, contextAwareDataLoader } from "../context";
import { Money } from "../money";
import {
  PortfolioCandlestick,
  PortfolioCandlestickPoint,
  PortfolioCandleUnit,
} from "./portfolio";
import { loadInvestmentStats } from "./stats";

/** Cursor wire format for `Portfolio.candlestick.endCursor` / `before:`. The cursor is the bucket-start date the next page should end at; we base64-encode it so the client treats it as fully opaque (matching the `ID` GraphQL contract — pasting a date directly into `before:` is undefined behaviour). */
const CURSOR_PREFIX = "candle:";

/** Hard cap on cursor-paginated bucket count from "today" to the current page's leftmost bucket. When the user pinches out far enough that the next page would extend past this many buckets back, `hasMore` flips to `false` and the client stops backfilling. Bounds the worst-case round-trip + render cost on aggressive zoom-outs. */
const MAX_BUCKET_COUNT_ZOOMED = 3000;

function bucketsBetween(
  earlier: Date,
  later: Date,
  unit: PortfolioCandleUnit,
  length: number,
): number {
  if (unit === "DAY") {
    return Math.floor(
      (later.getTime() - earlier.getTime()) / 86400000 / length,
    );
  }
  if (unit === "WEEK") {
    return Math.floor(
      (later.getTime() - earlier.getTime()) / 86400000 / 7 / length,
    );
  }
  if (unit === "MONTH") {
    const months =
      (later.getUTCFullYear() - earlier.getUTCFullYear()) * 12 +
      (later.getUTCMonth() - earlier.getUTCMonth());
    return Math.floor(months / length);
  }
  throw new Error(`Unhandled candle unit: ${unit as string}`);
}

function encodeCandlestickCursor(bucketStart: string): ID {
  return Buffer.from(`${CURSOR_PREFIX}${bucketStart}`, "utf-8").toString(
    "base64url",
  ) as ID;
}

export function decodeCandlestickCursor(cursor: ID): string {
  const decoded = Buffer.from(cursor as string, "base64url").toString("utf-8");
  if (!decoded.startsWith(CURSOR_PREFIX)) {
    throw new Error(`Invalid candlestick cursor: ${String(cursor)}`);
  }
  const date = decoded.slice(CURSOR_PREFIX.length);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Invalid candlestick cursor (bad date): ${String(cursor)}`);
  }
  return date;
}

type CandlestickKey = {
  /** When set, filters the result to the combined portfolio across these net worth asset IDs. Undefined / empty = every asset. The full set is part of the cache key, so two requests with the same set coalesce to one SQL query; requests with different sets run independently. */
  assetIds?: string[];
  /** Each candle spans `length` of `unit`s; the series contains at most `max` candles. */
  unit: PortfolioCandleUnit;
  length: number;
  max: number;
  /** When `false`, the last bucket's `valueEnd` / `valueMax` / `valueMin` are overlaid with today's live-overlaid portfolio total (fetched from `loadInvestmentStats`). When `true`, the raw DB result is returned. Does not affect the SQL — only the overlay. */
  skipLive: boolean;
  /** ISO-`YYYY-MM-DD` cap, when set: the series ends on `dateCap` (instead of "today"), and the live overlay is skipped. Used to freeze the chart for a transferred-out wrapper. */
  dateCap?: string;
  /** Additional asset scopes to fold in, each with its own per-scope cap — used to render a transferred-into wrapper that inherits the source's pre-transfer holdings. Each entry adds an OR-branch over `InvestmentValuePoints` rows where `assetId = entry.assetId AND date <= entry.dateCap`. */
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
  return `${key.unit}|${key.length}|${key.max}|${assets}|${key.skipLive ? "1" : "0"}|${key.dateCap ?? ""}|${extra}`;
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
  // When `dateCap` is set, anchor `now` at the cap so the chart freezes on
  // the day before the transfer.
  const now = key.dateCap ?? formatISO(new Date(), { representation: "date" });
  // Snap the right edge to a stable bucket boundary (Monday for WEEK,
  // 1st-of-month for MONTH, mod-`length` since epoch for DAY) so two
  // requests for the same `(unit, length)` with different `before`
  // cursors produce buckets that line up exactly.
  const anchor = formatISO(
    snapBucketStart(new Date(now), key.unit, key.length),
    {
      representation: "date",
    },
  );
  // When `now` falls strictly inside a bucket (e.g. mid-week for 1W) we
  // emit a trailing partial bucket from `anchor` to `now` of width 1 to
  // `length` units. To keep the *total* bucket count at `max`, we
  // generate one fewer full bucket in that case — i.e. start the date
  // series at `anchor - (max-1) × length` instead of `anchor - max ×
  // length`. With no partial bucket (`now == anchor`, the request lands
  // exactly on a boundary or `before` was passed in), we generate the
  // full `max` boundaries.
  const hasPartial = anchor !== now;
  const fullBuckets = hasPartial ? key.max - 1 : key.max;
  const windowLen = sql.raw(String(key.length * fullBuckets));

  const result = await db.execute<Row>(sql`
    WITH
      d AS (
        SELECT date, row_number() OVER (ORDER BY date DESC) AS rn
        FROM (
          SELECT generate_series(
            ${anchor}::date - interval '${windowLen} ${unit}',
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

  // Drives `hasMore` — the client uses this to know when to stop
  // pagination on zoom-out. Two reasons we set `hasMore = false`:
  //
  // (a) The leftmost bucket sits more than `MAX_BUCKET_COUNT_ZOOMED`
  //     buckets back from "now". Caps the worst-case pagination depth
  //     so an aggressive pinch-out on 3D candles can't walk the
  //     client through the entire IVP history.
  // (b) No IVP row older than the leftmost bucket exists in the
  //     current asset scope — there's nothing left to paginate to.
  const leftmostStart = points[0].start;
  const bucketsBack = bucketsBetween(
    leftmostStart,
    new Date(now),
    key.unit,
    key.length,
  );
  let hasMore = bucketsBack < MAX_BUCKET_COUNT_ZOOMED;
  if (hasMore) {
    const olderRowExistsScope = (() => {
      const mainAssetIds = key.assetIds ?? [];
      const extraScopes = key.extraScopes ?? [];
      if (mainAssetIds.length === 0 && extraScopes.length === 0)
        return undefined;
      const branches = [
        ...(mainAssetIds.length > 0
          ? [inArray(InvestmentValuePoints.assetId, mainAssetIds)]
          : []),
        ...extraScopes.map((s) => eq(InvestmentValuePoints.assetId, s.assetId)),
      ];
      return branches.length === 1 ? branches[0] : or(...branches);
    })();
    const olderRows = await db
      .select({ one: sql`1` })
      .from(InvestmentValuePoints)
      .where(
        and(
          eq(InvestmentValuePoints.currency, currency),
          gt(InvestmentValuePoints.value, 0),
          lt(InvestmentValuePoints.date, leftmostStart),
          olderRowExistsScope,
        ),
      )
      .limit(1);
    hasMore = olderRows.length > 0;
  }

  // Overlay the last bucket with today's live portfolio total so the tail of
  // the chart tracks intraday movement. `valueEnd` jumps to the live total;
  // `valueMin` / `valueMax` expand only when live breaches the bucket's
  // historical range. `valueStart` is the bucket's first-date value and stays
  // untouched. With `dateCap`, the series is frozen pre-transfer — no live
  // overlay.
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
  return {
    currency,
    initialDate,
    points: points.map<PortfolioCandlestickPoint>((row) => ({
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
    // Cursor = leftmost bucket's start date. The client passes this back
    // as `Portfolio.candlestick(before:)` to load the next older page;
    // the server snaps anchors to a stable epoch (`snapBucketStart`) so
    // the next page's right edge adjoins this page's left edge with no
    // overlap or gap. `null` when there's nothing older to paginate to.
    endCursor: hasMore
      ? encodeCandlestickCursor(
          formatISO(leftmostStart, { representation: "date" }),
        )
      : null,
    hasMore,
  };
};

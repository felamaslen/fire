import assert from "node:assert";

import DataLoader from "dataloader";
import { differenceInDays, formatISO } from "date-fns";
import {
  and,
  eq,
  gt,
  gte,
  inArray,
  lte,
  min,
  type SQL,
  sql,
} from "drizzle-orm";

import { HOME_CURRENCY } from "@/config";
import { db } from "@/db";
import { InvestmentValuePoints } from "@/db/schema/investments";
import { UnreachableCaseError } from "@/errors";

import { contextAwareDataLoader } from "../context";
import { Money } from "../money";
import { PortfolioTimePeriod, PortfolioTimeseries } from "./portfolio";
import { loadInvestmentStats } from "./stats";

type TimeseriesKey = {
  /** When set, filters the result by the given portfolio (net worth asset ID) */
  assetId?: string;
  /** When set, filters the result by the given stock/fund (investment ID) */
  investmentId?: string;
  period: PortfolioTimePeriod;
  length: number;
  /** When `false`, the last point's `y` is overlaid with today's live-overlaid portfolio total (fetched from `loadInvestmentStats`). When `true`, the raw DB value is returned. Does not affect the SQL — only the overlay. */
  skipLive: boolean;
  /** ISO-`YYYY-MM-DD` cap, when set: the series ends on `dateCap` (instead of "today"), only `InvestmentValuePoints` rows with `date <= dateCap` contribute, and the live overlay is skipped. Used to freeze the chart for a transferred-out wrapper. */
  dateCap?: string;
  /** Additional asset scopes to fold in, each with its own per-scope cap — used to render a transferred-into wrapper that inherits the source's pre-transfer holdings. Each entry adds an OR-branch over `InvestmentValuePoints` rows where `assetId = entry.assetId AND date <= entry.dateCap`. The `priceLatest` overlay is unaffected (the destination is live). Empty / omitted = no extra scope. */
  extraScopes?: ReadonlyArray<{ assetId: string; dateCap: string }>;
};

const extraScopesFingerprint = (
  scopes: ReadonlyArray<{ assetId: string; dateCap: string }> | undefined,
): string =>
  scopes
    ? [...scopes]
        .sort((a, b) =>
          a.assetId === b.assetId
            ? a.dateCap.localeCompare(b.dateCap)
            : a.assetId.localeCompare(b.assetId),
        )
        .map((s) => `${s.assetId}@${s.dateCap}`)
        .join(",")
    : "";

const cacheKeyFn = (key: TimeseriesKey): string =>
  `${key.period}|${key.length}|${key.assetId ?? ""}|${key.investmentId ?? ""}|${key.skipLive ? "1" : "0"}|${key.dateCap ?? ""}|${extraScopesFingerprint(key.extraScopes)}`;

const MAX_POINTS = 300;

/** Build the `WHERE` for a `(assetId | investmentId, optional dateCap)` slice over `InvestmentValuePoints`. Combined with the batch-level `currency` filter and date-range bounds in the caller. The slice's `dateCap` is applied to `ivp.date` *only* for the main scope — extra scopes drop it (see the comment at the call site). */
function sliceCondition(slice: {
  assetId?: string;
  investmentId?: string;
  dateCap?: string | null;
}): SQL {
  const parts: SQL[] = [];
  if (slice.assetId !== undefined) {
    parts.push(eq(InvestmentValuePoints.assetId, slice.assetId));
  }
  if (slice.investmentId !== undefined) {
    parts.push(eq(InvestmentValuePoints.investmentId, slice.investmentId));
  }
  if (slice.dateCap) {
    parts.push(lte(InvestmentValuePoints.date, sql`${slice.dateCap}::date`));
  }
  return parts.length === 0 ? sql`true` : (and(...parts) as SQL);
}

/**
 * Retrieves a time-series of total value, optionally filtering by portfolio (net worth asset ID) and/or stock (investment ID).
 *
 * Reads pre-aggregated daily totals from `InvestmentValuePoints` (maintained by triggers — see `InvestmentValuePoints_refresh_fn` and friends in `db/schema/investments.ts`). Each batched key contributes a UNION ALL branch covering its main scope plus any `extraScopes` (transferred-in source wrappers, capped at the day before the transfer); the resolver then sums per-day per-key into the requested series.
 */
export const loadTimeseries = contextAwareDataLoader(
  (ctx) =>
    new DataLoader<TimeseriesKey, PortfolioTimeseries | null, string>(
      async (keys) => {
        // Forbid batch-loading with differing periods or `dateCap` — the
        // sample-stride and right-edge anchor must match across the batch
        // for a consistent X axis. `extraScopes` may differ per key.
        assert(
          keys.every(
            (k, _i, array) =>
              k.period === array[0].period &&
              k.length === array[0].length &&
              (k.dateCap ?? null) === (array[0].dateCap ?? null),
          ),
          "Cannot batch-load timeseries with different periods or dateCaps",
        );

        // Only stocks traded in (and portfolios valued in) HOME_CURRENCY
        // are supported.
        const currency = HOME_CURRENCY;
        const now =
          keys[0].dateCap ?? formatISO(new Date(), { representation: "date" });

        // Earliest in-scope IVP date with a non-zero value across the
        // whole batch — anchors the X-axis for `period: "ALL"` and clamps
        // the lower bound for finite periods. Filtering on `value > 0`
        // here skips leading days where the only contribution is from a
        // sold-out wrapper's explicit value=0 rows (those are meaningful
        // mid-chart, where a held position dropped to zero, but as
        // leading rows they just push the chart's `initialDate` back into
        // an empty period).
        const allKeyAssetIds = (() => {
          if (!keys.every((k) => k.assetId !== undefined)) return null;
          const set = new Set<string>();
          for (const k of keys) {
            set.add(k.assetId as string);
            for (const s of k.extraScopes ?? []) set.add(s.assetId);
          }
          return [...set];
        })();
        const allKeyInvestmentIds = keys.every(
          (k) => k.investmentId !== undefined,
        )
          ? [...new Set(keys.map((k) => k.investmentId as string))]
          : null;
        const firstDateRows = await db
          .select({ minDate: min(InvestmentValuePoints.date) })
          .from(InvestmentValuePoints)
          .where(
            and(
              eq(InvestmentValuePoints.currency, currency),
              gt(InvestmentValuePoints.value, 0),
              allKeyAssetIds
                ? inArray(InvestmentValuePoints.assetId, allKeyAssetIds)
                : undefined,
              allKeyInvestmentIds
                ? inArray(
                    InvestmentValuePoints.investmentId,
                    allKeyInvestmentIds,
                  )
                : undefined,
            ),
          );
        const firstDateStr = firstDateRows[0]?.minDate;
        if (!firstDateStr) {
          // No matching IVP rows — every key gets `null`. Common when a
          // wrapper is filtered down to investments that never traded in it.
          return keys.map(() => null);
        }

        const startDate: SQL<string> = (() => {
          switch (keys[0].period) {
            case "ALL":
              return sql<string>`${firstDateStr}::date`;
            case "YEAR":
              return sql<string>`greatest((${now}::timestamptz - interval '${sql.raw(keys[0].length.toString())} year')::date, ${firstDateStr}::date)`;
            case "MONTH":
              return sql<string>`greatest((${now}::timestamptz - interval '${sql.raw(keys[0].length.toString())} month')::date, ${firstDateStr}::date)`;
            case "YTD":
              return sql<string>`greatest(date_trunc('year', ${now}::timestamptz)::date, ${firstDateStr}::date)`;
            default:
              throw new UnreachableCaseError(keys[0].period);
          }
        })();

        // Per-key SQL aggregation: sum `value` per (date, key index)
        // across the key's main scope plus any extras. Encoding the key
        // index as a literal in each branch lets one query serve every
        // key in the batch.
        //
        // Extra scopes drop their per-scope `dateCap` against `ivp.date`
        // (note the absence of `dateCap` in the extra-scope slice
        // below). The cap was meant by the original (txn-based) query
        // to limit which TXNs accumulate into units for the source
        // wrapper; once accumulated, the source's contribution at any
        // chart day is `units × price-at-day`. In IVP, units remain
        // constant after the source's last txn, so reading IVP for the
        // source across all dates gives the same answer — provided the
        // source has no post-`dateCap` txns. That invariant is enforced
        // upstream: `effectiveAssetFilter` only emits extras for
        // `InvestmentTransfers` source wrappers, which by codebase
        // convention are not booked against after the transfer.
        const branches: SQL[] = [];
        keys.forEach((key, keyIndex) => {
          const slices: {
            assetId?: string;
            investmentId?: string;
            dateCap?: string | null;
          }[] = [
            {
              ...(key.assetId !== undefined ? { assetId: key.assetId } : {}),
              ...(key.investmentId !== undefined
                ? { investmentId: key.investmentId }
                : {}),
              ...(key.dateCap !== undefined ? { dateCap: key.dateCap } : {}),
            },
            ...(key.extraScopes ?? []).map((s) => ({
              assetId: s.assetId,
              ...(key.investmentId !== undefined
                ? { investmentId: key.investmentId }
                : {}),
            })),
          ];
          for (const slice of slices) {
            branches.push(sql`
              SELECT ${sql.raw(keyIndex.toString())}::int AS "keyIndex",
                     ${InvestmentValuePoints.date} AS "date",
                     ${InvestmentValuePoints.value} AS "value"
              FROM ${InvestmentValuePoints}
              WHERE ${eq(InvestmentValuePoints.currency, currency)}
                AND ${gte(InvestmentValuePoints.date, startDate)}
                AND ${lte(InvestmentValuePoints.date, sql`${now}::date`)}
                AND ${sliceCondition(slice)}
            `);
          }
        });
        const unionAll = sql.join(branches, sql` UNION ALL `);

        type Row = { keyIndex: number; date: string; y: string };
        const rows = await db.execute<Row>(sql`
          WITH branches AS (${unionAll})
          SELECT
            "keyIndex",
            "date"::text AS "date",
            SUM("value")::bigint AS "y"
          FROM branches
          GROUP BY "keyIndex", "date"
          ORDER BY "keyIndex", "date"
        `);

        // Build per-key (date → y) maps for cheap downsampling lookup.
        const seriesByKey = new Map<number, Map<string, number>>();
        const allDates = new Set<string>();
        for (const r of rows.rows ?? rows) {
          let m = seriesByKey.get(r.keyIndex);
          if (!m) {
            m = new Map();
            seriesByKey.set(r.keyIndex, m);
          }
          m.set(r.date, Number(r.y));
          allDates.add(r.date);
        }

        // Sample-stride downsampling: pick at most MAX_POINTS dates spaced
        // evenly between `startDate` and `now`, always including both
        // endpoints. We compute the sample dates from a generate_series-
        // shaped client-side stride over `allDates` (sorted).
        const sortedDates = [...allDates].sort();
        if (sortedDates.length === 0) return keys.map(() => null);
        // Force the right edge to `now` even if no IVP row exists for that
        // exact date (e.g. weekends with no price tick) — the live overlay
        // below substitutes the latest known value.
        const todayStr = now;
        if (sortedDates[sortedDates.length - 1] !== todayStr) {
          sortedDates.push(todayStr);
        }
        const stride = Math.max(1, Math.ceil(sortedDates.length / MAX_POINTS));
        const sampledDates: string[] = [];
        for (let i = 0; i < sortedDates.length; i += stride) {
          sampledDates.push(sortedDates[i]);
        }
        // Always include the right edge.
        if (sampledDates[sampledDates.length - 1] !== todayStr) {
          sampledDates.push(todayStr);
        }

        // Live-overlay: per-key totalValueMinor for non-skipLive non-capped
        // keys. Substituted into the last sampled point.
        const liveByKeyIndex = await Promise.all(
          keys.map((key) =>
            key.skipLive || key.dateCap
              ? Promise.resolve(null)
              : loadInvestmentStats(ctx, {
                  currency,
                  assetIds: key.assetId ? [key.assetId] : undefined,
                  investmentId: key.investmentId,
                  skipLive: false,
                  ...(key.extraScopes && key.extraScopes.length > 0
                    ? { extraScopes: key.extraScopes }
                    : {}),
                }).then((s) => s.totalValueMinor),
          ),
        );

        const initialDate = new Date(sampledDates[0]);

        return keys.map<PortfolioTimeseries | null>((key, keyIndex) => {
          const series = seriesByKey.get(keyIndex);
          if (!series || series.size === 0) {
            // No IVP rows matched this key. Return a flat-zero series so
            // `Query.portfolios` can emit a stacked edge per investment
            // without erroring on dormant ones.
            return {
              currency,
              initialDate,
              points: sampledDates.map((d) => ({
                x: differenceInDays(new Date(d), initialDate),
                y: 0,
              })),
            };
          }
          // Forward-fill: when a sample date has no IVP row (e.g. weekend),
          // carry the last known value forward.
          let lastKnown = 0;
          const ys = sampledDates.map((d) => {
            const v = series.get(d);
            if (v !== undefined) lastKnown = v;
            return lastKnown;
          });
          // Live overlay on the last point.
          const liveTotal = liveByKeyIndex[keyIndex];
          if (liveTotal !== null) {
            ys[ys.length - 1] = liveTotal;
          }
          return {
            currency,
            initialDate,
            points: sampledDates.map((d, i) => ({
              x: differenceInDays(new Date(d), initialDate),
              y: Math.round(
                Money.fromMinorDenomination(ys[i], currency).amount,
              ),
            })),
          };
        });
      },
      { cacheKeyFn },
    ),
);

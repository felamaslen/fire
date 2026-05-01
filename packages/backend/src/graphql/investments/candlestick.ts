import DataLoader from "dataloader";
import { differenceInDays, formatISO } from "date-fns";
import { sql } from "drizzle-orm";

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

type CandlestickKey = {
  /** When set, filters the result to the combined portfolio across these net worth asset IDs. Undefined / empty = every asset. The full set is part of the cache key, so two requests with the same set coalesce to one SQL query; requests with different sets run independently. */
  assetIds?: string[];
  /** Each candle spans `length` of `unit`s; the series contains at most `max` candles. */
  unit: PortfolioCandleUnit;
  length: number;
  max: number;
  /** When `false`, the last bucket's `valueEnd` / `valueMax` / `valueMin` are overlaid with today's live-overlaid portfolio total (fetched from `loadInvestmentStats`). When `true`, the raw DB result is returned. Does not affect the SQL — only the overlay. */
  skipLive: boolean;
  /** ISO-`YYYY-MM-DD` cap, when set: the series ends on `dateCap` (instead of "today"), only `InvestmentTransactions` with `date <= dateCap` contribute, and the live overlay is skipped. Used to freeze the chart for a transferred-out wrapper. */
  dateCap?: string;
  /** Additional asset scopes to fold in, each with its own per-scope cap — used to render a transferred-into wrapper that inherits the source's pre-transfer holdings. */
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
 * Per-date portfolio totals are computed *before* min/max, so `lo` / `hi` reflect the true drawdown / peak of the held position across the bucket — not the sum of per-stock extremes on possibly different days.
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

const loadOne = async (
  ctx: Context,
  key: CandlestickKey,
): Promise<PortfolioCandlestick | null> => {
  const currency = HOME_CURRENCY;
  const unit = sql.raw(key.unit.toLowerCase());
  const windowLen = sql.raw(String(key.length * key.max));
  const step = sql.raw(String(key.length));
  // OR-combined asset+date scope: (mainAssetIds capped by `dateCap`) OR
  // each extraScope. When neither is set this collapses to "no filter".
  const txScopeFilter = (() => {
    const mainAssetIds = key.assetIds ?? [];
    const extraScopes = key.extraScopes ?? [];
    if (mainAssetIds.length === 0 && extraScopes.length === 0) {
      return key.dateCap ? sql`and t.date <= ${key.dateCap}::date` : sql``;
    }
    const branches: ReturnType<typeof sql>[] = [];
    if (mainAssetIds.length > 0) {
      const dateClause = key.dateCap
        ? sql` AND t.date <= ${key.dateCap}::date`
        : sql``;
      branches.push(
        sql`(t."assetId" in (${sql.join(
          mainAssetIds.map((id) => sql`${id}`),
          sql`, `,
        )})${dateClause})`,
      );
    }
    for (const s of extraScopes) {
      branches.push(
        sql`(t."assetId" = ${s.assetId} AND t.date <= ${s.dateCap}::date)`,
      );
    }
    return sql`and (${sql.join(branches, sql` OR `)})`;
  })();
  // When `dateCap` is set, anchor `now` (the rightmost edge of the series)
  // at the cap so the chart freezes on the day before the transfer.
  const now = key.dateCap ?? formatISO(new Date(), { representation: "date" });

  // `u_tx` / `u` are MATERIALIZED so (a) the stock-split scalar subquery runs
  // once per transaction (~hundreds) rather than once per (bucket × price) pair
  // (~tens of thousands), and (b) the cumulative units window runs once per
  // investment instead of being inlined into every lateral probe.
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`set local jit = off;`);
    return await tx.execute<Row>(sql`
      with
        d as (
          select date, row_number() over (order by date desc) as rn
          from (
            select generate_series(
              ${now}::date - interval '${windowLen} ${unit}',
              ${now}::date,
              '${step} ${unit}'::interval
            ) as date
          ) x
        ),
        b as (
          select d1.date as start, d0.date as "end"
          from d d0
          inner join d d1 on d1.rn = d0.rn + 1
        ),
        u_tx as materialized (
          select
            t."investmentId",
            t.date,
            (t.units * coalesce(exp(
              (select sum(ln(ss.ratio)) from "InvestmentStockSplits" ss
               where ss."investmentId" = t."investmentId" and ss.date > t.date)
            ), 1))::double precision as "unitsAdjusted"
          from "InvestmentTransactions" t
          where t.currency = ${currency}
          ${txScopeFilter}
        ),
        u as materialized (
          select
            "investmentId",
            date,
            sum("unitsAdjusted") over (
              partition by "investmentId"
              order by date
              rows between unbounded preceding and current row
            ) as units_cum
          from u_tx
        ),
        v as (
          select b.start, b."end", pb.date,
            sum(pb."priceAdjusted" * u_latest.units_cum)::bigint as value
          from b
          inner join "InvestmentPrices" pb
            on pb.date between b.start and b."end"
          inner join lateral (
            select units_cum from u
            where u."investmentId" = pb."investmentId" and u.date <= pb.date
            order by u.date desc limit 1
          ) u_latest on true
          group by b.start, b."end", pb.date
        )
      select
        start,
        "end",
        min(value)::int as "valueMin",
        max(value)::int as "valueMax",
        (array_agg(value order by date asc))[1]::int as "valueStart",
        (array_agg(value order by date desc))[1]::int as "valueEnd"
      from v
      group by start, "end"
      order by start
    `);
  });

  if (!result.rows.length) return null;

  const points = result.rows.map((row) => ({
    start: new Date(row.start),
    end: new Date(row.end),
    valueStart: row.valueStart,
    valueEnd: row.valueEnd,
    valueMin: row.valueMin,
    valueMax: row.valueMax,
  }));

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
      // Fold any inbound-transfer sources into the live overlay too —
      // otherwise the last candle's `valueEnd` collapses to "main asset
      // only", producing a spurious red candle when the rest of the
      // series included folded source holdings.
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
  };
};

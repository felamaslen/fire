import { strict as assert } from "node:assert";

import DataLoader from "dataloader";
import { formatISO } from "date-fns";
import { and, eq, inArray, type SQL, sql } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import type { Int } from "grats";

import { CURRENCIES } from "@/config";
import { db } from "@/db";
import { Investments, InvestmentTransactions } from "@/db/schema/investments";

import { contextAwareDataLoader } from "../context";
import type { Date as CalendarDate } from "../date";
import { Money } from "../money";
import { daysSinceEpoch, periodStartDate } from "./period-start";
import type {
  PortfolioTimePeriod,
  PortfolioTimeseriesPoint,
} from "./portfolio";

/** Step-line view of cumulative invested capital for the portfolio scope, split into out-of-pocket contributions and dividend reinvestments (DRIPs). Both series are evaluated at end-of-day for each date the running total changes; render as a step-before line drawing horizontally to the next point and then jumping vertically. The values are raw `units × price` from the booked transactions (buys add, sells subtract); stock splits are intentionally not folded in — the line tracks the cash actually transacted, not the present-day equivalent. @gqlType */
export type PortfolioContributions = {
  /** ISO-4217 code the values are expressed in. @gqlField */
  currency: string;
  /** Calendar anchor for the series — `x = 0` corresponds to this date. Mirrors the period/length-clamped left edge of the matching `Portfolio.timeseries` so the two series can be plotted on the same X axis. @gqlField */
  initialDate: CalendarDate;
  /** Cumulative `units × price` over non-DRIP transactions in scope. Always begins with an `x = 0` anchor whose `y` carries any pre-window total, followed by one entry per in-window date that moved the running total. @gqlField */
  contributions: PortfolioTimeseriesPoint[];
  /** Same as `contributions` but with DRIP buys layered on top of the non-DRIP running total. By construction sits at-or-above `contributions`; the gap reads as "value of dividends reinvested". @gqlField */
  withDrips: PortfolioTimeseriesPoint[];
};

export type PortfolioContributionsKey = {
  currency: string;
  filterAssetIdIn: string[] | null;
  filterInvestmentIdIn: string[] | null;
  extras: ReadonlyArray<{ assetId: string; dateCap: string }>;
  /** Right-edge cap (chart-flavoured: transfer or sold-out). When set, transactions after this date are excluded. */
  dateCap: string | null;
  period: PortfolioTimePeriod;
  length: number;
};

const extrasFingerprint = (
  scopes: ReadonlyArray<{ assetId: string; dateCap: string }>,
): string =>
  [...scopes]
    .sort((a, b) =>
      a.assetId === b.assetId
        ? a.dateCap.localeCompare(b.dateCap)
        : a.assetId.localeCompare(b.assetId),
    )
    .map((s) => `${s.assetId}@${s.dateCap}`)
    .join(",");

const cacheKeyFn = (k: PortfolioContributionsKey): string => {
  const assets = k.filterAssetIdIn
    ? [...k.filterAssetIdIn].sort().join(",")
    : "";
  const investments = k.filterInvestmentIdIn
    ? [...k.filterInvestmentIdIn].sort().join(",")
    : "";
  return `${k.currency}|${k.period}|${k.length}|${k.dateCap ?? ""}|${assets}|${investments}|${extrasFingerprint(k.extras)}`;
};

/**
 * Per-request batched loader for `Portfolio.contributions`. Each `Portfolio`
 * resolver fans into one `loader.load(key)` call; sibling calls within the
 * same tick (e.g. several per-investment `Portfolio` instances on a stacked
 * page) coalesce into a single SQL roundtrip — one tagged `UNION ALL` branch
 * per key over `InvestmentTransactions`, aggregated by `(keyIndex, date)`.
 *
 * Negative-units DRIP rows are forbidden by `InvestmentTransactions_drip_units_ck`,
 * so the DRIP delta is always non-negative — the "+ DRIPs" line is always at-
 * or-above the contributions line by construction.
 */
export const loadPortfolioContributions = contextAwareDataLoader(
  () =>
    new DataLoader<
      PortfolioContributionsKey,
      PortfolioContributions | null,
      string
    >(
      async (keys) => {
        const validKeys = keys.map((k) => k.currency in CURRENCIES);
        const now = formatISO(new Date(), { representation: "date" });

        const branchSelects = keys.flatMap((key, keyIndex) => {
          if (!validKeys[keyIndex]) return [];
          const condition = buildKeyCondition(key, now);
          return [
            db
              .select({
                keyIndex: sql<number>`${sql.raw(keyIndex.toString())}::int`.as(
                  "keyIndex",
                ),
                date: InvestmentTransactions.date,
                units: InvestmentTransactions.units,
                price: InvestmentTransactions.price,
                drip: InvestmentTransactions.drip,
              })
              .from(InvestmentTransactions)
              .innerJoin(
                Investments,
                eq(Investments.id, InvestmentTransactions.investmentId),
              )
              .where(condition),
          ];
        });

        const rowsByKey = new Map<
          number,
          Array<{ date: string; contribDelta: number; dripDelta: number }>
        >();

        if (branchSelects.length > 0) {
          const [first, second, ...rest] = branchSelects;
          assert(first, "expected at least one contributions branch");
          const branches = db
            .$with("branches")
            .as(
              second === undefined ? first : unionAll(first, second, ...rest),
            );
          const rows = await db
            .with(branches)
            .select({
              keyIndex: branches.keyIndex,
              date: sql<string>`${branches.date}::text`.as("date"),
              contribDelta:
                sql<number>`COALESCE(SUM(${branches.units} * ${branches.price}) FILTER (WHERE NOT ${branches.drip}), 0)::double precision`.as(
                  "contribDelta",
                ),
              dripDelta:
                sql<number>`COALESCE(SUM(${branches.units} * ${branches.price}) FILTER (WHERE ${branches.drip}), 0)::double precision`.as(
                  "dripDelta",
                ),
            })
            .from(branches)
            .groupBy(branches.keyIndex, branches.date)
            .orderBy(branches.keyIndex, branches.date);
          for (const r of rows) {
            const list = rowsByKey.get(r.keyIndex) ?? [];
            list.push({
              date: r.date,
              contribDelta: Number(r.contribDelta),
              dripDelta: Number(r.dripDelta),
            });
            rowsByKey.set(r.keyIndex, list);
          }
        }

        return keys.map((key, keyIndex) => {
          if (!validKeys[keyIndex]) return null;
          const rows = rowsByKey.get(keyIndex);
          if (!rows || rows.length === 0) return null;
          return assemble(key, rows, now);
        });
      },
      { cacheKeyFn },
    ),
);

/** Build the `WHERE` for one key's branch over `InvestmentTransactions`: currency + date upper bound + asset/investment scope + extras (each capped at its own date). */
function buildKeyCondition(
  key: PortfolioContributionsKey,
  now: string,
): SQL | undefined {
  const cur = key.currency as keyof typeof CURRENCIES;
  const upperBound = key.dateCap ?? now;
  const conditions: (SQL | undefined)[] = [
    eq(Investments.currency, cur),
    eq(InvestmentTransactions.currency, cur),
    sql`${InvestmentTransactions.date} <= ${upperBound}::date`,
  ];
  if (key.filterInvestmentIdIn && key.filterInvestmentIdIn.length > 0) {
    conditions.push(
      inArray(InvestmentTransactions.investmentId, key.filterInvestmentIdIn),
    );
  }
  // Asset+date scope predicate. Mirrors the OR-of-branches shape used by
  // `loadInvestmentStats`: main scope (capped at `dateCap`) OR each extra
  // (its own `assetId` capped at its own `dateCap`).
  if (key.filterAssetIdIn || key.extras.length > 0) {
    if (key.extras.length === 0) {
      if (key.filterAssetIdIn && key.filterAssetIdIn.length > 0) {
        conditions.push(
          inArray(InvestmentTransactions.assetId, key.filterAssetIdIn),
        );
      }
    } else {
      const branches: SQL[] = [];
      if (key.filterAssetIdIn && key.filterAssetIdIn.length > 0) {
        const dateClause = key.dateCap
          ? sql` AND ${InvestmentTransactions.date} <= ${key.dateCap}::date`
          : sql``;
        branches.push(
          sql`(${inArray(InvestmentTransactions.assetId, key.filterAssetIdIn)}${dateClause})`,
        );
      }
      for (const s of key.extras) {
        branches.push(
          sql`(${InvestmentTransactions.assetId} = ${s.assetId} AND ${InvestmentTransactions.date} <= ${s.dateCap}::date)`,
        );
      }
      conditions.push(sql`(${sql.join(branches, sql` OR `)})`);
    }
  }
  return and(...conditions);
}

/** Walk the per-date deltas returned by the batch SQL, fold pre-window rows into the carryover anchor, and emit one step point per in-window date that moved either running total. */
function assemble(
  key: PortfolioContributionsKey,
  rows: Array<{ date: string; contribDelta: number; dripDelta: number }>,
  now: string,
): PortfolioContributions {
  const firstTxDate = rows[0].date;
  const startDate = periodStartDate(
    key.dateCap ?? now,
    firstTxDate,
    key.period,
    key.length,
  );
  const startDays = daysSinceEpoch(startDate);
  const dayOffset = (s: string) => daysSinceEpoch(s) - startDays;
  const toMajor = (minor: number): Int =>
    Math.round(Money.fromMinorDenomination(minor, key.currency).amount) as Int;

  let contribTotal = 0;
  let dripTotal = 0;
  let contribCarry = 0;
  let dripCarry = 0;
  const contribs: PortfolioTimeseriesPoint[] = [];
  const withDrips: PortfolioTimeseriesPoint[] = [];
  for (const r of rows) {
    if (r.date < startDate) {
      contribCarry += r.contribDelta;
      dripCarry += r.dripDelta;
      continue;
    }
    contribTotal += r.contribDelta;
    dripTotal += r.dripDelta;
    const x = dayOffset(r.date) as Int;
    if (r.contribDelta !== 0) {
      contribs.push({ x, y: toMajor(contribCarry + contribTotal) });
    }
    if (r.contribDelta + r.dripDelta !== 0) {
      withDrips.push({
        x,
        y: toMajor(contribCarry + dripCarry + contribTotal + dripTotal),
      });
    }
  }

  // Prepend an `x = 0` anchor only when the first emitted change is past the
  // chart's left edge. If the very first transaction lands on `startDate` it
  // already produced an `x = 0` change point — adding another anchor here
  // would draw a phantom step from `(0, carryover)` to `(0, carryover +
  // delta)`.
  if (contribs.length === 0 || contribs[0].x !== 0) {
    contribs.unshift({ x: 0 as Int, y: toMajor(contribCarry) });
  }
  if (withDrips.length === 0 || withDrips[0].x !== 0) {
    withDrips.unshift({
      x: 0 as Int,
      y: toMajor(contribCarry + dripCarry),
    });
  }

  return {
    currency: key.currency,
    initialDate: new Date(`${startDate}T00:00:00Z`),
    contributions: contribs,
    withDrips,
  };
}

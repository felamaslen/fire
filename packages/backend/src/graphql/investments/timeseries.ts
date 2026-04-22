import assert from "node:assert";

import DataLoader from "dataloader";
import { differenceInDays } from "date-fns";
import { and, asc, desc, eq, inArray, lte, min, sql, sum } from "drizzle-orm";
import type { PgColumn, PgSelectBase } from "drizzle-orm/pg-core";

import { HOME_CURRENCY } from "@/config";
import { db } from "@/db";
import {
  InvestmentPrices,
  Investments,
  InvestmentStockSplits,
  InvestmentTransactions,
} from "@/db/schema/investments";
import { UnreachableCaseError } from "@/errors";

import { Context, contextAwareDataLoader } from "../context";
import { Money } from "../money";
import { PortfolioTimePeriod, PortfolioTimeseries } from "./portfolio";
import { loadInvestmentStats } from "./stats";

export interface LoadInvestmentsByKeyFilter {
  /** When set, filters the result by the given portfolio (net worth asset ID) */
  assetId?: string;
  /** When set, filters the result by the given stock/fund (investment ID) */
  investmentId?: string;
}

type TimeseriesKey = LoadInvestmentsByKeyFilter & {
  period: PortfolioTimePeriod;
  length: number;
  /** When `false`, the last point's `y` is overlaid with today's live-overlaid portfolio total (fetched from `loadInvestmentStats`). When `true`, the raw DB value is returned. Does not affect the SQL — only the overlay. */
  skipLive: boolean;
};

const cacheKeyFn = (key: TimeseriesKey): string =>
  `${key.period}|${key.length}|${key.assetId ?? ""}|${key.investmentId ?? ""}|${key.skipLive ? "1" : "0"}`;

const MAX_POINTS = 300;

export const loadInvestmentsByKeyConditions = (
  keys: readonly LoadInvestmentsByKeyFilter[],
) => {
  // Filter conditions on the entire query: when providing assetId or investmentId filters, do not return any rows which we won't ever need to construct the result set for each key
  const whereAssetId = keys.every((k) => k.assetId !== undefined)
    ? inArray(
        InvestmentTransactions.assetId,
        keys.map((k) => k.assetId!),
      )
    : undefined;
  const whereInvestmentId = (
    tbl: typeof InvestmentPrices | typeof InvestmentTransactions,
  ) =>
    keys.every((k) => k.investmentId !== undefined)
      ? inArray(
          tbl.investmentId,
          keys.map((k) => k.investmentId!),
        )
      : undefined;

  return { whereAssetId, whereInvestmentId };
};

/**
 * Retrieves unit-delta chain for each investment in the given set (or all, if no filters given). This can be used to compute historical holding values.
 */
const loadAdjustedUnits = contextAwareDataLoader(
  async (_ctx: Context, keys: readonly LoadInvestmentsByKeyFilter[]) => {
    const { whereAssetId, whereInvestmentId } =
      loadInvestmentsByKeyConditions(keys);
    // Only stocks traded in (and portfolios valued in) HOME_CURRENCY are supported
    const currency = HOME_CURRENCY;

    return await db
      .select({
        date: InvestmentTransactions.date,
        investmentId: InvestmentTransactions.investmentId,
        assetId: InvestmentTransactions.assetId,
        units: sql<number>`(${InvestmentTransactions.units} * coalesce(exp(ln(
              (${db
                .select({ ratio: sum(InvestmentStockSplits.ratio) })
                .from(InvestmentStockSplits)
                .where(
                  and(
                    eq(
                      InvestmentStockSplits.investmentId,
                      InvestmentTransactions.investmentId,
                    ),
                    sql`${InvestmentStockSplits.date} > ${InvestmentTransactions.date}`,
                  ),
                )})
            )), 1))::int`.as("unitsAdjusted"),
      })
      .from(InvestmentTransactions)
      .where(
        and(
          eq(InvestmentTransactions.currency, currency),
          whereAssetId,
          whereInvestmentId(InvestmentTransactions),
        ),
      )
      .orderBy(asc(InvestmentTransactions.date));
  },
);

/**
 * Retrieves a time-series of total value, optionally filtering by portfolio (net worth asset ID) and/or stock (investment ID).
 * Takes stock splits into account to compute historical values, according to the units acquired as defined by the list of transactions.
 */
export const loadTimeseries = contextAwareDataLoader(
  (ctx) =>
    new DataLoader<TimeseriesKey, PortfolioTimeseries, string>(
      async (keys) => {
        const { whereAssetId, whereInvestmentId } =
          loadInvestmentsByKeyConditions(keys);

        // If batching requests with multiple different filter criteria, we explicitly fetch a date range covering the entire set. For example, if the batched request covers two separate targeted stocks, both of which were bought and sold at different periods of time, we fetch a dataset starting from the date of the first buy.
        //
        // This way, a batched set of timeseries fields will always have a consistent X axis and can be overlaid on one another.
        //
        // If separate X axes are required, then requests should be made in separate microtasks, to avoid batching.

        // Explicitly forbid batch-loading time series with differing periods:
        assert(
          keys.every(
            (k, _i, array) =>
              k.period === array[0].period && k.length === array[0].length,
          ),
          "Cannot batch-load timeseries with different periods",
        );

        // Only stocks traded in (and portfolios valued in) HOME_CURRENCY are supported
        const currency = HOME_CURRENCY;

        // Earliest transaction in the filter scope — anchors the series at
        // the first-cached-price boundary for all periods. For `ALL`, this is
        // the series start. For `YEAR` / `MONTH` / `YTD`, we clamp the period
        // window to this so we never generate sample dates before any data
        // exists (they'd produce empty rows via the inner join and surface as
        // a series that starts later than the caller's `initialDate`).
        const firstTxDate = db
          .select({ minDate: min(InvestmentTransactions.date) })
          .from(InvestmentTransactions)
          .where(
            and(
              eq(InvestmentTransactions.currency, currency),
              whereAssetId,
              whereInvestmentId(InvestmentTransactions),
            ),
          );
        const startDate = (() => {
          switch (keys[0].period) {
            case "ALL":
              return firstTxDate;
            case "YEAR":
              return sql`select greatest((now() - interval '${sql.raw(keys[0].length.toString())} year')::date, (${firstTxDate}))`;
            case "MONTH":
              return sql`select greatest((now() - interval '${sql.raw(keys[0].length.toString())} month')::date, (${firstTxDate}))`;
            case "YTD":
              return sql`select greatest(date_trunc('year', now())::date, (${firstTxDate}))`;
            default:
              throw new UnreachableCaseError(keys[0].period);
          }
        })();

        // See https://github.com/drizzle-team/drizzle-orm/pull/1405
        // Select without from not supported by drizzle
        const dates = db.$with("d").as(
          sql`
          select distinct date from (
            select generate_series(
              (${startDate}),
              now(),
              (ceil((now()::date - (${startDate}) + 1) / ${MAX_POINTS}::float) || ' day')::interval
            ) as date
            union select now()::date as date
          ) d
          order by 1
        ` as any as PgSelectBase<
            "dates",
            {
              date: PgColumn<
                {
                  name: "date";
                  columnType: "date";
                  data: "pgDate";
                  dataType: "date";
                  driverParam: any;
                  enumValues: never;
                  hasDefault: false;
                  hasRuntimeDefault: false;
                  isAutoincrement: false;
                  isPrimaryKey: false;
                  notNull: false;
                  tableName: "dates";
                },
                any,
                any
              >;
            },
            any,
            any,
            any,
            any,
            { date: Date }[],
            {
              date: PgColumn<
                {
                  name: "date";
                  columnType: "date";
                  data: "pgDate";
                  dataType: "date";
                  driverParam: any;
                  enumValues: never;
                  hasDefault: false;
                  hasRuntimeDefault: false;
                  isAutoincrement: false;
                  isPrimaryKey: false;
                  notNull: false;
                  tableName: "dates";
                },
                any,
                any
              >;
            }
          >,
        );

        // Latest close price at-or-before `d.date` for each (d, investment)
        // pair, via a LATERAL subquery. Rewritten from the previous
        // `pb.id = (select id ... limit 1)` pattern that double-scanned
        // `InvestmentPrices` (once as a subplan to get the id, once as the
        // outer join target) — the lateral hits the `(investmentId, date)`
        // index exactly once per pair.
        const latestPrice = db
          .select({
            priceAdjusted: InvestmentPrices.priceAdjusted,
          })
          .from(InvestmentPrices)
          .where(
            and(
              eq(InvestmentPrices.investmentId, Investments.id),
              lte(InvestmentPrices.date, sql`d.date`),
              whereInvestmentId(InvestmentPrices),
            ),
          )
          .orderBy(desc(InvestmentPrices.date))
          .limit(1)
          .as("pb");

        const pricesAdjQuery = db
          .with(dates)
          .select({
            date: sql`d.date`.mapWith((v) => new Date(v)).as("date"),
            investmentId: Investments.id,
            priceAdjusted: latestPrice.priceAdjusted,
          })
          .from(dates)
          .crossJoin(Investments)
          .innerJoinLateral(latestPrice, sql`true`)
          .where(eq(Investments.currency, currency))
          .orderBy((a) => asc(a.date));

        const [pricesAdjRows, unitsAdjDeltaRows] = await Promise.all([
          pricesAdjQuery,
          loadAdjustedUnits(ctx, keys),
        ]);

        const x: Date[] = [];

        const yByAsset = new Map<string, number[]>();
        const yByInvestment = new Map<string, number[]>();
        const yByBoth = new Map<string, number[]>();
        const yByNone: number[] = [];

        const valueByAsset = new Map<string, number>();
        const valueByInvestment = new Map<string, number>();
        const valueByBoth = new Map<string, number>();
        let valueByNone = 0;

        let cursorUnits = 0;
        let cursorPrices = -1;

        const unitsByInvestmentAsset = new Map<string, number>();

        // Push one entry per flush into every `yBy*` map the caller may read.
        // Investments (and assets) whose first `InvestmentPrices.date` comes
        // after an early `d.date` won't produce a lateral row on those early
        // dates, so their `valueBy*` is empty on those flushes. Without this
        // helper, their `yBy*` array would fall behind `x.length` and indexing
        // later yields `undefined` → `Math.round(undefined)` = `NaN`.
        //
        // Back-fill missing keys on first appearance with leading zeros
        // (pre-first-trade value = 0) and forward-fill missing keys in this
        // flush with `0` (no activity on this bucket).
        const flushMap = (
          src: Map<string, number>,
          dst: Map<string, number[]>,
          flushIndex: number,
        ) => {
          for (const id of src.keys()) {
            if (!dst.has(id)) dst.set(id, new Array(flushIndex).fill(0));
          }
          for (const [id, arr] of dst) arr.push(src.get(id) ?? 0);
          src.clear();
        };

        const bufferPrices = (cursor: number) => {
          const priceRow = pricesAdjRows[cursor];
          const flushIndex = x.length;
          flushMap(valueByAsset, yByAsset, flushIndex);
          flushMap(valueByInvestment, yByInvestment, flushIndex);
          flushMap(valueByBoth, yByBoth, flushIndex);

          yByNone.push(valueByNone);
          valueByNone = 0;

          x.push(priceRow.date);
        };

        while (++cursorPrices < pricesAdjRows.length) {
          const priceRow = pricesAdjRows[cursorPrices];
          while (
            cursorUnits < unitsAdjDeltaRows.length &&
            unitsAdjDeltaRows[cursorUnits].date <= priceRow.date
          ) {
            const { assetId, investmentId, units } =
              unitsAdjDeltaRows[cursorUnits];
            const key = `${investmentId}|${assetId}`;
            unitsByInvestmentAsset.set(
              key,
              units + (unitsByInvestmentAsset.get(key) ?? 0),
            );
            cursorUnits++;
          }
          if (
            cursorPrices > 0 &&
            priceRow.date > pricesAdjRows[cursorPrices - 1].date
          ) {
            bufferPrices(cursorPrices - 1);
          }

          const { investmentId, priceAdjusted } = priceRow;
          for (const [key, units] of unitsByInvestmentAsset.entries()) {
            if (!units) continue;
            const [unitsInvestmentId, assetId] = key.split("|");
            if (unitsInvestmentId !== investmentId) continue;

            const value = units * priceAdjusted;

            valueByAsset.set(assetId, (valueByAsset.get(assetId) ?? 0) + value);
            valueByInvestment.set(
              investmentId,
              (valueByInvestment.get(investmentId) ?? 0) + value,
            );
            valueByBoth.set(key, (valueByBoth.get(key) ?? 0) + value);
            valueByNone += value;
          }
        }
        bufferPrices(cursorPrices - 1);

        // Fetch today's live-overlaid portfolio total per non-skipLive key.
        // The last x is `now()::date` by construction (union in the `dates`
        // CTE), so we just substitute that point's y rather than appending.
        const liveByKeyIndex = await Promise.all(
          keys.map((key) =>
            key.skipLive
              ? Promise.resolve(null)
              : loadInvestmentStats(ctx, {
                  currency,
                  assetId: key.assetId,
                  investmentId: key.investmentId,
                  skipLive: false,
                }).then((s) => s.totalValueMinor),
          ),
        );

        return keys.map<PortfolioTimeseries>((key, keyIndex) => {
          const data = (() => {
            const { assetId, investmentId } = key;
            if (assetId) {
              if (investmentId) {
                return { x, y: yByBoth.get(`${investmentId}|${assetId}`) };
              }
              return { x, y: yByAsset.get(assetId) };
            }
            if (investmentId) {
              return { x, y: yByInvestment.get(investmentId) };
            }
            return { x, y: yByNone };
          })();
          assert(data.y, `Could not resolve Y values for key ${key}`);
          const lastIdx = data.x.length - 1;
          const liveTotal = liveByKeyIndex[keyIndex];
          return {
            currency,
            initialDate: data.x[0],
            points: data.x.map((date, i) => ({
              x: differenceInDays(date, data.x[0]),
              y: Math.round(
                Money.fromMinorDenomination(
                  i === lastIdx && liveTotal !== null ? liveTotal : data.y![i],
                  currency,
                ).amount,
              ),
            })),
          };
        });
      },
      {
        cacheKeyFn,
      },
    ),
);

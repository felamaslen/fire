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

import { contextAwareDataLoader } from "../context";
import { PortfolioTimePeriod, PortfolioTimeseries } from "./portfolio";

type TimeseriesKey = {
  /** When set, filters the result by the given portfolio (net worth asset ID) */
  assetId?: string;
  /** When set, filters the result by the given stock/fund (investment ID) */
  investmentId?: string;
  period: PortfolioTimePeriod;
  length: number;
};

const cacheKeyFn = (key: TimeseriesKey): string =>
  `${key.period}|${key.length}|${key.assetId ?? ""}|${key.investmentId ?? ""}`;

const MAX_POINTS = 300;

/**
 * Retrieves a time-series of total value, optionally filtering by portfolio (net worth asset ID) and/or stock (investment ID).
 * Takes stock splits into account to compute historical values, according to the units acquired as defined by the list of transactions.
 */
export const loadTimeseries = contextAwareDataLoader(
  () =>
    new DataLoader<TimeseriesKey, PortfolioTimeseries, string>(
      async (keys) => {
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

        const startDate = (() => {
          switch (keys[0].period) {
            case "ALL": {
              return db
                .select({ minDate: min(InvestmentTransactions.date) })
                .from(InvestmentTransactions)
                .where(
                  and(
                    eq(InvestmentTransactions.currency, currency),
                    whereAssetId,
                    whereInvestmentId(InvestmentTransactions),
                  ),
                );
            }
            case "YEAR":
              return sql`select (now() - interval '${sql.raw(keys[0].length.toString())} year')::date`;
            case "MONTH":
              return sql`select (now() - interval '${sql.raw(keys[0].length.toString())} month')::date`;
            case "YTD":
              return sql`select date_trunc('year', now())::date`;
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

        const pricesAdjQuery = db
          .with(dates)
          .select({
            date: sql`d.date`.mapWith((v) => new Date(v)).as("date"),
            investmentId: Investments.id,
            priceAdjusted: InvestmentPrices.priceAdjusted,
          })
          .from(dates)
          .crossJoin(Investments)
          .innerJoin(
            InvestmentPrices,
            eq(
              InvestmentPrices.id,
              db
                .select({ id: InvestmentPrices.id })
                .from(InvestmentPrices)
                .where(
                  and(
                    eq(InvestmentPrices.investmentId, Investments.id),
                    lte(InvestmentPrices.date, sql`d.date`),
                  ),
                )
                .orderBy(desc(InvestmentPrices.date))
                .limit(1),
            ),
          )
          .where(
            and(
              eq(Investments.currency, currency),
              whereInvestmentId(InvestmentPrices),
            ),
          )
          .orderBy((a) => asc(a.date));

        const unitsAdjDeltaQuery = db
          .select({
            date: InvestmentTransactions.date,
            investmentId: InvestmentTransactions.investmentId,
            assetId: InvestmentTransactions.assetId,
            units:
              sql<number>`(${InvestmentTransactions.units} * coalesce(exp(ln(
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

        const [pricesAdjRows, unitsAdjDeltaRows] = await Promise.all([
          pricesAdjQuery,
          unitsAdjDeltaQuery,
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

        const bufferPrices = (cursor: number) => {
          const priceRow = pricesAdjRows[cursor];
          for (const [assetId, y] of valueByAsset) {
            if (!yByAsset.has(assetId)) yByAsset.set(assetId, []);
            yByAsset.get(assetId)!.push(y);
          }
          valueByAsset.clear();
          for (const [investmentId, y] of valueByInvestment) {
            if (!yByInvestment.has(investmentId))
              yByInvestment.set(investmentId, []);
            yByInvestment.get(investmentId)!.push(y);
          }
          valueByInvestment.clear();
          for (const [key, y] of valueByBoth) {
            if (!yByBoth.has(key)) yByBoth.set(key, []);
            yByBoth.get(key)!.push(y);
          }
          valueByBoth.clear();

          yByNone.push(valueByNone);
          valueByNone = 0;

          x.push(priceRow.date);
        };

        while (++cursorPrices < pricesAdjRows.length) {
          const priceRow = pricesAdjRows[cursorPrices];
          while (
            cursorUnits < unitsAdjDeltaRows.length - 1 &&
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

        return keys.map<PortfolioTimeseries>((key) => {
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
          return {
            currency,
            initialDate: data.x[0],
            points: data.x.map((date, i) => ({
              x: differenceInDays(date, data.x[0]),
              y: Math.round(data.y![i]),
            })),
          };
        });
      },
      {
        cacheKeyFn,
      },
    ),
);

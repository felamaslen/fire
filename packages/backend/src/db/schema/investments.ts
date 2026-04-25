import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  doublePrecision,
  index,
  jsonb,
  numeric,
  pgTable,
  pgView,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { currencyCode } from "./currency";
import { NetWorthCategoryAssets } from "./net-worth";

/** A tradable holding — a stock (identified by ticker) or a fund (identified by a URL to the product page). */
export const Investments = pgTable(
  "Investments",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    name: text("name").notNull(),
    /** Ticker on the relevant exchange, e.g. `SMT.L`, `AAPL`. Set iff this is a listed stock. */
    stockCode: text("stockCode"),
    /** URL to the fund's product page (e.g. a Hargreaves Lansdown page). Set iff this is a fund. */
    fundLink: text("fundLink"),
    /** Quote currency. All transactions and prices for this investment must match. */
    currency: currencyCode("currency").notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "Investments_stockCode_fundLink_ck",
      sql`(${t.stockCode} IS NOT NULL)::int + (${t.fundLink} IS NOT NULL)::int = 1`,
    ),
  ],
);

export const investmentsRelations = relations(Investments, ({ many }) => ({
  transactions: many(InvestmentTransactions),
  stockSplits: many(InvestmentStockSplits),
  prices: many(InvestmentPrices),
}));

/** One buy / sell / dividend-reinvestment against an `Investments` row, booked against a net-worth asset (STOCK or PENSION — validated in the resolver). */
export const InvestmentTransactions = pgTable(
  "InvestmentTransactions",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    investmentId: uuid("investmentId")
      .notNull()
      .references(() => Investments.id, { onDelete: "cascade" }),
    /** Wrapper the transaction books into. Must reference a `STOCK` or `PENSION` asset — enforced in the resolver. */
    assetId: uuid("assetId")
      .notNull()
      .references(() => NetWorthCategoryAssets.id, { onDelete: "restrict" }),
    /** Signed integer number of units traded. Positive = buy / DRIP, negative = sell. Fractional units are not supported. */
    units: bigint("units", { mode: "number" }).notNull(),
    /** Unit price at execution, in fractional units of `currency` (e.g. pence for GBP). Floating-point — sub-penny tick sizes are expected. */
    price: doublePrecision("price").notNull(),
    /** Taxes paid, in fractional units of `currency`. Non-negative. */
    taxes: bigint("taxes", { mode: "number" }).notNull().default(0),
    /** Broker / platform fees, in fractional units of `currency`. Non-negative. */
    fees: bigint("fees", { mode: "number" }).notNull().default(0),
    /** Must equal the parent `Investments.currency` — asserted in app code at write time. */
    currency: currencyCode("currency").notNull(),
    date: date("date", { mode: "date" }).notNull(),
    /** True when this row represents a dividend reinvestment (not a cash buy). */
    drip: boolean("drip").notNull().default(false),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check("InvestmentTransactions_price_ck", sql`${t.price} >= 0`),
    check("InvestmentTransactions_taxes_ck", sql`${t.taxes} >= 0`),
    check("InvestmentTransactions_fees_ck", sql`${t.fees} >= 0`),
    index("InvestmentTransactions_investmentId_idx").on(t.investmentId),
    index("InvestmentTransactions_assetId_idx").on(t.assetId),
    index("InvestmentTransactions_date").on(t.date),
  ],
);

export const investmentTransactionsRelations = relations(
  InvestmentTransactions,
  ({ one }) => ({
    investment: one(Investments, {
      fields: [InvestmentTransactions.investmentId],
      references: [Investments.id],
    }),
    asset: one(NetWorthCategoryAssets, {
      fields: [InvestmentTransactions.assetId],
      references: [NetWorthCategoryAssets.id],
    }),
  }),
);

/** Stock-split event: `units_post = units_pre * ratio`. Ratio > 1 = forward split (e.g. `2` for 2-for-1), 0 < ratio < 1 = reverse split. Writes trigger a backfill of `InvestmentPrices.priceAdjusted` for rows dated before this split. */
export const InvestmentStockSplits = pgTable(
  "InvestmentStockSplits",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    investmentId: uuid("investmentId")
      .notNull()
      .references(() => Investments.id, { onDelete: "cascade" }),
    date: date("date", { mode: "date" }).notNull(),
    /** Split ratio as a positive decimal. `2` = 2-for-1 forward split; `0.1` = 1-for-10 reverse split. */
    ratio: numeric("ratio", {
      precision: 20,
      scale: 10,
      mode: "string",
    }).notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check("InvestmentStockSplits_ratio_ck", sql`${t.ratio} > 0`),
    uniqueIndex("InvestmentStockSplits_investmentId_date_uq").on(
      t.investmentId,
      t.date,
    ),
  ],
);

export const investmentStockSplitsRelations = relations(
  InvestmentStockSplits,
  ({ one }) => ({
    investment: one(Investments, {
      fields: [InvestmentStockSplits.investmentId],
      references: [Investments.id],
    }),
  }),
);

/** One historic price quote for an investment on a given day. `priceAdjusted` reflects `price` corrected for any stock splits that occurred **after** `date`, and is maintained by the `InvestmentPrices_setAdjusted_trg` / `InvestmentStockSplits_recomputePrices_trg` triggers (added in migration `0016`). Currency must match the parent `Investments.currency` — asserted in app code at write time. */
export const InvestmentPrices = pgTable(
  "InvestmentPrices",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    investmentId: uuid("investmentId")
      .notNull()
      .references(() => Investments.id, { onDelete: "cascade" }),
    date: date("date", { mode: "date" }).notNull(),
    /** Raw observed unit price, in fractional units of `currency`. Floating-point — sub-penny tick sizes are expected. */
    price: doublePrecision("price").notNull(),
    /** Split-adjusted unit price, in fractional units of `currency`. Equal to `price * product(ratio for every later split)`. Maintained by trigger — do not write directly; any value supplied on INSERT / UPDATE is overwritten. */
    priceAdjusted: doublePrecision("priceAdjusted").notNull().default(0),
    /** `true` on the row with the greatest `date` per `investmentId`, `null` on every other row (nullable-`true` pattern so the partial unique index enforces "at most one latest per investment" without needing to store `false` on the other rows). Maintained by trigger — do not write directly. Lets the hot "what's the latest close for these N investments?" query hit the partial index directly instead of window-sorting the full history. */
    isLatest: boolean("isLatest"),
    currency: currencyCode("currency").notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check("InvestmentPrices_price_ck", sql`${t.price} >= 0`),
    check("InvestmentPrices_priceAdjusted_ck", sql`${t.priceAdjusted} >= 0`),
    check(
      "InvestmentPrices_isLatest_ck",
      sql`${t.isLatest} IS NULL OR ${t.isLatest} = true`,
    ),
    uniqueIndex("InvestmentPrices_investmentId_date_uq").on(
      t.investmentId,
      t.date,
    ),
    index("InvestmentPrices_date").on(t.date),
    uniqueIndex("InvestmentPrices_investmentId_isLatest_uq")
      .on(t.investmentId, t.isLatest)
      .where(sql`${t.isLatest} IS NOT NULL`),
  ],
);

export const investmentPricesRelations = relations(
  InvestmentPrices,
  ({ one }) => ({
    investment: one(Investments, {
      fields: [InvestmentPrices.investmentId],
      references: [Investments.id],
    }),
  }),
);

/** Most recent live (intraday) quote for an investment. One row per investment — `investmentId` is the primary key, so refreshes upsert in place rather than appending history. Read by the live-overlay path that powers the investments page; the daily-close history lives in `InvestmentPrices`. */
export const InvestmentPricesLive = pgTable("InvestmentPricesLive", {
  investmentId: uuid("investmentId")
    .primaryKey()
    .references(() => Investments.id, { onDelete: "cascade" }),
  /** When this row was last refreshed from the upstream provider — i.e. wall-clock time of the network fetch, not of the price tick. */
  refreshedAt: timestamp("refreshedAt", { withTimezone: true }).notNull(),
  /** Time of the actual price tick as reported by the upstream provider (Yahoo's `regularMarketTime`). */
  date: timestamp("date", { withTimezone: true }).notNull(),
  currency: currencyCode("currency").notNull(),
  /** Live unit price, in fractional units of `currency` (e.g. pence for `GBP`). */
  price: doublePrecision("price").notNull(),
  /** Previous-trading-day close, in fractional units of `currency`. `null` when the upstream provider doesn't report it. */
  pricePreviousClose: doublePrecision("pricePreviousClose"),
  /** Raw upstream response payload, kept for debugging / future fields. */
  data: jsonb("data"),
  createdAt: timestamp("createdAt", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updatedAt", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const investmentPricesLiveRelations = relations(
  InvestmentPricesLive,
  ({ one }) => ({
    investment: one(Investments, {
      fields: [InvestmentPricesLive.investmentId],
      references: [Investments.id],
    }),
  }),
);

/** Target allocation of a wrapper's value to a specific investment. PK is (`assetId`, `investmentId`) so each pairing appears at most once. The resolver enforces that per-asset allocations sum correctly; the DB only checks individual bounds. */
export const InvestmentAllocations = pgTable(
  "InvestmentAllocations",
  {
    assetId: uuid("assetId")
      .notNull()
      .references(() => NetWorthCategoryAssets.id, { onDelete: "cascade" }),
    investmentId: uuid("investmentId")
      .notNull()
      .references(() => Investments.id, { onDelete: "cascade" }),
    /** Target fraction of the wrapper's value allocated to the investment. `0 < a <= 1`. Zero-weight allocations should be deleted, not stored. */
    allocation: doublePrecision("allocation").notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({
      name: "InvestmentAllocations_pk",
      columns: [t.assetId, t.investmentId],
    }),
    check(
      "InvestmentAllocations_allocation_ck",
      sql`${t.allocation} > 0 AND ${t.allocation} <= 1`,
    ),
  ],
);

export const investmentAllocationsRelations = relations(
  InvestmentAllocations,
  ({ one }) => ({
    asset: one(NetWorthCategoryAssets, {
      fields: [InvestmentAllocations.assetId],
      references: [NetWorthCategoryAssets.id],
    }),
    investment: one(Investments, {
      fields: [InvestmentAllocations.investmentId],
      references: [Investments.id],
    }),
  }),
);

/** Daily portfolio value per wrapper, per currency. One row per `(currency, assetId, date)` triple, covering every day from the earliest price-quote date through the latest. `amount` is the sum over all investments held in that wrapper of `units_held_on_day * last_known_price_on_or_before_day`, in fractional units of `currency`. Dates with no known price for an investment forward-fill from the most recent quote. */
export const InvestmentPortfolioDailyBreakdown = pgView(
  "InvestmentPortfolioDailyBreakdown",
  {
    currency: currencyCode("currency").notNull(),
    assetId: uuid("assetId").notNull(),
    date: date("date", { mode: "date" }).notNull(),
    amount: doublePrecision("amount").notNull(),
  },
).as(
  sql`
    WITH
      "priceRange" AS (
        SELECT MIN(date) AS "startDate", MAX(date) AS "endDate"
        FROM "InvestmentPrices"
      ),
      days AS (
        SELECT generate_series("startDate", "endDate", '1 day'::interval)::date AS date
        FROM "priceRange"
        WHERE "startDate" IS NOT NULL
      ),
      holdings AS (
        SELECT DISTINCT "assetId", "investmentId"
        FROM "InvestmentTransactions"
      ),
      "unitsByDay" AS (
        SELECT
          h."assetId",
          h."investmentId",
          d.date,
          COALESCE(
            (SELECT SUM(t.units)
             FROM "InvestmentTransactions" t
             WHERE t."assetId" = h."assetId"
               AND t."investmentId" = h."investmentId"
               AND t.date <= d.date),
            0
          ) AS units
        FROM holdings h
        CROSS JOIN days d
      ),
      "priceByDay" AS (
        SELECT
          h."investmentId",
          d.date,
          (SELECT p.price
           FROM "InvestmentPrices" p
           WHERE p."investmentId" = h."investmentId" AND p.date <= d.date
           ORDER BY p.date DESC
           LIMIT 1) AS price
        FROM (SELECT DISTINCT "investmentId" FROM holdings) h
        CROSS JOIN days d
      )
    SELECT
      i.currency,
      u."assetId",
      u.date,
      SUM(u.units * p.price) AS amount
    FROM "unitsByDay" u
    JOIN "Investments" i ON i.id = u."investmentId"
    JOIN "priceByDay" p ON p."investmentId" = u."investmentId" AND p.date = u.date
    WHERE p.price IS NOT NULL AND u.units <> 0
    GROUP BY i.currency, u."assetId", u.date
  `,
);

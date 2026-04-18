import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  doublePrecision,
  index,
  numeric,
  pgTable,
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

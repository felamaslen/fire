import { relations, sql } from "drizzle-orm";
import {
  bigint,
  check,
  date,
  index,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { currencyCode } from "./currency";

/** Kind of asset a NetWorthCategoryAsset represents. */
export const netWorthCategoryAssetType = pgEnum("netWorthCategoryAssetType", [
  "CASH",
  "STOCK",
  "OPTION",
  "PENSION",
  "PROPERTY",
  "MISC",
]);

/** Kind of liability a NetWorthCategoryLiability represents. */
export const netWorthCategoryLiabilityType = pgEnum(
  "netWorthCategoryLiabilityType",
  ["CREDIT_CARD", "LOAN", "MISC"],
);

/** One net-worth snapshot, keyed to a calendar month. */
export const NetWorthEntries = pgTable(
  "NetWorthEntries",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    /** Any calendar day inside the target month; day-of-month is not significant. */
    date: date("date", { mode: "date" }).notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("NetWorthEntries_month_uq").on(
      sql`date_trunc('month', ${t.date}::timestamp)`,
    ),
  ],
);

export const netWorthEntriesRelations = relations(
  NetWorthEntries,
  ({ many }) => ({
    values: many(NetWorthValues),
    currencyRates: many(NetWorthCurrencyRates),
  }),
);

/** Exchange rate captured alongside a NetWorthEntry. One row per (entry, currency) — the rate converts `base` into `currency`. */
export const NetWorthCurrencyRates = pgTable(
  "NetWorthCurrencyRates",
  {
    entryId: uuid("entryId")
      .notNull()
      .references(() => NetWorthEntries.id, { onDelete: "cascade" }),
    /** Currency being priced in (e.g. GBP for GBP/USD). */
    base: currencyCode("base").notNull(),
    /** Currency being quoted (e.g. USD for GBP/USD). */
    currency: currencyCode("currency").notNull(),
    /** Units of `currency` per one unit of `base` (e.g. 1.35 for GBP/USD). */
    rate: numeric("rate", { precision: 24, scale: 12 }).notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({
      name: "NetWorthCurrencyRates_pk",
      columns: [t.entryId, t.currency],
    }),
    check(
      "NetWorthCurrencyRates_base_currency_ck",
      sql`${t.base} <> ${t.currency}`,
    ),
  ],
);

export const netWorthCurrencyRatesRelations = relations(
  NetWorthCurrencyRates,
  ({ one }) => ({
    entry: one(NetWorthEntries, {
      fields: [NetWorthCurrencyRates.entryId],
      references: [NetWorthEntries.id],
    }),
  }),
);

/** Reusable bucket for assets (current account, brokerage, pension pot, house, ...). */
export const NetWorthCategoryAssets = pgTable("NetWorthCategoryAssets", {
  id: uuid("id")
    .primaryKey()
    .default(sql`uuidv7()`),
  name: text("name").notNull(),
  type: netWorthCategoryAssetType("type").notNull(),
  createdAt: timestamp("createdAt", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updatedAt", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const netWorthCategoryAssetsRelations = relations(
  NetWorthCategoryAssets,
  ({ many }) => ({
    liabilities: many(NetWorthCategoryLiabilities),
    values: many(NetWorthValues),
  }),
);

/** Reusable bucket for liabilities (credit card, mortgage, personal loan, ...). */
export const NetWorthCategoryLiabilities = pgTable(
  "NetWorthCategoryLiabilities",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    name: text("name").notNull(),
    type: netWorthCategoryLiabilityType("type").notNull(),
    /** Optional link to the asset this liability funds (e.g. a mortgage -> the property) for LTV calcs. */
    categoryAssetId: uuid("categoryAssetId").references(
      () => NetWorthCategoryAssets.id,
      { onDelete: "set null" },
    ),
    /** Annual interest rate as a decimal (0.0525 = 5.25%). Required iff type=LOAN. */
    interestRate: numeric("interestRate", { precision: 6, scale: 4 }),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "NetWorthCategoryLiabilities_interestRate_ck",
      sql`(${t.type} = 'LOAN' AND ${t.interestRate} IS NOT NULL)
           OR (${t.type} <> 'LOAN' AND ${t.interestRate} IS NULL)`,
    ),
  ],
);

export const netWorthCategoryLiabilitiesRelations = relations(
  NetWorthCategoryLiabilities,
  ({ one, many }) => ({
    categoryAsset: one(NetWorthCategoryAssets, {
      fields: [NetWorthCategoryLiabilities.categoryAssetId],
      references: [NetWorthCategoryAssets.id],
    }),
    values: many(NetWorthValues),
  }),
);

/** Reusable bucket for equity options (e.g. "My company shares"). Valued separately from assets so vesting/strike-price logic can live here later. */
export const NetWorthCategoryOptions = pgTable("NetWorthCategoryOptions", {
  id: uuid("id")
    .primaryKey()
    .default(sql`uuidv7()`),
  name: text("name").notNull(),
  createdAt: timestamp("createdAt", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updatedAt", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const netWorthCategoryOptionsRelations = relations(
  NetWorthCategoryOptions,
  ({ many }) => ({
    values: many(NetWorthValues),
  }),
);

/** A single line item inside a NetWorthEntry. Must reference exactly one of asset/liability/option category. Amounts live in NetWorthValueAmounts (one row per currency). */
export const NetWorthValues = pgTable(
  "NetWorthValues",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    entryId: uuid("entryId")
      .notNull()
      .references(() => NetWorthEntries.id, { onDelete: "cascade" }),
    categoryAssetId: uuid("categoryAssetId").references(
      () => NetWorthCategoryAssets.id,
      { onDelete: "restrict" },
    ),
    categoryLiabilityId: uuid("categoryLiabilityId").references(
      () => NetWorthCategoryLiabilities.id,
      { onDelete: "restrict" },
    ),
    categoryOptionId: uuid("categoryOptionId").references(
      () => NetWorthCategoryOptions.id,
      { onDelete: "restrict" },
    ),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "NetWorthValues_exactlyOneCategory_ck",
      sql`(
        (CASE WHEN ${t.categoryAssetId}     IS NOT NULL THEN 1 ELSE 0 END)
      + (CASE WHEN ${t.categoryLiabilityId} IS NOT NULL THEN 1 ELSE 0 END)
      + (CASE WHEN ${t.categoryOptionId}    IS NOT NULL THEN 1 ELSE 0 END)
      ) = 1`,
    ),
    index("NetWorthValues_entryId_idx").on(t.entryId),
  ],
);

export const netWorthValuesRelations = relations(
  NetWorthValues,
  ({ one, many }) => ({
    entry: one(NetWorthEntries, {
      fields: [NetWorthValues.entryId],
      references: [NetWorthEntries.id],
    }),
    categoryAsset: one(NetWorthCategoryAssets, {
      fields: [NetWorthValues.categoryAssetId],
      references: [NetWorthCategoryAssets.id],
    }),
    categoryLiability: one(NetWorthCategoryLiabilities, {
      fields: [NetWorthValues.categoryLiabilityId],
      references: [NetWorthCategoryLiabilities.id],
    }),
    categoryOption: one(NetWorthCategoryOptions, {
      fields: [NetWorthValues.categoryOptionId],
      references: [NetWorthCategoryOptions.id],
    }),
    amounts: many(NetWorthValueAmounts),
  }),
);

/** One monetary amount (in minor units of `currency`) for a NetWorthValue. A value may have multiple rows here — at most one per currency. */
export const NetWorthValueAmounts = pgTable(
  "NetWorthValueAmounts",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    valueId: uuid("valueId")
      .notNull()
      .references(() => NetWorthValues.id, { onDelete: "cascade" }),
    /** Stored in the minor units of `currency` (e.g. pence for GBP). */
    amount: bigint("amount", { mode: "number" }).notNull(),
    currency: currencyCode("currency").notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("NetWorthValueAmounts_valueId_currency_uq").on(
      t.valueId,
      t.currency,
    ),
  ],
);

export const netWorthValueAmountsRelations = relations(
  NetWorthValueAmounts,
  ({ one }) => ({
    value: one(NetWorthValues, {
      fields: [NetWorthValueAmounts.valueId],
      references: [NetWorthValues.id],
    }),
  }),
);

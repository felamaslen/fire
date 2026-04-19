import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  doublePrecision,
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
import { PlanningAccounts } from "./planning";

/** Kind of asset a NetWorthCategoryAsset represents. */
export const netWorthCategoryAssetType = pgEnum("netWorthCategoryAssetType", [
  "CASH",
  "STOCK",
  "OPTION",
  "PENSION",
  "PROPERTY",
  "VEHICLE",
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

/** Exchange rate captured alongside a NetWorthEntry. One row per (entry, currency) — the rate converts `currency` into `base`. */
export const NetWorthCurrencyRates = pgTable(
  "NetWorthCurrencyRates",
  {
    entryId: uuid("entryId")
      .notNull()
      .references(() => NetWorthEntries.id, { onDelete: "cascade" }),
    /** Currency the rate resolves into (e.g. GBP for a GBP/USD quote). */
    base: currencyCode("base").notNull(),
    /** Currency being priced (e.g. USD for a GBP/USD quote). */
    currency: currencyCode("currency").notNull(),
    /** Units of `base` per one unit of `currency` (e.g. 0.77 for GBP/USD: 1 USD = 0.77 GBP). */
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
export const NetWorthCategoryAssets = pgTable(
  "NetWorthCategoryAssets",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    name: text("name").notNull(),
    type: netWorthCategoryAssetType("type").notNull(),
    /** Assumed annual growth rate as a decimal (0.03 = +3% p.a.). Negative for depreciation (vehicles). Used only by the net-worth forecast; null means no extrapolation. Only valid for `PROPERTY` and `VEHICLE` — enforced by check constraint. */
    growthRate: numeric("growthRate", { precision: 6, scale: 4 }),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "NetWorthCategoryAssets_growthRate_ck",
      sql`${t.growthRate} IS NULL OR ${t.type} IN ('PROPERTY', 'VEHICLE')`,
    ),
  ],
);

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
    /** Planning account this liability is billed from (e.g. a credit card paid off from a current account). When set, the planner emits predicted monthly payment transactions on that account. Only valid for `CREDIT_CARD` type — enforced by check constraint. */
    billedFromAccountId: uuid("billedFromAccountId").references(
      () => PlanningAccounts.accountId,
      { onDelete: "set null" },
    ),
    /** When true, the liability is hidden from aggregate totals (e.g. a closed credit card). */
    skip: boolean("skip").notNull().default(false),
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
    check(
      "NetWorthCategoryLiabilities_billedFromAccount_ck",
      sql`${t.billedFromAccountId} IS NULL OR ${t.type} = 'CREDIT_CARD'`,
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
    billedFromAccount: one(PlanningAccounts, {
      fields: [NetWorthCategoryLiabilities.billedFromAccountId],
      references: [PlanningAccounts.accountId],
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
    valueOptions: one(NetWorthValueOptions, {
      fields: [NetWorthValues.id],
      references: [NetWorthValueOptions.valueId],
    }),
  }),
);

/** Per-value option metadata (units, strike, market, vested). One row per `NetWorthValue` whose category is an option. Not currently exposed via GraphQL. */
export const NetWorthValueOptions = pgTable("NetWorthValueOptions", {
  id: uuid("id")
    .primaryKey()
    .default(sql`uuidv7()`),
  valueId: uuid("valueId")
    .notNull()
    .unique()
    .references(() => NetWorthValues.id, { onDelete: "cascade" }),
  /** Number of option units held. */
  units: bigint("units", { mode: "number" }).notNull(),
  /** Currency of `priceStrike` and `priceMarket`. */
  currency: currencyCode("currency").notNull(),
  /** Strike price, in fractional units of `currency`. Floating-point — sub-penny tick sizes are expected. */
  priceStrike: doublePrecision("priceStrike").notNull(),
  /** Most-recent market price, in fractional units of `currency`. Null if unknown. Floating-point — sub-penny tick sizes are expected. */
  priceMarket: doublePrecision("priceMarket"),
  /** How many of the held units have vested (<= units). */
  vested: bigint("vested", { mode: "number" }).notNull(),
  createdAt: timestamp("createdAt", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updatedAt", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const netWorthValueOptionsRelations = relations(
  NetWorthValueOptions,
  ({ one }) => ({
    value: one(NetWorthValues, {
      fields: [NetWorthValueOptions.valueId],
      references: [NetWorthValues.id],
    }),
  }),
);

/** One monetary amount (in fractional units of `currency`) for a NetWorthValue. A value may have multiple rows here — at most one per currency. */
export const NetWorthValueAmounts = pgTable(
  "NetWorthValueAmounts",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    valueId: uuid("valueId")
      .notNull()
      .references(() => NetWorthValues.id, { onDelete: "cascade" }),
    /** Stored in the fractional units of `currency` (e.g. pence for GBP). */
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

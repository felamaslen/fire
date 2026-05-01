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
import { pgCustomSQL } from "drizzle-pgkit-migrator";

import { HOME_CURRENCY } from "@/config";

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
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Assumed annual growth rate as a percentage (e.g. 3 for +3%/year). Negative for depreciation (vehicles). Used only by the net-worth forecast; null means no extrapolation. Only valid for `PROPERTY` and `VEHICLE` — enforced by check constraint. Position matches migration `0021` (added after `updatedAt`). */
    growthRate: numeric("growthRate", { precision: 6, scale: 4 }),
    /** Date from which the pot can be drawn down (e.g. UK pension access age 57). Only valid for `PENSION` assets — enforced by check constraint. Null means "accessible now"; the forecast skips retirement drawdown on this pot until the date is reached. Position matches migration `0027`. */
    accessibleFrom: date("accessibleFrom", { mode: "date" }),
  },
  (t) => [
    check(
      "NetWorthCategoryAssets_growthRate_ck",
      sql`${t.growthRate} IS NULL OR ${t.type} IN ('PROPERTY', 'VEHICLE')`,
    ),
    check(
      "NetWorthCategoryAssets_accessibleFrom_ck",
      sql`${t.accessibleFrom} IS NULL OR ${t.type} = 'PENSION'`,
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
    /** Annual interest rate as a percentage (e.g. 5.25 for 5.25%). Required iff type=LOAN. */
    interestRate: numeric("interestRate", { precision: 6, scale: 4 }),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** When true, the liability is hidden from aggregate totals (e.g. a closed credit card). Position matches migration that added it. */
    skip: boolean("skip").notNull().default(false),
    /** Planning account this liability is billed from (e.g. a credit card paid off from a current account). When set, the planner emits predicted monthly payment transactions on that account. Only valid for `CREDIT_CARD` type — enforced by check constraint. Position matches migration `0009` (added after `skip`). */
    billedFromAccountId: uuid("billedFromAccountId").references(
      () => PlanningAccounts.accountId,
      { onDelete: "set null" },
    ),
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

/** Aggregation bucket for `NetWorthEntryBuckets`. One value per `netWorthCategoryAssetType`, plus `OPTION` (also covering `categoryOptionId` line items — the resolver merges them) and `LIABILITY` (sum of all non-`skip` liabilities, positive magnitude). */
export const netWorthHistoryBucket = pgEnum("netWorthHistoryBucket", [
  "CASH",
  "STOCK",
  "OPTION",
  "PENSION",
  "PROPERTY",
  "VEHICLE",
  "MISC",
  "LIABILITY",
]);

/** Pre-aggregated home-currency totals for one `NetWorthEntry`, split by `bucket`. One row per `(entryId, bucket)`, only emitted when the bucket's amount is non-zero. Drives `Query.netWorthHistory` — the resolver scans this table directly instead of re-doing the values × amounts × categories × rates join on every read. Maintained by `NetWorthEntryBuckets_refresh_fn(uuid[])` and the per-table triggers further down; never written from application code. */
export const NetWorthEntryBuckets = pgTable(
  "NetWorthEntryBuckets",
  {
    entryId: uuid("entryId")
      .notNull()
      .references(() => NetWorthEntries.id, { onDelete: "cascade" }),
    bucket: netWorthHistoryBucket("bucket").notNull(),
    /** Aggregated amount for this bucket at this entry, converted into the home currency via the entry's captured `NetWorthCurrencyRates`. Stored in fractional units of `HOME_CURRENCY` (e.g. pence for `GBP`). Always non-negative for the `LIABILITY` bucket — liabilities are stored signed in `NetWorthValueAmounts` but surfaced as a positive magnitude here. */
    amountHomeMinor: bigint("amountHomeMinor", { mode: "number" }).notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({
      name: "NetWorthEntryBuckets_pk",
      columns: [t.entryId, t.bucket],
    }),
  ],
);

export const netWorthEntryBucketsRelations = relations(
  NetWorthEntryBuckets,
  ({ one }) => ({
    entry: one(NetWorthEntries, {
      fields: [NetWorthEntryBuckets.entryId],
      references: [NetWorthEntries.id],
    }),
  }),
);

/** `NetWorthEntryBuckets` is a derived cache fully rebuildable from `NetWorthValues`, `NetWorthValueAmounts`, `NetWorthCurrencyRates`, and the two category tables via `NetWorthEntryBuckets_refresh_fn`. Exclude it from the WAL — losing rows on crash is fine, the triggers (or a manual full refresh) regenerate them. */
export const NetWorthEntryBuckets_unlogged = pgCustomSQL(
  sql`ALTER TABLE "NetWorthEntryBuckets" SET UNLOGGED;`,
  { priority: 1 },
);

// The function bodies below match the migration text byte-for-byte — Postgres
// stores the body between the `$$` markers verbatim in `pg_proc.prosrc`, so
// any whitespace difference between the migrated and the schema.sql versions
// shows up as drift. Do not re-indent.

/** Recomputes `NetWorthEntryBuckets` rows for the given entry IDs. Deletes existing buckets in scope, then re-inserts one row per non-zero bucket per entry. Reads `NetWorthCurrencyRates` for FX, `NetWorthCategoryAssets.type` to bucket assets, `NetWorthCategoryLiabilities.skip` to drop hidden liabilities. Treats `categoryOptionId` line items as the `OPTION` bucket (matching the resolver). Idempotent. */
export const NetWorthEntryBuckets_refresh_fn = pgCustomSQL(
  sql.raw(
    `CREATE FUNCTION "NetWorthEntryBuckets_refresh_fn"(p_entry_ids uuid[]) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF cardinality(p_entry_ids) = 0 THEN
    RETURN;
  END IF;

  DELETE FROM "NetWorthEntryBuckets" WHERE "entryId" = ANY(p_entry_ids);

  INSERT INTO "NetWorthEntryBuckets" ("entryId", bucket, "amountHomeMinor")
  WITH converted AS (
    SELECT
      v."entryId",
      CASE
        WHEN v."categoryLiabilityId" IS NOT NULL THEN 'LIABILITY'::"netWorthHistoryBucket"
        WHEN v."categoryOptionId"    IS NOT NULL THEN 'OPTION'::"netWorthHistoryBucket"
        ELSE ca.type::text::"netWorthHistoryBucket"
      END AS bucket,
      cl.skip AS liability_skip,
      ROUND(
        (a.amount::numeric / power(10, "Currency_scale"(a.currency))::numeric)
        * COALESCE(
            CASE WHEN a.currency = '${HOME_CURRENCY}'::"CurrencyCode" THEN 1::numeric END,
            (SELECT r.rate
               FROM "NetWorthCurrencyRates" r
              WHERE r."entryId" = v."entryId"
                AND r.base = '${HOME_CURRENCY}'::"CurrencyCode"
                AND r.currency = a.currency),
            (SELECT (1::numeric / r.rate)
               FROM "NetWorthCurrencyRates" r
              WHERE r."entryId" = v."entryId"
                AND r.currency = '${HOME_CURRENCY}'::"CurrencyCode"
                AND r.base = a.currency)
          )
        * power(10, "Currency_scale"('${HOME_CURRENCY}'::"CurrencyCode"))::numeric
      )::bigint AS home_minor,
      v."categoryLiabilityId" IS NOT NULL AS is_liability
    FROM "NetWorthValues" v
    INNER JOIN "NetWorthValueAmounts" a ON a."valueId" = v.id
    LEFT JOIN "NetWorthCategoryAssets" ca ON ca.id = v."categoryAssetId"
    LEFT JOIN "NetWorthCategoryLiabilities" cl ON cl.id = v."categoryLiabilityId"
    WHERE v."entryId" = ANY(p_entry_ids)
  )
  SELECT
    "entryId",
    bucket,
    SUM(CASE WHEN is_liability THEN ABS(home_minor) ELSE home_minor END)::bigint AS "amountHomeMinor"
  FROM converted
  WHERE NOT (is_liability AND liability_skip)
    AND home_minor IS NOT NULL
  GROUP BY "entryId", bucket
  HAVING SUM(CASE WHEN is_liability THEN ABS(home_minor) ELSE home_minor END) <> 0;
END;
$$;`,
  ),
  { priority: 2 },
);

/** Per-statement trigger function shared by every `NetWorthEntryBuckets_refresh_*_trg`. Gathers the affected `entryId`s from `new_rows` / `old_rows` (translating `valueId → entryId` for `NetWorthValueAmounts`, and `categoryAssetId / categoryLiabilityId → entryId` for the two category tables), then delegates to `NetWorthEntryBuckets_refresh_fn`.
 *
 * The `pg_trigger_depth() > 1` guard prevents re-entry: `refresh_fn` only writes to `NetWorthEntryBuckets` (no triggers of its own), but the guard keeps the function safe if a future caller layers it under another trigger that fires UPDATEs on these tables. */
// prettier-ignore
export const NetWorthEntryBuckets_refreshFromTrigger_fn = pgCustomSQL(
  sql`CREATE FUNCTION "NetWorthEntryBuckets_refreshFromTrigger_fn"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  affected uuid[] := ARRAY[]::uuid[];
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN NULL;
  END IF;

  IF TG_TABLE_NAME = 'NetWorthValues' THEN
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
      affected := affected || ARRAY(SELECT DISTINCT "entryId" FROM new_rows);
    END IF;
    IF TG_OP IN ('DELETE', 'UPDATE') THEN
      affected := affected || ARRAY(SELECT DISTINCT "entryId" FROM old_rows);
    END IF;
  ELSIF TG_TABLE_NAME = 'NetWorthValueAmounts' THEN
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
      affected := affected || ARRAY(
        SELECT DISTINCT v."entryId"
          FROM new_rows nr
          INNER JOIN "NetWorthValues" v ON v.id = nr."valueId"
      );
    END IF;
    IF TG_OP IN ('DELETE', 'UPDATE') THEN
      affected := affected || ARRAY(
        SELECT DISTINCT v."entryId"
          FROM old_rows o
          INNER JOIN "NetWorthValues" v ON v.id = o."valueId"
      );
    END IF;
  ELSIF TG_TABLE_NAME = 'NetWorthCurrencyRates' THEN
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
      affected := affected || ARRAY(SELECT DISTINCT "entryId" FROM new_rows);
    END IF;
    IF TG_OP IN ('DELETE', 'UPDATE') THEN
      affected := affected || ARRAY(SELECT DISTINCT "entryId" FROM old_rows);
    END IF;
  ELSIF TG_TABLE_NAME = 'NetWorthCategoryAssets' THEN
    -- Only re-bucket when type actually changed; other column edits
    -- (name, growthRate, accessibleFrom) don't affect the totals.
    affected := affected || ARRAY(
      SELECT DISTINCT v."entryId"
        FROM new_rows nr
        INNER JOIN old_rows o ON o.id = nr.id
        INNER JOIN "NetWorthValues" v ON v."categoryAssetId" = nr.id
       WHERE nr.type IS DISTINCT FROM o.type
    );
  ELSIF TG_TABLE_NAME = 'NetWorthCategoryLiabilities' THEN
    -- Only re-bucket when skip actually changed; other column edits
    -- (name, interestRate, billedFromAccountId) don't affect the totals.
    affected := affected || ARRAY(
      SELECT DISTINCT v."entryId"
        FROM new_rows nr
        INNER JOIN old_rows o ON o.id = nr.id
        INNER JOIN "NetWorthValues" v ON v."categoryLiabilityId" = nr.id
       WHERE nr.skip IS DISTINCT FROM o.skip
    );
  END IF;

  IF cardinality(affected) = 0 THEN
    RETURN NULL;
  END IF;

  PERFORM "NetWorthEntryBuckets_refresh_fn"(ARRAY(SELECT DISTINCT unnest(affected)));
  RETURN NULL;
END;
$$;`,
  { priority: 2 },
);

/** Wires `NetWorthEntryBuckets_refreshFromTrigger_fn` to `AFTER INSERT` on `NetWorthValues`. */
export const NetWorthValues_refreshBuckets_ins_trg = pgCustomSQL(
  sql`
    CREATE TRIGGER "NetWorthValues_refreshBuckets_ins_trg"
    AFTER INSERT ON "NetWorthValues"
    REFERENCING NEW TABLE AS new_rows
    FOR EACH STATEMENT EXECUTE FUNCTION "NetWorthEntryBuckets_refreshFromTrigger_fn"();
  `,
  { priority: 3 },
);

/** Wires `NetWorthEntryBuckets_refreshFromTrigger_fn` to `AFTER UPDATE` on `NetWorthValues`. */
export const NetWorthValues_refreshBuckets_upd_trg = pgCustomSQL(
  sql`
    CREATE TRIGGER "NetWorthValues_refreshBuckets_upd_trg"
    AFTER UPDATE ON "NetWorthValues"
    REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
    FOR EACH STATEMENT EXECUTE FUNCTION "NetWorthEntryBuckets_refreshFromTrigger_fn"();
  `,
  { priority: 3 },
);

/** Wires `NetWorthEntryBuckets_refreshFromTrigger_fn` to `AFTER DELETE` on `NetWorthValues`. */
export const NetWorthValues_refreshBuckets_del_trg = pgCustomSQL(
  sql`
    CREATE TRIGGER "NetWorthValues_refreshBuckets_del_trg"
    AFTER DELETE ON "NetWorthValues"
    REFERENCING OLD TABLE AS old_rows
    FOR EACH STATEMENT EXECUTE FUNCTION "NetWorthEntryBuckets_refreshFromTrigger_fn"();
  `,
  { priority: 3 },
);

/** Wires `NetWorthEntryBuckets_refreshFromTrigger_fn` to `AFTER INSERT` on `NetWorthValueAmounts`. */
export const NetWorthValueAmounts_refreshBuckets_ins_trg = pgCustomSQL(
  sql`
    CREATE TRIGGER "NetWorthValueAmounts_refreshBuckets_ins_trg"
    AFTER INSERT ON "NetWorthValueAmounts"
    REFERENCING NEW TABLE AS new_rows
    FOR EACH STATEMENT EXECUTE FUNCTION "NetWorthEntryBuckets_refreshFromTrigger_fn"();
  `,
  { priority: 3 },
);

/** Wires `NetWorthEntryBuckets_refreshFromTrigger_fn` to `AFTER UPDATE` on `NetWorthValueAmounts`. */
export const NetWorthValueAmounts_refreshBuckets_upd_trg = pgCustomSQL(
  sql`
    CREATE TRIGGER "NetWorthValueAmounts_refreshBuckets_upd_trg"
    AFTER UPDATE ON "NetWorthValueAmounts"
    REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
    FOR EACH STATEMENT EXECUTE FUNCTION "NetWorthEntryBuckets_refreshFromTrigger_fn"();
  `,
  { priority: 3 },
);

/** Wires `NetWorthEntryBuckets_refreshFromTrigger_fn` to `AFTER DELETE` on `NetWorthValueAmounts`. */
export const NetWorthValueAmounts_refreshBuckets_del_trg = pgCustomSQL(
  sql`
    CREATE TRIGGER "NetWorthValueAmounts_refreshBuckets_del_trg"
    AFTER DELETE ON "NetWorthValueAmounts"
    REFERENCING OLD TABLE AS old_rows
    FOR EACH STATEMENT EXECUTE FUNCTION "NetWorthEntryBuckets_refreshFromTrigger_fn"();
  `,
  { priority: 3 },
);

/** Wires `NetWorthEntryBuckets_refreshFromTrigger_fn` to `AFTER INSERT` on `NetWorthCurrencyRates`. */
export const NetWorthCurrencyRates_refreshBuckets_ins_trg = pgCustomSQL(
  sql`
    CREATE TRIGGER "NetWorthCurrencyRates_refreshBuckets_ins_trg"
    AFTER INSERT ON "NetWorthCurrencyRates"
    REFERENCING NEW TABLE AS new_rows
    FOR EACH STATEMENT EXECUTE FUNCTION "NetWorthEntryBuckets_refreshFromTrigger_fn"();
  `,
  { priority: 3 },
);

/** Wires `NetWorthEntryBuckets_refreshFromTrigger_fn` to `AFTER UPDATE` on `NetWorthCurrencyRates`. */
export const NetWorthCurrencyRates_refreshBuckets_upd_trg = pgCustomSQL(
  sql`
    CREATE TRIGGER "NetWorthCurrencyRates_refreshBuckets_upd_trg"
    AFTER UPDATE ON "NetWorthCurrencyRates"
    REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
    FOR EACH STATEMENT EXECUTE FUNCTION "NetWorthEntryBuckets_refreshFromTrigger_fn"();
  `,
  { priority: 3 },
);

/** Wires `NetWorthEntryBuckets_refreshFromTrigger_fn` to `AFTER DELETE` on `NetWorthCurrencyRates`. */
export const NetWorthCurrencyRates_refreshBuckets_del_trg = pgCustomSQL(
  sql`
    CREATE TRIGGER "NetWorthCurrencyRates_refreshBuckets_del_trg"
    AFTER DELETE ON "NetWorthCurrencyRates"
    REFERENCING OLD TABLE AS old_rows
    FOR EACH STATEMENT EXECUTE FUNCTION "NetWorthEntryBuckets_refreshFromTrigger_fn"();
  `,
  { priority: 3 },
);

/** Wires `NetWorthEntryBuckets_refreshFromTrigger_fn` to `AFTER UPDATE` on `NetWorthCategoryAssets` — re-buckets every entry that holds a value in this asset when the asset's `type` changes. The trigger function guards on `type IS DISTINCT FROM` so unrelated column edits (`name`, `growthRate`, …) are no-ops. INSERT can't have referencing values yet; DELETE is blocked by `NetWorthValues.categoryAssetId ON DELETE RESTRICT`. Postgres forbids column-list (`OF type`) triggers when transition tables are referenced, hence the broader trigger event. */
export const NetWorthCategoryAssets_refreshBuckets_upd_trg = pgCustomSQL(
  sql`
    CREATE TRIGGER "NetWorthCategoryAssets_refreshBuckets_upd_trg"
    AFTER UPDATE ON "NetWorthCategoryAssets"
    REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
    FOR EACH STATEMENT EXECUTE FUNCTION "NetWorthEntryBuckets_refreshFromTrigger_fn"();
  `,
  { priority: 3 },
);

/** Wires `NetWorthEntryBuckets_refreshFromTrigger_fn` to `AFTER UPDATE` on `NetWorthCategoryLiabilities` — re-buckets every entry that holds a value in this liability when the liability's `skip` flag changes. The trigger function guards on `skip IS DISTINCT FROM` so unrelated column edits (`name`, `interestRate`, …) are no-ops. INSERT can't have referencing values yet; DELETE is blocked by `NetWorthValues.categoryLiabilityId ON DELETE RESTRICT`. Postgres forbids column-list (`OF skip`) triggers when transition tables are referenced, hence the broader trigger event. */
export const NetWorthCategoryLiabilities_refreshBuckets_upd_trg = pgCustomSQL(
  sql`
    CREATE TRIGGER "NetWorthCategoryLiabilities_refreshBuckets_upd_trg"
    AFTER UPDATE ON "NetWorthCategoryLiabilities"
    REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
    FOR EACH STATEMENT EXECUTE FUNCTION "NetWorthEntryBuckets_refreshFromTrigger_fn"();
  `,
  { priority: 3 },
);

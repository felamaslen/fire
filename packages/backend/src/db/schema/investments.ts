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
import { pgCustomSQL } from "drizzle-pgkit-migrator";

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
    /** Signed number of units traded. Positive = buy / DRIP, negative = sell. Floating-point — fractional units are supported (broker DRIP / fractional-share platforms commonly book non-integer counts). */
    units: doublePrecision("units").notNull(),
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

/** A cash inflow into a wrapper that does not originate from a planning cash account — e.g. dividend income paid into the wrapper, pension tax relief credited by HMRC, broker bonus. Combined with signed `PlanningTransactions` (cash → wrapper) and non-DRIP `InvestmentTransactions` (units bought / sold) to derive the wrapper's uninvested cash float. */
export const InvestmentDeposits = pgTable(
  "InvestmentDeposits",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    /** Wrapper this deposit lands in. Must reference a `STOCK` or `PENSION` asset — enforced in the resolver. */
    assetId: uuid("assetId")
      .notNull()
      .references(() => NetWorthCategoryAssets.id, { onDelete: "cascade" }),
    date: date("date", { mode: "date" }).notNull(),
    /** Signed amount in fractional units of `currency`. Positive = cash credited to the wrapper (the common case — dividend, tax relief). Negative = cash debited from the wrapper without a corresponding `InvestmentTransactions` row. */
    amount: bigint("amount", { mode: "number" }).notNull(),
    currency: currencyCode("currency").notNull(),
    name: text("name").notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("InvestmentDeposits_assetId_idx").on(t.assetId),
    index("InvestmentDeposits_date").on(t.date),
  ],
);

export const investmentDepositsRelations = relations(
  InvestmentDeposits,
  ({ one }) => ({
    asset: one(NetWorthCategoryAssets, {
      fields: [InvestmentDeposits.assetId],
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
    currency: currencyCode("currency").notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** `true` on the row with the greatest `date` per `investmentId`, `null` on every other row (nullable-`true` pattern so the partial unique index enforces "at most one latest per investment" without needing to store `false` on the other rows). Maintained by trigger — do not write directly. Lets the hot "what's the latest close for these N investments?" query hit the partial index directly instead of window-sorting the full history. Column position matches the migration that added it (`0024`) — keep last to avoid drift. */
    isLatest: boolean("isLatest"),
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

// The function bodies below match the migration text byte-for-byte — Postgres
// stores the body between the `$$` markers verbatim in `pg_proc.prosrc`, so
// any whitespace difference between the migrated and the schema.sql versions
// shows up as drift. Do not re-indent.

/** Returns `price` divided by the product of every stock-split ratio dated strictly after `p_date`, normalising the historical quote into today's post-split share-count terms. Used by `InvestmentPrices_setAdjusted_fn` and `InvestmentStockSplits_recomputePrices_fn` to maintain `InvestmentPrices.priceAdjusted`. */
// prettier-ignore
export const InvestmentPrices_computeAdjusted_fn = pgCustomSQL(
  sql`CREATE FUNCTION "InvestmentPrices_computeAdjusted"(
  p_investment_id uuid,
  p_date date,
  p_price double precision
) RETURNS double precision LANGUAGE sql STABLE AS $$
  SELECT p_price / COALESCE(
    (SELECT EXP(SUM(LN(ratio)))
     FROM "InvestmentStockSplits"
     WHERE "investmentId" = p_investment_id AND date > p_date)::double precision,
    1
  );
$$;`,
  { priority: 1 },
);

/** Per-row `BEFORE INSERT / UPDATE` trigger function on `InvestmentPrices` that overwrites `NEW."priceAdjusted"` with the freshly computed value. Any value supplied by the caller is discarded — `priceAdjusted` is derived, not authored. */
// prettier-ignore
export const InvestmentPrices_setAdjusted_fn = pgCustomSQL(
  sql`CREATE FUNCTION "InvestmentPrices_setAdjusted_fn"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."priceAdjusted" := "InvestmentPrices_computeAdjusted"(
    NEW."investmentId", NEW.date, NEW.price
  );
  RETURN NEW;
END;
$$;`,
  { priority: 2 },
);

/** Per-statement `AFTER INSERT / UPDATE / DELETE` trigger function on `InvestmentPrices` that maintains the `isLatest` flag (true on the row with the greatest `date` per `investmentId`, NULL elsewhere). Statement-level + transition tables to keep bulk inserts O(N) — see migration `0030` for the row-level → statement-level rationale. */
// prettier-ignore
export const InvestmentPrices_setIsLatest_stmt_fn = pgCustomSQL(
  sql`CREATE FUNCTION "InvestmentPrices_setIsLatest_stmt_fn"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  affected uuid[] := ARRAY[]::uuid[];
BEGIN
  -- The function re-enters via its own UPDATEs below. Without a column list
  -- (not permitted on transition-table triggers) the UPDATE trigger fires on
  -- every UPDATE including \`isLatest = …\`. Guard on \`pg_trigger_depth()\` so
  -- only the outermost call does any work.
  IF pg_trigger_depth() > 1 THEN
    RETURN NULL;
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    affected := affected || ARRAY(SELECT DISTINCT "investmentId" FROM new_rows);
  END IF;
  IF TG_OP IN ('DELETE', 'UPDATE') THEN
    affected := affected || ARRAY(SELECT DISTINCT "investmentId" FROM old_rows);
  END IF;
  IF cardinality(affected) = 0 THEN
    RETURN NULL;
  END IF;

  -- Clear every \`isLatest\` on the affected investments first so the partial
  -- unique index on \`(investmentId, isLatest) WHERE isLatest IS NOT NULL\`
  -- doesn't reject the second UPDATE below.
  UPDATE "InvestmentPrices"
  SET "isLatest" = NULL
  WHERE "investmentId" = ANY(affected) AND "isLatest" IS NOT NULL;

  UPDATE "InvestmentPrices" p
  SET "isLatest" = true
  FROM (
    SELECT DISTINCT ON ("investmentId") id
    FROM "InvestmentPrices"
    WHERE "investmentId" = ANY(affected)
    ORDER BY "investmentId", date DESC
  ) latest
  WHERE p.id = latest.id;

  RETURN NULL;
END;
$$;`,
  { priority: 2 },
);

/** Per-row `AFTER INSERT / UPDATE / DELETE` trigger function on `InvestmentStockSplits` that recomputes `priceAdjusted` for every `InvestmentPrices` row of the affected investment(s). Fires after split events because the multiplicative correction depends on later splits. */
// prettier-ignore
export const InvestmentStockSplits_recomputePrices_fn = pgCustomSQL(
  sql`CREATE FUNCTION "InvestmentStockSplits_recomputePrices_fn"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  affected uuid[] := ARRAY[]::uuid[];
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    affected := affected || NEW."investmentId";
  END IF;
  IF TG_OP IN ('DELETE', 'UPDATE') THEN
    affected := affected || OLD."investmentId";
  END IF;

  UPDATE "InvestmentPrices" p
  SET "priceAdjusted" = "InvestmentPrices_computeAdjusted"(p."investmentId", p.date, p.price)
  WHERE p."investmentId" = ANY(affected);

  RETURN NULL;
END;
$$;`,
  { priority: 2 },
);

/** Wires `InvestmentPrices_setAdjusted_fn` to `BEFORE INSERT / UPDATE` of `price`, `date`, `investmentId` on `InvestmentPrices`. */
export const InvestmentPrices_setAdjusted_trg = pgCustomSQL(
  sql`
    CREATE TRIGGER "InvestmentPrices_setAdjusted_trg"
    BEFORE INSERT OR UPDATE OF price, date, "investmentId" ON "InvestmentPrices"
    FOR EACH ROW EXECUTE FUNCTION "InvestmentPrices_setAdjusted_fn"();
  `,
  { priority: 3 },
);

/** Wires `InvestmentPrices_setIsLatest_stmt_fn` to `AFTER INSERT` on `InvestmentPrices`, with a `NEW` transition table. */
export const InvestmentPrices_setIsLatest_ins_trg = pgCustomSQL(
  sql`
    CREATE TRIGGER "InvestmentPrices_setIsLatest_ins_trg"
    AFTER INSERT ON "InvestmentPrices"
    REFERENCING NEW TABLE AS new_rows
    FOR EACH STATEMENT EXECUTE FUNCTION "InvestmentPrices_setIsLatest_stmt_fn"();
  `,
  { priority: 3 },
);

/** Wires `InvestmentPrices_setIsLatest_stmt_fn` to `AFTER UPDATE` on `InvestmentPrices`. Postgres forbids column lists on UPDATE triggers that use transition tables, so the trigger fires on every UPDATE and the function guards against unnecessary work. */
export const InvestmentPrices_setIsLatest_upd_trg = pgCustomSQL(
  sql`
    CREATE TRIGGER "InvestmentPrices_setIsLatest_upd_trg"
    AFTER UPDATE ON "InvestmentPrices"
    REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
    FOR EACH STATEMENT EXECUTE FUNCTION "InvestmentPrices_setIsLatest_stmt_fn"();
  `,
  { priority: 3 },
);

/** Wires `InvestmentPrices_setIsLatest_stmt_fn` to `AFTER DELETE` on `InvestmentPrices`, with an `OLD` transition table. */
export const InvestmentPrices_setIsLatest_del_trg = pgCustomSQL(
  sql`
    CREATE TRIGGER "InvestmentPrices_setIsLatest_del_trg"
    AFTER DELETE ON "InvestmentPrices"
    REFERENCING OLD TABLE AS old_rows
    FOR EACH STATEMENT EXECUTE FUNCTION "InvestmentPrices_setIsLatest_stmt_fn"();
  `,
  { priority: 3 },
);

/** Wires `InvestmentStockSplits_recomputePrices_fn` to `AFTER INSERT / UPDATE / DELETE` per row on `InvestmentStockSplits`. */
export const InvestmentStockSplits_recomputePrices_trg = pgCustomSQL(
  sql`
    CREATE TRIGGER "InvestmentStockSplits_recomputePrices_trg"
    AFTER INSERT OR UPDATE OR DELETE ON "InvestmentStockSplits"
    FOR EACH ROW EXECUTE FUNCTION "InvestmentStockSplits_recomputePrices_fn"();
  `,
  { priority: 3 },
);

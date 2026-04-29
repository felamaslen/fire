import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  doublePrecision,
  foreignKey,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { pgCustomSQL } from "drizzle-pgkit-migrator";

import { countryCode } from "./country";
import { currencyCode } from "./currency";
import {
  NetWorthCategoryAssets,
  NetWorthCategoryLiabilities,
} from "./net-worth";

/** A UK financial year identified by the starting calendar year (e.g. FY25/26 → 2025). */
export const PlanningYears = pgTable("PlanningYears", {
  /** Starting calendar year of the financial year (e.g. 2025 for FY25/26). */
  year: integer("year").primaryKey(),
  createdAt: timestamp("createdAt", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updatedAt", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const planningYearsRelations = relations(
  PlanningYears,
  ({ one, many }) => ({
    ukTaxRates: one(PlanningYearUKTaxRates, {
      fields: [PlanningYears.year],
      references: [PlanningYearUKTaxRates.year],
    }),
    months: many(PlanningMonths),
  }),
);

/** UK tax parameters for a planning year. All rates are decimal fractions (0–1); all thresholds are in fractional units of GBP (pence). */
export const PlanningYearUKTaxRates = pgTable(
  "PlanningYearUKTaxRates",
  {
    year: integer("year")
      .primaryKey()
      .references(() => PlanningYears.year, { onDelete: "cascade" }),
    /** Income-tax basic rate (e.g. 0.20). */
    rateBasic: doublePrecision("rateBasic").notNull(),
    /** Income-tax higher rate (e.g. 0.40). */
    rateHigher: doublePrecision("rateHigher").notNull(),
    /** Income-tax additional rate (e.g. 0.45). */
    rateAdditional: doublePrecision("rateAdditional").notNull(),
    /** Top of the basic-rate band, in fractional units of GBP. */
    thresholdBasic: bigint("thresholdBasic", { mode: "number" }).notNull(),
    /** Top of the higher-rate band, in fractional units of GBP. */
    thresholdHigher: bigint("thresholdHigher", { mode: "number" }).notNull(),
    /** Start of the additional-rate band, in fractional units of GBP. */
    thresholdAdditional: bigint("thresholdAdditional", {
      mode: "number",
    }).notNull(),
    /** Employee NIC main rate (between PT and UEL, e.g. 0.08). */
    rateNicMain: doublePrecision("rateNicMain").notNull(),
    /** Employee NIC additional rate (above UEL, e.g. 0.02). */
    rateNicAdditional: doublePrecision("rateNicAdditional").notNull(),
    /** NIC primary threshold (PT), in fractional units of GBP. */
    thresholdNicPrimary: bigint("thresholdNicPrimary", {
      mode: "number",
    }).notNull(),
    /** NIC upper earnings limit (UEL), in fractional units of GBP. */
    thresholdNicUpperEarnings: bigint("thresholdNicUpperEarnings", {
      mode: "number",
    }).notNull(),
    /** Student-loan plan 2 repayment rate (e.g. 0.09). */
    rateStudentLoanPlan2: doublePrecision("rateStudentLoanPlan2").notNull(),
    /** Student-loan plan 2 repayment threshold, in fractional units of GBP. */
    thresholdStudentLoanPlan2: bigint("thresholdStudentLoanPlan2", {
      mode: "number",
    }).notNull(),
    /** Income at which the personal allowance begins to taper (£1 withdrawn per £2 earned above this), in fractional units of GBP. */
    thresholdPersonalAllowanceTaper: bigint("thresholdPersonalAllowanceTaper", {
      mode: "number",
    }).notNull(),
    /** Statutory weekly rate for parental pay (`SMP` / `SPP` / `ShPP` / `SAP`), in fractional units of GBP. Used as the floor for parental-leave top-ups: actual weekly pay during a leave is at least `min(this rate, 90% of normal weekly gross)` when the leave is flagged as eligible. */
    statutoryParentalPayWeekly: bigint("statutoryParentalPayWeekly", {
      mode: "number",
    })
      .notNull()
      .default(18718),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "PlanningYearUKTaxRates_rateBasic_ck",
      sql`${t.rateBasic} BETWEEN 0 AND 1`,
    ),
    check(
      "PlanningYearUKTaxRates_rateHigher_ck",
      sql`${t.rateHigher} BETWEEN 0 AND 1`,
    ),
    check(
      "PlanningYearUKTaxRates_rateAdditional_ck",
      sql`${t.rateAdditional} BETWEEN 0 AND 1`,
    ),
    check(
      "PlanningYearUKTaxRates_rateNicMain_ck",
      sql`${t.rateNicMain} BETWEEN 0 AND 1`,
    ),
    check(
      "PlanningYearUKTaxRates_rateNicAdditional_ck",
      sql`${t.rateNicAdditional} BETWEEN 0 AND 1`,
    ),
    check(
      "PlanningYearUKTaxRates_rateStudentLoanPlan2_ck",
      sql`${t.rateStudentLoanPlan2} BETWEEN 0 AND 1`,
    ),
  ],
);

export const planningYearUKTaxRatesRelations = relations(
  PlanningYearUKTaxRates,
  ({ one }) => ({
    year: one(PlanningYears, {
      fields: [PlanningYearUKTaxRates.year],
      references: [PlanningYears.year],
    }),
  }),
);

/** A stream of gross earnings (salary, contract income, etc.), paid into a specific asset account. */
export const PlanningEarnings = pgTable(
  "PlanningEarnings",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    name: text("name").notNull(),
    /** First day this stream was/is in effect. */
    start: date("start", { mode: "date" }).notNull(),
    /** Last day this stream was/is in effect; null if ongoing. */
    end: date("end", { mode: "date" }),
    /** Gross earnings amount per pay period, in fractional units of `currency`. */
    amountGross: bigint("amountGross", { mode: "number" }).notNull(),
    currency: currencyCode("currency").notNull(),
    /** Country where the earnings are taxed. */
    countryCode: countryCode("countryCode").notNull(),
    /** Fraction of gross diverted via salary sacrifice (null if not used). */
    pensionSalarySacrifice: doublePrecision("pensionSalarySacrifice"),
    /** Fraction of gross contributed via relief-at-source (null if not used). */
    pensionReliefAtSource: doublePrecision("pensionReliefAtSource"),
    /** Fraction of gross contributed via net-pay arrangement (null if not used). */
    pensionNetPay: doublePrecision("pensionNetPay"),
    /** Whether the earner is repaying UK Student Loan plan 2 on this income. When false, no student-loan deduction is applied to predicted take-home. */
    studentLoanPlan2: boolean("studentLoanPlan2").notNull().default(false),
    /** Planning account the net earnings land in. */
    toAccountId: uuid("toAccountId")
      .notNull()
      .references(() => PlanningAccounts.accountId, { onDelete: "restrict" }),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Liability the predicted student-loan deduction pays down. Must be null unless `studentLoanPlan2` is true. Position matches migration `0005`. */
    studentLoanLiabilityId: uuid("studentLoanLiabilityId").references(
      () => NetWorthCategoryLiabilities.id,
      { onDelete: "set null" },
    ),
    /** Pension asset (`NetWorthCategoryAsset` of type `PENSION`) that predicted pension deductions (salary sacrifice / net pay / relief at source) contribute to. Must be null unless at least one pension fraction is set. Position matches migration `0026`. */
    pensionAssetId: uuid("pensionAssetId").references(
      () => NetWorthCategoryAssets.id,
      { onDelete: "set null" },
    ),
  },
  (t) => [
    check(
      "PlanningEarnings_dateRange_ck",
      sql`${t.end} IS NULL OR ${t.end} >= ${t.start}`,
    ),
    check(
      "PlanningEarnings_pensionSalarySacrifice_ck",
      sql`${t.pensionSalarySacrifice} IS NULL OR ${t.pensionSalarySacrifice} BETWEEN 0 AND 1`,
    ),
    check(
      "PlanningEarnings_pensionReliefAtSource_ck",
      sql`${t.pensionReliefAtSource} IS NULL OR ${t.pensionReliefAtSource} BETWEEN 0 AND 1`,
    ),
    check(
      "PlanningEarnings_pensionNetPay_ck",
      sql`${t.pensionNetPay} IS NULL OR ${t.pensionNetPay} BETWEEN 0 AND 1`,
    ),
    check(
      "PlanningEarnings_studentLoanLiability_ck",
      sql`${t.studentLoanLiabilityId} IS NULL OR ${t.studentLoanPlan2} = true`,
    ),
    check(
      "PlanningEarnings_pensionAsset_ck",
      sql`${t.pensionAssetId} IS NULL OR (${t.pensionSalarySacrifice} IS NOT NULL OR ${t.pensionNetPay} IS NOT NULL OR ${t.pensionReliefAtSource} IS NOT NULL)`,
    ),
  ],
);

export const planningEarningsRelations = relations(
  PlanningEarnings,
  ({ one, many }) => ({
    toAccount: one(PlanningAccounts, {
      fields: [PlanningEarnings.toAccountId],
      references: [PlanningAccounts.accountId],
    }),
    ukTaxCodes: many(PlanningEarningsUKTaxCodes),
    parentalLeaves: many(PlanningEarningsParentalLeave),
  }),
);

/** UK tax codes in effect for a PlanningEarnings over a date range. The active code alters the personal allowance when projecting PAYE withholding. Composite PK on (earnings, start) — each stream has at most one code active starting on any given day. */
export const PlanningEarningsUKTaxCodes = pgTable(
  "PlanningEarningsUKTaxCodes",
  {
    earningsId: uuid("earningsId")
      .notNull()
      .references(() => PlanningEarnings.id, { onDelete: "cascade" }),
    /** First day this tax code applies. */
    start: date("start", { mode: "date" }).notNull(),
    /** Last day this tax code applies (inclusive); null while the code is ongoing. */
    end: date("end", { mode: "date" }),
    /** HMRC tax code as issued (e.g. `1257L`, `3420X`). */
    taxCode: text("taxCode").notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({
      name: "PlanningEarningsUKTaxCodes_pk",
      columns: [t.earningsId, t.start],
    }),
    check(
      "PlanningEarningsUKTaxCodes_dateRange_ck",
      sql`${t.end} IS NULL OR ${t.end} >= ${t.start}`,
    ),
  ],
);

export const planningEarningsUKTaxCodesRelations = relations(
  PlanningEarningsUKTaxCodes,
  ({ one }) => ({
    earnings: one(PlanningEarnings, {
      fields: [PlanningEarningsUKTaxCodes.earningsId],
      references: [PlanningEarnings.id],
    }),
  }),
);

/** Parental-leave periods for a `PlanningEarnings`. Each row represents a single stage of a leave at a constant pay level — an enhanced employer scheme is modelled as several rows in sequence (e.g. 6 weeks at `0.9`, then 33 weeks at `0.0` with `isSMP = true`, then 13 weeks unpaid). Composite PK on (earnings, start) — at most one stage may begin on any given day. During a stage the effective weekly pay is `max(fractionOfGross × normalWeekly, statutoryFloor)` where `statutoryFloor = min(year.statutoryParentalPayWeekly, 0.9 × normalWeekly)` when `isSMP` or `isSPP` is set, else `0`. The two flags are mutually exclusive — `SMP` for maternity / shared parental / adoption eligibility, `SPP` for paternity. */
export const PlanningEarningsParentalLeave = pgTable(
  "PlanningEarningsParentalLeave",
  {
    earningsId: uuid("earningsId")
      .notNull()
      .references(() => PlanningEarnings.id, { onDelete: "cascade" }),
    /** First day this stage applies. */
    start: date("start", { mode: "date" }).notNull(),
    /** Last day this stage applies (inclusive); null while the stage is ongoing. */
    end: date("end", { mode: "date" }),
    /** Fraction of the earning's normal gross paid during this stage, in `[0, 1]`. `0` = unpaid, `1` = full pay. The statutory floor (when `isSMP` / `isSPP` is set) may raise the effective pay above this. */
    fractionOfGross: doublePrecision("fractionOfGross").notNull(),
    /** Whether this stage qualifies for Statutory Maternity Pay (also covers Shared Parental Pay and Statutory Adoption Pay — they share a weekly rate). When set, the statutory floor applies. */
    isSMP: boolean("isSMP").notNull().default(false),
    /** Whether this stage qualifies for Statutory Paternity Pay. When set, the statutory floor applies. */
    isSPP: boolean("isSPP").notNull().default(false),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({
      name: "PlanningEarningsParentalLeave_pk",
      columns: [t.earningsId, t.start],
    }),
    check(
      "PlanningEarningsParentalLeave_dateRange_ck",
      sql`${t.end} IS NULL OR ${t.end} >= ${t.start}`,
    ),
    check(
      "PlanningEarningsParentalLeave_fractionOfGross_ck",
      sql`${t.fractionOfGross} BETWEEN 0 AND 1`,
    ),
    check(
      "PlanningEarningsParentalLeave_eligibility_ck",
      sql`NOT (${t.isSMP} AND ${t.isSPP})`,
    ),
  ],
);

export const planningEarningsParentalLeaveRelations = relations(
  PlanningEarningsParentalLeave,
  ({ one }) => ({
    earnings: one(PlanningEarnings, {
      fields: [PlanningEarningsParentalLeave.earningsId],
      references: [PlanningEarnings.id],
    }),
  }),
);

/** Planning-specific metadata attached to an existing NetWorthCategoryAsset. The PK is the underlying asset's id; rows in other planning tables (bills, earnings, payslips, transactions) FK to this table so the referenced asset is guaranteed to have a planning account attached. */
export const PlanningAccounts = pgTable("PlanningAccounts", {
  /** Underlying asset this planning account wraps. */
  accountId: uuid("accountId")
    .primaryKey()
    .references(() => NetWorthCategoryAssets.id, { onDelete: "cascade" }),
  /** Short display name used in planning views (null falls back to the asset name). */
  alias: text("alias"),
  createdAt: timestamp("createdAt", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updatedAt", { withTimezone: true })
    .notNull()
    .defaultNow(),
  /** Position in the user-defined ordering of planning accounts (0-based, dense). Enforced unique + deferrable in SQL so a multi-row shift inside one transaction can swap values without tripping the constraint mid-way. Position matches migration `0029`. */
  sortOrder: integer("sortOrder").notNull().default(0),
});

export const planningAccountsRelations = relations(
  PlanningAccounts,
  ({ one }) => ({
    asset: one(NetWorthCategoryAssets, {
      fields: [PlanningAccounts.accountId],
      references: [NetWorthCategoryAssets.id],
    }),
  }),
);

/** Deferrable unique on `PlanningAccounts.sortOrder` so a multi-row reorder inside one transaction can pass through intermediate duplicates that resolve by commit. Drizzle's `unique()` doesn't model `DEFERRABLE INITIALLY DEFERRED`, so it lives as raw SQL. */
export const PlanningAccounts_sortOrder_uq = pgCustomSQL(
  sql`
    ALTER TABLE "PlanningAccounts"
      ADD CONSTRAINT "PlanningAccounts_sortOrder_uq" UNIQUE ("sortOrder")
      DEFERRABLE INITIALLY DEFERRED;
  `,
  { priority: 1 },
);

/** A month within a planning year (day-of-month is not significant). */
export const PlanningMonths = pgTable(
  "PlanningMonths",
  {
    year: integer("year")
      .notNull()
      .references(() => PlanningYears.year, { onDelete: "cascade" }),
    /** Any calendar day inside the target month. */
    date: date("date", { mode: "date" }).notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({
      name: "PlanningMonths_pk",
      columns: [t.year, t.date],
    }),
    uniqueIndex("PlanningMonths_year_month_uq").on(
      t.year,
      sql`date_trunc('month', ${t.date}::timestamp)`,
    ),
  ],
);

export const planningMonthsRelations = relations(
  PlanningMonths,
  ({ one, many }) => ({
    planningYear: one(PlanningYears, {
      fields: [PlanningMonths.year],
      references: [PlanningYears.year],
    }),
    transactions: many(PlanningTransactions),
    billOverrides: many(PlanningMonthBills),
  }),
);

/** A one-off planned transaction slotted into a specific month. */
export const PlanningTransactions = pgTable(
  "PlanningTransactions",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    year: integer("year").notNull(),
    date: date("date", { mode: "date" }).notNull(),
    /** Signed amount in fractional units of `currency`. Negative = outflow debited from `accountId` (optionally credited to `toAccountId`). Positive = ad-hoc inflow credited to `accountId` (no source account). */
    amount: bigint("amount", { mode: "number" }).notNull(),
    currency: currencyCode("currency").notNull(),
    name: text("name").notNull(),
    /** Primary planning account. Debited when `amount < 0` (outflow / transfer) or credited when `amount > 0` (ad-hoc inflow). */
    accountId: uuid("accountId")
      .notNull()
      .references(() => PlanningAccounts.accountId, { onDelete: "restrict" }),
    /** Destination planning account for a transfer; null if it's an external outflow. Only valid for outflows (`amount < 0`). */
    toAccountId: uuid("toAccountId").references(
      () => PlanningAccounts.accountId,
      { onDelete: "restrict" },
    ),
    /** Liability this transaction pays down, if any. Only valid for outflows (`amount < 0`). Mutually exclusive with `assetId`. */
    liabilityId: uuid("liabilityId").references(
      () => NetWorthCategoryLiabilities.id,
      { onDelete: "restrict" },
    ),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Asset (stock or pension) this transaction invests into, if any. Only valid for outflows (`amount < 0`). Mutually exclusive with `liabilityId`; asset type (STOCK / PENSION) is validated in the resolver. Position matches migration `0008`. */
    assetId: uuid("assetId").references(() => NetWorthCategoryAssets.id, {
      onDelete: "restrict",
    }),
  },
  (t) => [
    foreignKey({
      name: "PlanningTransactions_month_fk",
      columns: [t.year, t.date],
      foreignColumns: [PlanningMonths.year, PlanningMonths.date],
    }).onDelete("cascade"),
    check(
      "PlanningTransactions_accounts_ck",
      sql`${t.toAccountId} IS NULL OR ${t.accountId} <> ${t.toAccountId}`,
    ),
    check(
      "PlanningTransactions_inflow_ck",
      sql`${t.amount} <= 0
           OR (${t.toAccountId} IS NULL AND ${t.liabilityId} IS NULL AND ${t.assetId} IS NULL)`,
    ),
    check(
      "PlanningTransactions_liabilityAssetExclusive_ck",
      sql`${t.liabilityId} IS NULL OR ${t.assetId} IS NULL`,
    ),
  ],
);

export const planningTransactionsRelations = relations(
  PlanningTransactions,
  ({ one }) => ({
    month: one(PlanningMonths, {
      fields: [PlanningTransactions.year, PlanningTransactions.date],
      references: [PlanningMonths.year, PlanningMonths.date],
    }),
    account: one(PlanningAccounts, {
      fields: [PlanningTransactions.accountId],
      references: [PlanningAccounts.accountId],
      relationName: "transactionsPrimary",
    }),
    toAccount: one(PlanningAccounts, {
      fields: [PlanningTransactions.toAccountId],
      references: [PlanningAccounts.accountId],
      relationName: "transactionsTo",
    }),
    liability: one(NetWorthCategoryLiabilities, {
      fields: [PlanningTransactions.liabilityId],
      references: [NetWorthCategoryLiabilities.id],
    }),
    asset: one(NetWorthCategoryAssets, {
      fields: [PlanningTransactions.assetId],
      references: [NetWorthCategoryAssets.id],
    }),
  }),
);

/** How often a PlanningBill recurs. */
export const planningBillsFrequency = pgEnum("planningBillsFrequency", [
  "MONTHLY",
  "QUARTERLY",
  "YEARLY",
]);

/** A recurring bill (subscription, utility, etc.) paid from an asset account. */
export const PlanningBills = pgTable(
  "PlanningBills",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    /** First day this bill is/was in effect. */
    start: date("start", { mode: "date" }).notNull(),
    /** Last day this bill is/was in effect; null if ongoing. */
    end: date("end", { mode: "date" }),
    frequency: planningBillsFrequency("frequency").notNull(),
    /**
     * When the bill is collected, encoded per frequency:
     * - MONTHLY: a day-of-month as a bare number (`"15"`, `"31"`).
     * - QUARTERLY: four comma-separated `M-D` entries, one per quarter (`"2-04, 5-05, 8-01, 11-03"`).
     * - YEARLY: one `M-D` entry (`"3-07"`).
     * SQL enforces the overall shape; resolvers validate ranges.
     */
    collectionDate: text("collectionDate").notNull(),
    /** Amount per occurrence, in fractional units of `currency`. */
    amount: bigint("amount", { mode: "number" }).notNull(),
    currency: currencyCode("currency").notNull(),
    name: text("name").notNull(),
    /** Planning account the bill is paid from. */
    fromAccountId: uuid("fromAccountId")
      .notNull()
      .references(() => PlanningAccounts.accountId, { onDelete: "restrict" }),
    /** Liability this bill services, if any (e.g. mortgage direct debit). */
    liabilityId: uuid("liabilityId").references(
      () => NetWorthCategoryLiabilities.id,
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
      "PlanningBills_dateRange_ck",
      sql`${t.end} IS NULL OR ${t.end} >= ${t.start}`,
    ),
    check(
      "PlanningBills_collectionDate_ck",
      sql`(${t.frequency} = 'MONTHLY' AND ${t.collectionDate} ~ '^[0-9]+$')
           OR (${t.frequency} = 'QUARTERLY' AND ${t.collectionDate} ~ '^[0-9]+-[0-9]+(, ?[0-9]+-[0-9]+){3}$')
           OR (${t.frequency} = 'YEARLY' AND ${t.collectionDate} ~ '^[0-9]+-[0-9]+$')`,
    ),
  ],
);

export const planningBillsRelations = relations(
  PlanningBills,
  ({ one, many }) => ({
    fromAccount: one(PlanningAccounts, {
      fields: [PlanningBills.fromAccountId],
      references: [PlanningAccounts.accountId],
    }),
    liability: one(NetWorthCategoryLiabilities, {
      fields: [PlanningBills.liabilityId],
      references: [NetWorthCategoryLiabilities.id],
    }),
    monthOverrides: many(PlanningMonthBills),
  }),
);

/** Per-month override for a PlanningBill. If a row exists the bill is NOT provisional for that month; `amount` null means the bill is skipped. */
export const PlanningMonthBills = pgTable(
  "PlanningMonthBills",
  {
    year: integer("year").notNull(),
    date: date("date", { mode: "date" }).notNull(),
    billId: uuid("billId")
      .notNull()
      .references(() => PlanningBills.id, { onDelete: "cascade" }),
    /** Override amount in fractional units of `currency`; null means the bill is skipped this month. */
    amount: bigint("amount", { mode: "number" }),
    currency: currencyCode("currency"),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({
      name: "PlanningMonthBills_pk",
      columns: [t.year, t.date, t.billId],
    }),
    foreignKey({
      name: "PlanningMonthBills_month_fk",
      columns: [t.year, t.date],
      foreignColumns: [PlanningMonths.year, PlanningMonths.date],
    }).onDelete("cascade"),
    check(
      "PlanningMonthBills_amountCurrency_ck",
      sql`(${t.amount} IS NULL) = (${t.currency} IS NULL)`,
    ),
  ],
);

export const planningMonthBillsRelations = relations(
  PlanningMonthBills,
  ({ one }) => ({
    bill: one(PlanningBills, {
      fields: [PlanningMonthBills.billId],
      references: [PlanningBills.id],
    }),
    month: one(PlanningMonths, {
      fields: [PlanningMonthBills.year, PlanningMonthBills.date],
      references: [PlanningMonths.year, PlanningMonths.date],
    }),
  }),
);

/** A recorded payslip — one pay-period snapshot, paid into an asset account. */
export const PlanningPayslips = pgTable("PlanningPayslips", {
  id: uuid("id")
    .primaryKey()
    .default(sql`uuidv7()`),
  /** Pay date. */
  date: date("date", { mode: "date" }).notNull(),
  /** Gross pay for the period, in fractional units of `currency`. */
  amountGross: bigint("amountGross", { mode: "number" }).notNull(),
  currency: currencyCode("currency").notNull(),
  name: text("name").notNull(),
  /** Planning account the net pay lands in. */
  toAccountId: uuid("toAccountId")
    .notNull()
    .references(() => PlanningAccounts.accountId, { onDelete: "restrict" }),
  /** Optional link to the payslip PDF/document. */
  fileUrl: text("fileUrl"),
  createdAt: timestamp("createdAt", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updatedAt", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const planningPayslipsRelations = relations(
  PlanningPayslips,
  ({ one, many }) => ({
    toAccount: one(PlanningAccounts, {
      fields: [PlanningPayslips.toAccountId],
      references: [PlanningAccounts.accountId],
    }),
    adjustments: many(PlanningPayslipAdjustments),
  }),
);

/** A single line on a payslip (tax, NI, bonus, ...). `amount` is signed; negative means a deduction. */
export const PlanningPayslipAdjustments = pgTable(
  "PlanningPayslipAdjustments",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    payslipId: uuid("payslipId")
      .notNull()
      .references(() => PlanningPayslips.id, { onDelete: "cascade" }),
    /** Signed amount in fractional units of the payslip's currency; negative = deduction. */
    amount: bigint("amount", { mode: "number" }).notNull(),
    name: text("name").notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Optional link to a liability this adjustment pays down (e.g. a loan or student loan repayment). Cleared if the liability is deleted. Position matches the migration that added it. */
    liabilityId: uuid("liabilityId").references(
      () => NetWorthCategoryLiabilities.id,
      { onDelete: "set null" },
    ),
  },
);

export const planningPayslipAdjustmentsRelations = relations(
  PlanningPayslipAdjustments,
  ({ one }) => ({
    payslip: one(PlanningPayslips, {
      fields: [PlanningPayslipAdjustments.payslipId],
      references: [PlanningPayslips.id],
    }),
    liability: one(NetWorthCategoryLiabilities, {
      fields: [PlanningPayslipAdjustments.liabilityId],
      references: [NetWorthCategoryLiabilities.id],
    }),
  }),
);

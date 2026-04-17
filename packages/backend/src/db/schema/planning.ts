import { relations, sql } from "drizzle-orm";
import {
  bigint,
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

/** UK tax parameters for a planning year. All rates are decimal fractions (0–1); all thresholds are in minor units of GBP (pence). */
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
    /** Top of the basic-rate band, in minor units of GBP. */
    thresholdBasic: bigint("thresholdBasic", { mode: "number" }).notNull(),
    /** Top of the higher-rate band, in minor units of GBP. */
    thresholdHigher: bigint("thresholdHigher", { mode: "number" }).notNull(),
    /** Start of the additional-rate band, in minor units of GBP. */
    thresholdAdditional: bigint("thresholdAdditional", {
      mode: "number",
    }).notNull(),
    /** Employee NIC main rate (between PT and UEL, e.g. 0.08). */
    rateNicMain: doublePrecision("rateNicMain").notNull(),
    /** Employee NIC additional rate (above UEL, e.g. 0.02). */
    rateNicAdditional: doublePrecision("rateNicAdditional").notNull(),
    /** NIC primary threshold (PT), in minor units of GBP. */
    thresholdNicPrimary: bigint("thresholdNicPrimary", {
      mode: "number",
    }).notNull(),
    /** NIC upper earnings limit (UEL), in minor units of GBP. */
    thresholdNicUpperEarnings: bigint("thresholdNicUpperEarnings", {
      mode: "number",
    }).notNull(),
    /** Student-loan plan 2 repayment rate (e.g. 0.09). */
    rateStudentLoanPlan2: doublePrecision("rateStudentLoanPlan2").notNull(),
    /** Student-loan plan 2 repayment threshold, in minor units of GBP. */
    thresholdStudentLoanPlan2: bigint("thresholdStudentLoanPlan2", {
      mode: "number",
    }).notNull(),
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
    /** Gross earnings amount per pay period, in minor units of `currency`. */
    amountGross: bigint("amountGross", { mode: "number" }).notNull(),
    currency: currencyCode("currency").notNull(),
    /** Country where the earnings are taxed. */
    countryCode: countryCode("countryCode").notNull(),
    /** Fraction of gross diverted via salary sacrifice (null if not used). */
    pensionSalarySacrifice: doublePrecision("pensionSalarySacrifice"),
    /** Fraction of gross contributed via relief-at-source. */
    pensionReliefAtSource: doublePrecision("pensionReliefAtSource").notNull(),
    /** Fraction of gross contributed via net-pay arrangement. */
    pensionNetPay: doublePrecision("pensionNetPay").notNull(),
    /** Asset account the net earnings land in. */
    accountIdTo: uuid("accountIdTo")
      .notNull()
      .references(() => NetWorthCategoryAssets.id, { onDelete: "restrict" }),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
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
      sql`${t.pensionReliefAtSource} BETWEEN 0 AND 1`,
    ),
    check(
      "PlanningEarnings_pensionNetPay_ck",
      sql`${t.pensionNetPay} BETWEEN 0 AND 1`,
    ),
  ],
);

export const planningEarningsRelations = relations(
  PlanningEarnings,
  ({ one }) => ({
    accountTo: one(NetWorthCategoryAssets, {
      fields: [PlanningEarnings.accountIdTo],
      references: [NetWorthCategoryAssets.id],
    }),
  }),
);

/** Planning-specific metadata attached to an existing NetWorthCategoryAsset. */
export const PlanningAccounts = pgTable("PlanningAccounts", {
  /** Asset account this planning metadata is attached to. */
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
});

export const planningAccountsRelations = relations(
  PlanningAccounts,
  ({ one, many }) => ({
    account: one(NetWorthCategoryAssets, {
      fields: [PlanningAccounts.accountId],
      references: [NetWorthCategoryAssets.id],
    }),
    transactionsFrom: many(PlanningTransactions, {
      relationName: "transactionsFrom",
    }),
    transactionsTo: many(PlanningTransactions, {
      relationName: "transactionsTo",
    }),
  }),
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
    /** Amount in minor units of `currency`. */
    amount: bigint("amount", { mode: "number" }).notNull(),
    currency: currencyCode("currency").notNull(),
    name: text("name").notNull(),
    accountIdFrom: uuid("accountIdFrom")
      .notNull()
      .references(() => PlanningAccounts.accountId, { onDelete: "restrict" }),
    /** Destination account if this is a transfer; null if it's an external outflow. */
    accountIdTo: uuid("accountIdTo").references(
      () => PlanningAccounts.accountId,
      { onDelete: "restrict" },
    ),
    /** Liability this transaction pays down, if any. */
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
    foreignKey({
      name: "PlanningTransactions_month_fk",
      columns: [t.year, t.date],
      foreignColumns: [PlanningMonths.year, PlanningMonths.date],
    }).onDelete("cascade"),
    check(
      "PlanningTransactions_accounts_ck",
      sql`${t.accountIdTo} IS NULL OR ${t.accountIdFrom} <> ${t.accountIdTo}`,
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
    accountFrom: one(PlanningAccounts, {
      fields: [PlanningTransactions.accountIdFrom],
      references: [PlanningAccounts.accountId],
      relationName: "transactionsFrom",
    }),
    accountTo: one(PlanningAccounts, {
      fields: [PlanningTransactions.accountIdTo],
      references: [PlanningAccounts.accountId],
      relationName: "transactionsTo",
    }),
    liability: one(NetWorthCategoryLiabilities, {
      fields: [PlanningTransactions.liabilityId],
      references: [NetWorthCategoryLiabilities.id],
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
    /** Amount per occurrence, in minor units of `currency`. */
    amount: bigint("amount", { mode: "number" }).notNull(),
    currency: currencyCode("currency").notNull(),
    name: text("name").notNull(),
    accountIdFrom: uuid("accountIdFrom")
      .notNull()
      .references(() => NetWorthCategoryAssets.id, { onDelete: "restrict" }),
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
  ],
);

export const planningBillsRelations = relations(PlanningBills, ({ one }) => ({
  accountFrom: one(NetWorthCategoryAssets, {
    fields: [PlanningBills.accountIdFrom],
    references: [NetWorthCategoryAssets.id],
  }),
  liability: one(NetWorthCategoryLiabilities, {
    fields: [PlanningBills.liabilityId],
    references: [NetWorthCategoryLiabilities.id],
  }),
}));

/** A recorded payslip — one pay-period snapshot, paid into an asset account. */
export const PlanningPayslips = pgTable("PlanningPayslips", {
  id: uuid("id")
    .primaryKey()
    .default(sql`uuidv7()`),
  /** Pay date. */
  date: date("date", { mode: "date" }).notNull(),
  /** Gross pay for the period, in minor units of `currency`. */
  amountGross: bigint("amountGross", { mode: "number" }).notNull(),
  currency: currencyCode("currency").notNull(),
  name: text("name").notNull(),
  /** Asset account the net pay lands in. */
  accountIdTo: uuid("accountIdTo")
    .notNull()
    .references(() => NetWorthCategoryAssets.id, { onDelete: "restrict" }),
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
    accountTo: one(NetWorthCategoryAssets, {
      fields: [PlanningPayslips.accountIdTo],
      references: [NetWorthCategoryAssets.id],
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
    /** Signed amount in minor units of the payslip's currency; negative = deduction. */
    amount: bigint("amount", { mode: "number" }).notNull(),
    name: text("name").notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
);

export const planningPayslipAdjustmentsRelations = relations(
  PlanningPayslipAdjustments,
  ({ one }) => ({
    payslip: one(PlanningPayslips, {
      fields: [PlanningPayslipAdjustments.payslipId],
      references: [PlanningPayslips.id],
    }),
  }),
);

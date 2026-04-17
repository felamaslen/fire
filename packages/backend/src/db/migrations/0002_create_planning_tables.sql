CREATE TYPE "public"."CountryCode" AS ENUM ('GB'); -- > statement-breakpoint
CREATE TYPE "public"."planningBillsFrequency" AS ENUM (
  'MONTHLY',
  'QUARTERLY',
  'YEARLY'
); -- > statement-breakpoint
CREATE TABLE "PlanningAccounts" (
  "accountId" uuid PRIMARY KEY NOT NULL,
  "alias" text,
  "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL
);
-- > statement-breakpoint
CREATE TABLE "PlanningBills" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "start" date NOT NULL,
  "end" date,
  "frequency" "planningBillsFrequency" NOT NULL,
  "collectionDate" text NOT NULL,
  "amount" BIGINT NOT NULL,
  "currency" "CurrencyCode" NOT NULL,
  "name" text NOT NULL,
  "accountIdFrom" uuid NOT NULL,
  "liabilityId" uuid,
  "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  CONSTRAINT "PlanningBills_dateRange_ck"
    CHECK (
      "PlanningBills"."end" IS NULL
      OR "PlanningBills"."end" >= "PlanningBills"."start"
    ),
  CONSTRAINT "PlanningBills_collectionDate_ck"
    CHECK (
      (
        "PlanningBills"."frequency" = 'MONTHLY'
        AND "PlanningBills"."collectionDate" ~ '^[0-9]+$'
      )
      OR (
        "PlanningBills"."frequency" = 'QUARTERLY'
        AND "PlanningBills"."collectionDate" ~ '^[0-9]+-[0-9]+(, ?[0-9]+-[0-9]+){3}$'
      )
      OR (
        "PlanningBills"."frequency" = 'YEARLY'
        AND "PlanningBills"."collectionDate" ~ '^[0-9]+-[0-9]+$'
      )
    )
);
-- > statement-breakpoint
CREATE TABLE "PlanningEarnings" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "name" text NOT NULL,
  "start" date NOT NULL,
  "end" date,
  "amountGross" BIGINT NOT NULL,
  "currency" "CurrencyCode" NOT NULL,
  "countryCode" "CountryCode" NOT NULL,
  "pensionSalarySacrifice" DOUBLE PRECISION,
  "pensionReliefAtSource" DOUBLE PRECISION NOT NULL,
  "pensionNetPay" DOUBLE PRECISION NOT NULL,
  "accountIdTo" uuid NOT NULL,
  "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  CONSTRAINT "PlanningEarnings_dateRange_ck"
    CHECK (
      "PlanningEarnings"."end" IS NULL
      OR "PlanningEarnings"."end" >= "PlanningEarnings"."start"
    ),
  CONSTRAINT "PlanningEarnings_pensionSalarySacrifice_ck"
    CHECK (
      "PlanningEarnings"."pensionSalarySacrifice" IS NULL
      OR "PlanningEarnings"."pensionSalarySacrifice" BETWEEN 0 AND 1
    ),
  CONSTRAINT "PlanningEarnings_pensionReliefAtSource_ck"
    CHECK ("PlanningEarnings"."pensionReliefAtSource" BETWEEN 0 AND 1),
  CONSTRAINT "PlanningEarnings_pensionNetPay_ck"
    CHECK ("PlanningEarnings"."pensionNetPay" BETWEEN 0 AND 1)
);
-- > statement-breakpoint
CREATE TABLE "PlanningMonthBills" (
  "year" INTEGER NOT NULL,
  "date" date NOT NULL,
  "billId" uuid NOT NULL,
  "amount" BIGINT,
  "currency" "CurrencyCode",
  "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  CONSTRAINT "PlanningMonthBills_pk" PRIMARY KEY ("year", "date", "billId"),
  CONSTRAINT "PlanningMonthBills_amountCurrency_ck"
    CHECK (
      ("PlanningMonthBills"."amount" IS NULL) = (
        "PlanningMonthBills"."currency" IS NULL
      )
    )
);
-- > statement-breakpoint
CREATE TABLE "PlanningMonths" (
  "year" INTEGER NOT NULL,
  "date" date NOT NULL,
  "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  CONSTRAINT "PlanningMonths_pk" PRIMARY KEY ("year", "date")
);
-- > statement-breakpoint
CREATE TABLE "PlanningPayslipAdjustments" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "payslipId" uuid NOT NULL,
  "amount" BIGINT NOT NULL,
  "name" text NOT NULL,
  "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL
);
-- > statement-breakpoint
CREATE TABLE "PlanningPayslips" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "date" date NOT NULL,
  "amountGross" BIGINT NOT NULL,
  "currency" "CurrencyCode" NOT NULL,
  "name" text NOT NULL,
  "accountIdTo" uuid NOT NULL,
  "fileUrl" text,
  "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL
);
-- > statement-breakpoint
CREATE TABLE "PlanningTransactions" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "year" INTEGER NOT NULL,
  "date" date NOT NULL,
  "amount" BIGINT NOT NULL,
  "currency" "CurrencyCode" NOT NULL,
  "name" text NOT NULL,
  "accountIdFrom" uuid NOT NULL,
  "accountIdTo" uuid,
  "liabilityId" uuid,
  "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  CONSTRAINT "PlanningTransactions_accounts_ck"
    CHECK (
      "PlanningTransactions"."accountIdTo" IS NULL
      OR "PlanningTransactions"."accountIdFrom" != "PlanningTransactions"."accountIdTo"
    )
);
-- > statement-breakpoint
CREATE TABLE "PlanningYearUKTaxRates" (
  "year" INTEGER PRIMARY KEY NOT NULL,
  "rateBasic" DOUBLE PRECISION NOT NULL,
  "rateHigher" DOUBLE PRECISION NOT NULL,
  "rateAdditional" DOUBLE PRECISION NOT NULL,
  "thresholdBasic" BIGINT NOT NULL,
  "thresholdHigher" BIGINT NOT NULL,
  "thresholdAdditional" BIGINT NOT NULL,
  "rateNicMain" DOUBLE PRECISION NOT NULL,
  "rateNicAdditional" DOUBLE PRECISION NOT NULL,
  "thresholdNicPrimary" BIGINT NOT NULL,
  "thresholdNicUpperEarnings" BIGINT NOT NULL,
  "rateStudentLoanPlan2" DOUBLE PRECISION NOT NULL,
  "thresholdStudentLoanPlan2" BIGINT NOT NULL,
  "thresholdPersonalAllowanceTaper" BIGINT NOT NULL,
  "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  CONSTRAINT "PlanningYearUKTaxRates_rateBasic_ck"
    CHECK ("PlanningYearUKTaxRates"."rateBasic" BETWEEN 0 AND 1),
  CONSTRAINT "PlanningYearUKTaxRates_rateHigher_ck"
    CHECK ("PlanningYearUKTaxRates"."rateHigher" BETWEEN 0 AND 1),
  CONSTRAINT "PlanningYearUKTaxRates_rateAdditional_ck"
    CHECK ("PlanningYearUKTaxRates"."rateAdditional" BETWEEN 0 AND 1),
  CONSTRAINT "PlanningYearUKTaxRates_rateNicMain_ck"
    CHECK ("PlanningYearUKTaxRates"."rateNicMain" BETWEEN 0 AND 1),
  CONSTRAINT "PlanningYearUKTaxRates_rateNicAdditional_ck"
    CHECK ("PlanningYearUKTaxRates"."rateNicAdditional" BETWEEN 0 AND 1),
  CONSTRAINT "PlanningYearUKTaxRates_rateStudentLoanPlan2_ck"
    CHECK ("PlanningYearUKTaxRates"."rateStudentLoanPlan2" BETWEEN 0 AND 1)
);
-- > statement-breakpoint
CREATE TABLE "PlanningYears" (
  "year" INTEGER PRIMARY KEY NOT NULL,
  "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL
);
-- > statement-breakpoint
ALTER TABLE "PlanningAccounts"
ADD CONSTRAINT "PlanningAccounts_accountId_NetWorthCategoryAssets_id_fk"
  FOREIGN KEY ("accountId") REFERENCES "public"."NetWorthCategoryAssets" ("id")
    ON DELETE CASCADE
    ON UPDATE NO ACTION; -- > statement-breakpoint
ALTER TABLE "PlanningBills"
ADD CONSTRAINT "PlanningBills_accountIdFrom_NetWorthCategoryAssets_id_fk"
  FOREIGN KEY ("accountIdFrom") REFERENCES "public"."NetWorthCategoryAssets" (
    "id"
  )
    ON DELETE RESTRICT
    ON UPDATE NO ACTION; -- > statement-breakpoint
ALTER TABLE "PlanningBills"
ADD CONSTRAINT "PlanningBills_liabilityId_NetWorthCategoryLiabilities_id_fk"
  FOREIGN KEY (
    "liabilityId"
  ) REFERENCES "public"."NetWorthCategoryLiabilities" ("id")
    ON DELETE RESTRICT
    ON UPDATE NO ACTION; -- > statement-breakpoint
ALTER TABLE "PlanningEarnings"
ADD CONSTRAINT "PlanningEarnings_accountIdTo_NetWorthCategoryAssets_id_fk"
  FOREIGN KEY ("accountIdTo") REFERENCES "public"."NetWorthCategoryAssets" (
    "id"
  )
    ON DELETE RESTRICT
    ON UPDATE NO ACTION; -- > statement-breakpoint
ALTER TABLE "PlanningMonthBills"
ADD CONSTRAINT "PlanningMonthBills_billId_PlanningBills_id_fk"
  FOREIGN KEY ("billId") REFERENCES "public"."PlanningBills" ("id")
    ON DELETE CASCADE
    ON UPDATE NO ACTION; -- > statement-breakpoint
ALTER TABLE "PlanningMonthBills"
ADD CONSTRAINT "PlanningMonthBills_month_fk"
  FOREIGN KEY ("year", "date") REFERENCES "public"."PlanningMonths" (
    "year",
    "date"
  )
    ON DELETE CASCADE
    ON UPDATE NO ACTION; -- > statement-breakpoint
ALTER TABLE "PlanningMonths"
ADD CONSTRAINT "PlanningMonths_year_PlanningYears_year_fk"
  FOREIGN KEY ("year") REFERENCES "public"."PlanningYears" ("year")
    ON DELETE CASCADE
    ON UPDATE NO ACTION; -- > statement-breakpoint
ALTER TABLE "PlanningPayslipAdjustments"
ADD CONSTRAINT "PlanningPayslipAdjustments_payslipId_PlanningPayslips_id_fk"
  FOREIGN KEY ("payslipId") REFERENCES "public"."PlanningPayslips" ("id")
    ON DELETE CASCADE
    ON UPDATE NO ACTION; -- > statement-breakpoint
ALTER TABLE "PlanningPayslips"
ADD CONSTRAINT "PlanningPayslips_accountIdTo_NetWorthCategoryAssets_id_fk"
  FOREIGN KEY ("accountIdTo") REFERENCES "public"."NetWorthCategoryAssets" (
    "id"
  )
    ON DELETE RESTRICT
    ON UPDATE NO ACTION; -- > statement-breakpoint
ALTER TABLE "PlanningTransactions"
ADD CONSTRAINT "PlanningTransactions_accountIdFrom_PlanningAccounts_accountId_fk"
  FOREIGN KEY ("accountIdFrom") REFERENCES "public"."PlanningAccounts" (
    "accountId"
  )
    ON DELETE RESTRICT
    ON UPDATE NO ACTION; -- > statement-breakpoint
ALTER TABLE "PlanningTransactions"
ADD CONSTRAINT "PlanningTransactions_accountIdTo_PlanningAccounts_accountId_fk"
  FOREIGN KEY ("accountIdTo") REFERENCES "public"."PlanningAccounts" (
    "accountId"
  )
    ON DELETE RESTRICT
    ON UPDATE NO ACTION; -- > statement-breakpoint
ALTER TABLE "PlanningTransactions"
ADD CONSTRAINT "PlanningTransactions_liabilityId_NetWorthCategoryLiabilities_id_fk"
  FOREIGN KEY (
    "liabilityId"
  ) REFERENCES "public"."NetWorthCategoryLiabilities" ("id")
    ON DELETE RESTRICT
    ON UPDATE NO ACTION; -- > statement-breakpoint
ALTER TABLE "PlanningTransactions"
ADD CONSTRAINT "PlanningTransactions_month_fk"
  FOREIGN KEY ("year", "date") REFERENCES "public"."PlanningMonths" (
    "year",
    "date"
  )
    ON DELETE CASCADE
    ON UPDATE NO ACTION; -- > statement-breakpoint
ALTER TABLE "PlanningYearUKTaxRates"
ADD CONSTRAINT "PlanningYearUKTaxRates_year_PlanningYears_year_fk"
  FOREIGN KEY ("year") REFERENCES "public"."PlanningYears" ("year")
    ON DELETE CASCADE
    ON UPDATE NO ACTION; -- > statement-breakpoint
CREATE UNIQUE INDEX "PlanningMonths_year_month_uq" ON "PlanningMonths" USING btree (
  "year",
  date_trunc('month', "date"::TIMESTAMP)
);

CREATE TYPE "public"."CountryCode" AS ENUM ('GB');
CREATE TYPE "public"."CurrencyCode" AS ENUM (
  'AED',
  'ARS',
  'AUD',
  'BDT',
  'BHD',
  'BRL',
  'CAD',
  'CHF',
  'CLP',
  'CNY',
  'COP',
  'CZK',
  'DKK',
  'EGP',
  'EUR',
  'GBP',
  'GHS',
  'HKD',
  'HUF',
  'ILS',
  'INR',
  'ISK',
  'JOD',
  'JPY',
  'KES',
  'KRW',
  'KWD',
  'LKR',
  'MAD',
  'MXN',
  'MYR',
  'NGN',
  'NOK',
  'NZD',
  'OMR',
  'PEN',
  'PHP',
  'PKR',
  'PLN',
  'QAR',
  'RON',
  'RSD',
  'RUB',
  'SAR',
  'SCR',
  'SEK',
  'SGD',
  'THB',
  'TND',
  'TRY',
  'TWD',
  'UAH',
  'USD',
  'UYU',
  'VES',
  'VND',
  'ZAR'
);
CREATE TYPE "public"."netWorthCategoryAssetType" AS ENUM (
  'CASH',
  'STOCK',
  'OPTION',
  'PENSION',
  'PROPERTY',
  'MISC'
);
CREATE TYPE "public"."netWorthCategoryLiabilityType" AS ENUM (
  'CREDIT_CARD',
  'LOAN',
  'MISC'
);
CREATE TYPE "public"."planningBillsFrequency" AS ENUM (
  'MONTHLY',
  'QUARTERLY',
  'YEARLY'
);
CREATE TABLE "InvestmentTransactions" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "investmentId" uuid NOT NULL,
  "assetId" uuid NOT NULL,
  "units" BIGINT NOT NULL,
  "price" DOUBLE PRECISION NOT NULL,
  "taxes" BIGINT DEFAULT 0 NOT NULL,
  "fees" BIGINT DEFAULT 0 NOT NULL,
  "currency" "CurrencyCode" NOT NULL,
  "date" date NOT NULL,
  "drip" BOOLEAN DEFAULT FALSE NOT NULL,
  "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  CONSTRAINT "InvestmentTransactions_price_ck"
    CHECK ("InvestmentTransactions"."price" >= 0),
  CONSTRAINT "InvestmentTransactions_taxes_ck"
    CHECK ("InvestmentTransactions"."taxes" >= 0),
  CONSTRAINT "InvestmentTransactions_fees_ck"
    CHECK ("InvestmentTransactions"."fees" >= 0)
);

CREATE TABLE "Investments" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "name" text NOT NULL,
  "stockCode" text,
  "fundLink" text,
  "currency" "CurrencyCode" NOT NULL,
  "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  CONSTRAINT "Investments_stockCode_fundLink_ck"
    CHECK (
      ("Investments"."stockCode" IS NOT NULL)::INT + (
        "Investments"."fundLink" IS NOT NULL
      )::INT = 1
    )
);

CREATE TABLE "NetWorthCategoryAssets" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "name" text NOT NULL,
  "type" "netWorthCategoryAssetType" NOT NULL,
  "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL
);

CREATE TABLE "NetWorthCategoryLiabilities" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "name" text NOT NULL,
  "type" "netWorthCategoryLiabilityType" NOT NULL,
  "categoryAssetId" uuid,
  "interestRate" NUMERIC(6, 4),
  "billedFromAccountId" uuid,
  "skip" BOOLEAN DEFAULT FALSE NOT NULL,
  "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  CONSTRAINT "NetWorthCategoryLiabilities_interestRate_ck"
    CHECK (
      (
        "NetWorthCategoryLiabilities"."type" = 'LOAN'
        AND "NetWorthCategoryLiabilities"."interestRate" IS NOT NULL
      )
      OR (
        "NetWorthCategoryLiabilities"."type" != 'LOAN'
        AND "NetWorthCategoryLiabilities"."interestRate" IS NULL
      )
    ),
  CONSTRAINT "NetWorthCategoryLiabilities_billedFromAccount_ck"
    CHECK (
      "NetWorthCategoryLiabilities"."billedFromAccountId" IS NULL
      OR "NetWorthCategoryLiabilities"."type" = 'CREDIT_CARD'
    )
);

CREATE TABLE "NetWorthCategoryOptions" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "name" text NOT NULL,
  "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL
);

CREATE TABLE "NetWorthCurrencyRates" (
  "entryId" uuid NOT NULL,
  "base" "CurrencyCode" NOT NULL,
  "currency" "CurrencyCode" NOT NULL,
  "rate" NUMERIC(24, 12) NOT NULL,
  "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  CONSTRAINT "NetWorthCurrencyRates_pk" PRIMARY KEY ("entryId", "currency"),
  CONSTRAINT "NetWorthCurrencyRates_base_currency_ck"
    CHECK ("NetWorthCurrencyRates"."base" != "NetWorthCurrencyRates"."currency")
);

CREATE TABLE "NetWorthEntries" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "date" date NOT NULL,
  "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL
);

CREATE TABLE "NetWorthValueAmounts" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "valueId" uuid NOT NULL,
  "amount" BIGINT NOT NULL,
  "currency" "CurrencyCode" NOT NULL,
  "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL
);

CREATE TABLE "NetWorthValueOptions" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "valueId" uuid NOT NULL,
  "units" BIGINT NOT NULL,
  "currency" "CurrencyCode" NOT NULL,
  "priceStrike" BIGINT NOT NULL,
  "priceMarket" BIGINT,
  "vested" BIGINT NOT NULL,
  "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  CONSTRAINT "NetWorthValueOptions_valueId_unique" UNIQUE ("valueId")
);

CREATE TABLE "NetWorthValues" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "entryId" uuid NOT NULL,
  "categoryAssetId" uuid,
  "categoryLiabilityId" uuid,
  "categoryOptionId" uuid,
  "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  CONSTRAINT "NetWorthValues_exactlyOneCategory_ck"
    CHECK (
      (
        (
          CASE
            WHEN "NetWorthValues"."categoryAssetId" IS NOT NULL THEN 1
            ELSE 0
          END
        ) + (
          CASE
            WHEN "NetWorthValues"."categoryLiabilityId" IS NOT NULL THEN 1
            ELSE 0
          END
        ) + (
          CASE
            WHEN "NetWorthValues"."categoryOptionId" IS NOT NULL THEN 1
            ELSE 0
          END
        )
      ) = 1
    )
);

CREATE TABLE "PlanningAccounts" (
  "accountId" uuid PRIMARY KEY NOT NULL,
  "alias" text,
  "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL
);

CREATE TABLE "PlanningBills" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "start" date NOT NULL,
  "end" date,
  "frequency" "planningBillsFrequency" NOT NULL,
  "collectionDate" text NOT NULL,
  "amount" BIGINT NOT NULL,
  "currency" "CurrencyCode" NOT NULL,
  "name" text NOT NULL,
  "fromAccountId" uuid NOT NULL,
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

CREATE TABLE "PlanningEarnings" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "name" text NOT NULL,
  "start" date NOT NULL,
  "end" date,
  "amountGross" BIGINT NOT NULL,
  "currency" "CurrencyCode" NOT NULL,
  "countryCode" "CountryCode" NOT NULL,
  "pensionSalarySacrifice" DOUBLE PRECISION,
  "pensionReliefAtSource" DOUBLE PRECISION,
  "pensionNetPay" DOUBLE PRECISION,
  "studentLoanPlan2" BOOLEAN DEFAULT FALSE NOT NULL,
  "studentLoanLiabilityId" uuid,
  "toAccountId" uuid NOT NULL,
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
    CHECK (
      "PlanningEarnings"."pensionReliefAtSource" IS NULL
      OR "PlanningEarnings"."pensionReliefAtSource" BETWEEN 0 AND 1
    ),
  CONSTRAINT "PlanningEarnings_pensionNetPay_ck"
    CHECK (
      "PlanningEarnings"."pensionNetPay" IS NULL
      OR "PlanningEarnings"."pensionNetPay" BETWEEN 0 AND 1
    ),
  CONSTRAINT "PlanningEarnings_studentLoanLiability_ck"
    CHECK (
      "PlanningEarnings"."studentLoanLiabilityId" IS NULL
      OR "PlanningEarnings"."studentLoanPlan2" = TRUE
    )
);

CREATE TABLE "PlanningEarningsUKTaxCodes" (
  "earningsId" uuid NOT NULL,
  "start" date NOT NULL,
  "end" date,
  "taxCode" text NOT NULL,
  "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  CONSTRAINT "PlanningEarningsUKTaxCodes_pk"
    PRIMARY KEY ("earningsId", "start"),
  CONSTRAINT "PlanningEarningsUKTaxCodes_dateRange_ck"
    CHECK (
      "PlanningEarningsUKTaxCodes"."end" IS NULL
      OR "PlanningEarningsUKTaxCodes"."end" >= "PlanningEarningsUKTaxCodes"."start"
    )
);

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

CREATE TABLE "PlanningMonths" (
  "year" INTEGER NOT NULL,
  "date" date NOT NULL,
  "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  CONSTRAINT "PlanningMonths_pk" PRIMARY KEY ("year", "date")
);

CREATE TABLE "PlanningPayslipAdjustments" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "payslipId" uuid NOT NULL,
  "amount" BIGINT NOT NULL,
  "name" text NOT NULL,
  "liabilityId" uuid,
  "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL
);

CREATE TABLE "PlanningPayslips" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "date" date NOT NULL,
  "amountGross" BIGINT NOT NULL,
  "currency" "CurrencyCode" NOT NULL,
  "name" text NOT NULL,
  "toAccountId" uuid NOT NULL,
  "fileUrl" text,
  "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL
);

CREATE TABLE "PlanningTransactions" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "year" INTEGER NOT NULL,
  "date" date NOT NULL,
  "amount" BIGINT NOT NULL,
  "currency" "CurrencyCode" NOT NULL,
  "name" text NOT NULL,
  "accountId" uuid NOT NULL,
  "toAccountId" uuid,
  "liabilityId" uuid,
  "assetId" uuid,
  "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  CONSTRAINT "PlanningTransactions_accounts_ck"
    CHECK (
      "PlanningTransactions"."toAccountId" IS NULL
      OR "PlanningTransactions"."accountId" != "PlanningTransactions"."toAccountId"
    ),
  CONSTRAINT "PlanningTransactions_inflow_ck"
    CHECK (
      "PlanningTransactions"."amount" <= 0
      OR (
        "PlanningTransactions"."toAccountId" IS NULL
        AND "PlanningTransactions"."liabilityId" IS NULL
        AND "PlanningTransactions"."assetId" IS NULL
      )
    ),
  CONSTRAINT "PlanningTransactions_liabilityAssetExclusive_ck"
    CHECK (
      "PlanningTransactions"."liabilityId" IS NULL
      OR "PlanningTransactions"."assetId" IS NULL
    )
);

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

CREATE TABLE "PlanningYears" (
  "year" INTEGER PRIMARY KEY NOT NULL,
  "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL
);

ALTER TABLE "InvestmentTransactions"
ADD CONSTRAINT "InvestmentTransactions_investmentId_Investments_id_fk"
  FOREIGN KEY ("investmentId") REFERENCES "public"."Investments" ("id")
    ON DELETE CASCADE
    ON UPDATE NO ACTION;
ALTER TABLE "InvestmentTransactions"
ADD CONSTRAINT "InvestmentTransactions_assetId_NetWorthCategoryAssets_id_fk"
  FOREIGN KEY ("assetId") REFERENCES "public"."NetWorthCategoryAssets" ("id")
    ON DELETE RESTRICT
    ON UPDATE NO ACTION;
ALTER TABLE "NetWorthCategoryLiabilities"
ADD CONSTRAINT "NetWorthCategoryLiabilities_categoryAssetId_NetWorthCategoryAssets_id_fk"
  FOREIGN KEY ("categoryAssetId") REFERENCES "public"."NetWorthCategoryAssets" (
    "id"
  )
    ON DELETE SET NULL
    ON UPDATE NO ACTION;
ALTER TABLE "NetWorthCategoryLiabilities"
ADD CONSTRAINT "NetWorthCategoryLiabilities_billedFromAccountId_PlanningAccounts_accountId_fk"
  FOREIGN KEY ("billedFromAccountId") REFERENCES "public"."PlanningAccounts" (
    "accountId"
  )
    ON DELETE SET NULL
    ON UPDATE NO ACTION;
ALTER TABLE "NetWorthCurrencyRates"
ADD CONSTRAINT "NetWorthCurrencyRates_entryId_NetWorthEntries_id_fk"
  FOREIGN KEY ("entryId") REFERENCES "public"."NetWorthEntries" ("id")
    ON DELETE CASCADE
    ON UPDATE NO ACTION;
ALTER TABLE "NetWorthValueAmounts"
ADD CONSTRAINT "NetWorthValueAmounts_valueId_NetWorthValues_id_fk"
  FOREIGN KEY ("valueId") REFERENCES "public"."NetWorthValues" ("id")
    ON DELETE CASCADE
    ON UPDATE NO ACTION;
ALTER TABLE "NetWorthValueOptions"
ADD CONSTRAINT "NetWorthValueOptions_valueId_NetWorthValues_id_fk"
  FOREIGN KEY ("valueId") REFERENCES "public"."NetWorthValues" ("id")
    ON DELETE CASCADE
    ON UPDATE NO ACTION;
ALTER TABLE "NetWorthValues"
ADD CONSTRAINT "NetWorthValues_entryId_NetWorthEntries_id_fk"
  FOREIGN KEY ("entryId") REFERENCES "public"."NetWorthEntries" ("id")
    ON DELETE CASCADE
    ON UPDATE NO ACTION;
ALTER TABLE "NetWorthValues"
ADD CONSTRAINT "NetWorthValues_categoryAssetId_NetWorthCategoryAssets_id_fk"
  FOREIGN KEY ("categoryAssetId") REFERENCES "public"."NetWorthCategoryAssets" (
    "id"
  )
    ON DELETE RESTRICT
    ON UPDATE NO ACTION;
ALTER TABLE "NetWorthValues"
ADD CONSTRAINT "NetWorthValues_categoryLiabilityId_NetWorthCategoryLiabilities_id_fk"
  FOREIGN KEY (
    "categoryLiabilityId"
  ) REFERENCES "public"."NetWorthCategoryLiabilities" ("id")
    ON DELETE RESTRICT
    ON UPDATE NO ACTION;
ALTER TABLE "NetWorthValues"
ADD CONSTRAINT "NetWorthValues_categoryOptionId_NetWorthCategoryOptions_id_fk"
  FOREIGN KEY (
    "categoryOptionId"
  ) REFERENCES "public"."NetWorthCategoryOptions" ("id")
    ON DELETE RESTRICT
    ON UPDATE NO ACTION;
ALTER TABLE "PlanningAccounts"
ADD CONSTRAINT "PlanningAccounts_accountId_NetWorthCategoryAssets_id_fk"
  FOREIGN KEY ("accountId") REFERENCES "public"."NetWorthCategoryAssets" ("id")
    ON DELETE CASCADE
    ON UPDATE NO ACTION;
ALTER TABLE "PlanningBills"
ADD CONSTRAINT "PlanningBills_fromAccountId_PlanningAccounts_accountId_fk"
  FOREIGN KEY ("fromAccountId") REFERENCES "public"."PlanningAccounts" (
    "accountId"
  )
    ON DELETE RESTRICT
    ON UPDATE NO ACTION;
ALTER TABLE "PlanningBills"
ADD CONSTRAINT "PlanningBills_liabilityId_NetWorthCategoryLiabilities_id_fk"
  FOREIGN KEY (
    "liabilityId"
  ) REFERENCES "public"."NetWorthCategoryLiabilities" ("id")
    ON DELETE RESTRICT
    ON UPDATE NO ACTION;
ALTER TABLE "PlanningEarnings"
ADD CONSTRAINT "PlanningEarnings_studentLoanLiabilityId_NetWorthCategoryLiabilities_id_fk"
  FOREIGN KEY (
    "studentLoanLiabilityId"
  ) REFERENCES "public"."NetWorthCategoryLiabilities" ("id")
    ON DELETE SET NULL
    ON UPDATE NO ACTION;
ALTER TABLE "PlanningEarnings"
ADD CONSTRAINT "PlanningEarnings_toAccountId_PlanningAccounts_accountId_fk"
  FOREIGN KEY ("toAccountId") REFERENCES "public"."PlanningAccounts" (
    "accountId"
  )
    ON DELETE RESTRICT
    ON UPDATE NO ACTION;
ALTER TABLE "PlanningEarningsUKTaxCodes"
ADD CONSTRAINT "PlanningEarningsUKTaxCodes_earningsId_PlanningEarnings_id_fk"
  FOREIGN KEY ("earningsId") REFERENCES "public"."PlanningEarnings" ("id")
    ON DELETE CASCADE
    ON UPDATE NO ACTION;
ALTER TABLE "PlanningMonthBills"
ADD CONSTRAINT "PlanningMonthBills_billId_PlanningBills_id_fk"
  FOREIGN KEY ("billId") REFERENCES "public"."PlanningBills" ("id")
    ON DELETE CASCADE
    ON UPDATE NO ACTION;
ALTER TABLE "PlanningMonthBills"
ADD CONSTRAINT "PlanningMonthBills_month_fk"
  FOREIGN KEY ("year", "date") REFERENCES "public"."PlanningMonths" (
    "year",
    "date"
  )
    ON DELETE CASCADE
    ON UPDATE NO ACTION;
ALTER TABLE "PlanningMonths"
ADD CONSTRAINT "PlanningMonths_year_PlanningYears_year_fk"
  FOREIGN KEY ("year") REFERENCES "public"."PlanningYears" ("year")
    ON DELETE CASCADE
    ON UPDATE NO ACTION;
ALTER TABLE "PlanningPayslipAdjustments"
ADD CONSTRAINT "PlanningPayslipAdjustments_payslipId_PlanningPayslips_id_fk"
  FOREIGN KEY ("payslipId") REFERENCES "public"."PlanningPayslips" ("id")
    ON DELETE CASCADE
    ON UPDATE NO ACTION;
ALTER TABLE "PlanningPayslipAdjustments"
ADD CONSTRAINT "PlanningPayslipAdjustments_liabilityId_NetWorthCategoryLiabilities_id_fk"
  FOREIGN KEY (
    "liabilityId"
  ) REFERENCES "public"."NetWorthCategoryLiabilities" ("id")
    ON DELETE SET NULL
    ON UPDATE NO ACTION;
ALTER TABLE "PlanningPayslips"
ADD CONSTRAINT "PlanningPayslips_toAccountId_PlanningAccounts_accountId_fk"
  FOREIGN KEY ("toAccountId") REFERENCES "public"."PlanningAccounts" (
    "accountId"
  )
    ON DELETE RESTRICT
    ON UPDATE NO ACTION;
ALTER TABLE "PlanningTransactions"
ADD CONSTRAINT "PlanningTransactions_accountId_PlanningAccounts_accountId_fk"
  FOREIGN KEY ("accountId") REFERENCES "public"."PlanningAccounts" ("accountId")
    ON DELETE RESTRICT
    ON UPDATE NO ACTION;
ALTER TABLE "PlanningTransactions"
ADD CONSTRAINT "PlanningTransactions_toAccountId_PlanningAccounts_accountId_fk"
  FOREIGN KEY ("toAccountId") REFERENCES "public"."PlanningAccounts" (
    "accountId"
  )
    ON DELETE RESTRICT
    ON UPDATE NO ACTION;
ALTER TABLE "PlanningTransactions"
ADD CONSTRAINT "PlanningTransactions_liabilityId_NetWorthCategoryLiabilities_id_fk"
  FOREIGN KEY (
    "liabilityId"
  ) REFERENCES "public"."NetWorthCategoryLiabilities" ("id")
    ON DELETE RESTRICT
    ON UPDATE NO ACTION;
ALTER TABLE "PlanningTransactions"
ADD CONSTRAINT "PlanningTransactions_assetId_NetWorthCategoryAssets_id_fk"
  FOREIGN KEY ("assetId") REFERENCES "public"."NetWorthCategoryAssets" ("id")
    ON DELETE RESTRICT
    ON UPDATE NO ACTION;
ALTER TABLE "PlanningTransactions"
ADD CONSTRAINT "PlanningTransactions_month_fk"
  FOREIGN KEY ("year", "date") REFERENCES "public"."PlanningMonths" (
    "year",
    "date"
  )
    ON DELETE CASCADE
    ON UPDATE NO ACTION;
ALTER TABLE "PlanningYearUKTaxRates"
ADD CONSTRAINT "PlanningYearUKTaxRates_year_PlanningYears_year_fk"
  FOREIGN KEY ("year") REFERENCES "public"."PlanningYears" ("year")
    ON DELETE CASCADE
    ON UPDATE NO ACTION;
CREATE INDEX "InvestmentTransactions_investmentId_idx" ON "InvestmentTransactions" USING btree (
  "investmentId"
);
CREATE INDEX "InvestmentTransactions_assetId_idx" ON "InvestmentTransactions" USING btree (
  "assetId"
);
CREATE UNIQUE INDEX "NetWorthEntries_month_uq" ON "NetWorthEntries" USING btree (
  date_trunc('month', "date"::TIMESTAMP)
);
CREATE UNIQUE INDEX "NetWorthValueAmounts_valueId_currency_uq" ON "NetWorthValueAmounts" USING btree (
  "valueId",
  "currency"
);
CREATE INDEX "NetWorthValues_entryId_idx" ON "NetWorthValues" USING btree (
  "entryId"
);
CREATE UNIQUE INDEX "PlanningMonths_year_month_uq" ON "PlanningMonths" USING btree (
  "year",
  date_trunc('month', "date"::TIMESTAMP)
);

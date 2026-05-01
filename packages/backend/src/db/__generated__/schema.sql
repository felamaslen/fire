-- AUTO-GENERATED FILE. DO NOT EDIT.
-- Intermediary DB schema used for generating migrations and checking drift.
-- The Drizzle schema is the source of truth.
CREATE TYPE "public"."CountryCode" AS ENUM('GB');

CREATE TYPE "public"."CurrencyCode" AS ENUM(
  'GBP',
  'USD',
  'EUR',
  'JPY',
  'CZK',
  'NOK',
  'CNY',
  'HKD',
  'AUD',
  'SCR',
  'TWD',
  'AED',
  'ARS',
  'BDT',
  'BHD',
  'BRL',
  'CAD',
  'CHF',
  'CLP',
  'COP',
  'DKK',
  'EGP',
  'GHS',
  'HUF',
  'ILS',
  'INR',
  'ISK',
  'JOD',
  'KES',
  'KRW',
  'KWD',
  'LKR',
  'MAD',
  'MXN',
  'MYR',
  'NGN',
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
  'SEK',
  'SGD',
  'THB',
  'TND',
  'TRY',
  'UAH',
  'UYU',
  'VES',
  'VND',
  'ZAR'
);

CREATE TYPE "public"."netWorthCategoryAssetType" AS ENUM(
  'CASH',
  'STOCK',
  'OPTION',
  'PENSION',
  'PROPERTY',
  'VEHICLE',
  'MISC'
);

CREATE TYPE "public"."netWorthCategoryLiabilityType" AS ENUM('CREDIT_CARD', 'LOAN', 'MISC');

CREATE TYPE "public"."planningBillsFrequency" AS ENUM('MONTHLY', 'QUARTERLY', 'YEARLY');

CREATE TABLE "DemoSessions" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "schema" text NOT NULL,
  "flavour" text NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "expiresAt" timestamp with time zone NOT NULL,
  CONSTRAINT "DemoSessions_schema_unique" UNIQUE ("schema")
);

CREATE TABLE "InvestmentAllocations" (
  "assetId" uuid NOT NULL,
  "investmentId" uuid NOT NULL,
  "allocation" double precision NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "InvestmentAllocations_pk" PRIMARY KEY ("assetId", "investmentId"),
  CONSTRAINT "InvestmentAllocations_allocation_ck" CHECK (
    "InvestmentAllocations"."allocation" > 0
    AND "InvestmentAllocations"."allocation" <= 1
  )
);

CREATE TABLE "InvestmentDeposits" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "assetId" uuid NOT NULL,
  "date" date NOT NULL,
  "amount" bigint NOT NULL,
  "currency" "CurrencyCode" NOT NULL,
  "name" text NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "InvestmentPrices" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "investmentId" uuid NOT NULL,
  "date" date NOT NULL,
  "price" double precision NOT NULL,
  "priceAdjusted" double precision DEFAULT 0 NOT NULL,
  "currency" "CurrencyCode" NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
  "isLatest" boolean,
  CONSTRAINT "InvestmentPrices_price_ck" CHECK ("InvestmentPrices"."price" >= 0),
  CONSTRAINT "InvestmentPrices_priceAdjusted_ck" CHECK ("InvestmentPrices"."priceAdjusted" >= 0),
  CONSTRAINT "InvestmentPrices_isLatest_ck" CHECK (
    "InvestmentPrices"."isLatest" IS NULL
    OR "InvestmentPrices"."isLatest" = TRUE
  )
);

CREATE TABLE "InvestmentPricesLive" (
  "investmentId" uuid PRIMARY KEY NOT NULL,
  "refreshedAt" timestamp with time zone NOT NULL,
  "date" timestamp with time zone NOT NULL,
  "currency" "CurrencyCode" NOT NULL,
  "price" double precision NOT NULL,
  "pricePreviousClose" double precision,
  "data" jsonb,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "InvestmentStockSplits" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "investmentId" uuid NOT NULL,
  "date" date NOT NULL,
  "ratio" numeric(20, 10) NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "InvestmentStockSplits_ratio_ck" CHECK ("InvestmentStockSplits"."ratio" > 0)
);

CREATE TABLE "InvestmentTransactions" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "investmentId" uuid NOT NULL,
  "assetId" uuid NOT NULL,
  "units" double precision NOT NULL,
  "price" double precision NOT NULL,
  "taxes" bigint DEFAULT 0 NOT NULL,
  "fees" bigint DEFAULT 0 NOT NULL,
  "currency" "CurrencyCode" NOT NULL,
  "date" date NOT NULL,
  "drip" boolean DEFAULT FALSE NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "InvestmentTransactions_price_ck" CHECK ("InvestmentTransactions"."price" >= 0),
  CONSTRAINT "InvestmentTransactions_taxes_ck" CHECK ("InvestmentTransactions"."taxes" >= 0),
  CONSTRAINT "InvestmentTransactions_fees_ck" CHECK ("InvestmentTransactions"."fees" >= 0)
);

CREATE TABLE "InvestmentTransfers" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "assetIdFrom" uuid NOT NULL,
  "assetIdTo" uuid NOT NULL,
  "date" date NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "InvestmentTransfers_assetIdFrom_assetIdTo_ck" CHECK (
    "InvestmentTransfers"."assetIdFrom" <> "InvestmentTransfers"."assetIdTo"
  )
);

CREATE TABLE "InvestmentValuePoints" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "investmentId" uuid NOT NULL,
  "assetId" uuid NOT NULL,
  "date" date NOT NULL,
  "units" double precision NOT NULL,
  "value" bigint NOT NULL,
  "currency" "CurrencyCode" NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "Investments" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "name" text NOT NULL,
  "stockCode" text,
  "fundLink" text,
  "currency" "CurrencyCode" NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "Investments_stockCode_fundLink_ck" CHECK (
    ("Investments"."stockCode" IS NOT NULL)::int + ("Investments"."fundLink" IS NOT NULL)::int = 1
  )
);

CREATE TABLE "NetWorthCategoryAssets" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "name" text NOT NULL,
  "type" "netWorthCategoryAssetType" NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
  "growthRate" numeric(6, 4),
  "accessibleFrom" date,
  CONSTRAINT "NetWorthCategoryAssets_growthRate_ck" CHECK (
    "NetWorthCategoryAssets"."growthRate" IS NULL
    OR "NetWorthCategoryAssets"."type" IN ('PROPERTY', 'VEHICLE')
  ),
  CONSTRAINT "NetWorthCategoryAssets_accessibleFrom_ck" CHECK (
    "NetWorthCategoryAssets"."accessibleFrom" IS NULL
    OR "NetWorthCategoryAssets"."type" = 'PENSION'
  )
);

CREATE TABLE "NetWorthCategoryLiabilities" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "name" text NOT NULL,
  "type" "netWorthCategoryLiabilityType" NOT NULL,
  "categoryAssetId" uuid,
  "interestRate" numeric(6, 4),
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
  "skip" boolean DEFAULT FALSE NOT NULL,
  "billedFromAccountId" uuid,
  CONSTRAINT "NetWorthCategoryLiabilities_interestRate_ck" CHECK (
    (
      "NetWorthCategoryLiabilities"."type" = 'LOAN'
      AND "NetWorthCategoryLiabilities"."interestRate" IS NOT NULL
    )
    OR (
      "NetWorthCategoryLiabilities"."type" <> 'LOAN'
      AND "NetWorthCategoryLiabilities"."interestRate" IS NULL
    )
  ),
  CONSTRAINT "NetWorthCategoryLiabilities_billedFromAccount_ck" CHECK (
    "NetWorthCategoryLiabilities"."billedFromAccountId" IS NULL
    OR "NetWorthCategoryLiabilities"."type" = 'CREDIT_CARD'
  )
);

CREATE TABLE "NetWorthCategoryOptions" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "name" text NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "NetWorthCurrencyRates" (
  "entryId" uuid NOT NULL,
  "base" "CurrencyCode" NOT NULL,
  "currency" "CurrencyCode" NOT NULL,
  "rate" numeric(24, 12) NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "NetWorthCurrencyRates_pk" PRIMARY KEY ("entryId", "currency"),
  CONSTRAINT "NetWorthCurrencyRates_base_currency_ck" CHECK (
    "NetWorthCurrencyRates"."base" <> "NetWorthCurrencyRates"."currency"
  )
);

CREATE TABLE "NetWorthEntries" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "date" date NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "NetWorthValueAmounts" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "valueId" uuid NOT NULL,
  "amount" bigint NOT NULL,
  "currency" "CurrencyCode" NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "NetWorthValueOptions" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "valueId" uuid NOT NULL,
  "units" bigint NOT NULL,
  "currency" "CurrencyCode" NOT NULL,
  "priceStrike" double precision NOT NULL,
  "priceMarket" double precision,
  "vested" bigint NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "NetWorthValueOptions_valueId_unique" UNIQUE ("valueId")
);

CREATE TABLE "NetWorthValues" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "entryId" uuid NOT NULL,
  "categoryAssetId" uuid,
  "categoryLiabilityId" uuid,
  "categoryOptionId" uuid,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "NetWorthValues_exactlyOneCategory_ck" CHECK (
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
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
  "sortOrder" integer DEFAULT 0 NOT NULL,
  "currency" "CurrencyCode",
  "target" bigint,
  CONSTRAINT "PlanningAccounts_target_currency_ck" CHECK (
    ("PlanningAccounts"."target" IS NULL) = ("PlanningAccounts"."currency" IS NULL)
  )
);

CREATE TABLE "PlanningBills" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "start" date NOT NULL,
  "end" date,
  "frequency" "planningBillsFrequency" NOT NULL,
  "collectionDate" text NOT NULL,
  "amount" bigint NOT NULL,
  "currency" "CurrencyCode" NOT NULL,
  "name" text NOT NULL,
  "fromAccountId" uuid NOT NULL,
  "liabilityId" uuid,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "PlanningBills_dateRange_ck" CHECK (
    "PlanningBills"."end" IS NULL
    OR "PlanningBills"."end" >= "PlanningBills"."start"
  ),
  CONSTRAINT "PlanningBills_collectionDate_ck" CHECK (
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
  "amountGross" bigint NOT NULL,
  "currency" "CurrencyCode" NOT NULL,
  "countryCode" "CountryCode" NOT NULL,
  "pensionSalarySacrifice" double precision,
  "pensionReliefAtSource" double precision,
  "pensionNetPay" double precision,
  "studentLoanPlan2" boolean DEFAULT FALSE NOT NULL,
  "toAccountId" uuid NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
  "studentLoanLiabilityId" uuid,
  "pensionAssetId" uuid,
  CONSTRAINT "PlanningEarnings_dateRange_ck" CHECK (
    "PlanningEarnings"."end" IS NULL
    OR "PlanningEarnings"."end" >= "PlanningEarnings"."start"
  ),
  CONSTRAINT "PlanningEarnings_pensionSalarySacrifice_ck" CHECK (
    "PlanningEarnings"."pensionSalarySacrifice" IS NULL
    OR "PlanningEarnings"."pensionSalarySacrifice" BETWEEN 0 AND 1
  ),
  CONSTRAINT "PlanningEarnings_pensionReliefAtSource_ck" CHECK (
    "PlanningEarnings"."pensionReliefAtSource" IS NULL
    OR "PlanningEarnings"."pensionReliefAtSource" BETWEEN 0 AND 1
  ),
  CONSTRAINT "PlanningEarnings_pensionNetPay_ck" CHECK (
    "PlanningEarnings"."pensionNetPay" IS NULL
    OR "PlanningEarnings"."pensionNetPay" BETWEEN 0 AND 1
  ),
  CONSTRAINT "PlanningEarnings_studentLoanLiability_ck" CHECK (
    "PlanningEarnings"."studentLoanLiabilityId" IS NULL
    OR "PlanningEarnings"."studentLoanPlan2" = TRUE
  ),
  CONSTRAINT "PlanningEarnings_pensionAsset_ck" CHECK (
    "PlanningEarnings"."pensionAssetId" IS NULL
    OR (
      "PlanningEarnings"."pensionSalarySacrifice" IS NOT NULL
      OR "PlanningEarnings"."pensionNetPay" IS NOT NULL
      OR "PlanningEarnings"."pensionReliefAtSource" IS NOT NULL
    )
  )
);

CREATE TABLE "PlanningEarningsParentalLeave" (
  "earningsId" uuid NOT NULL,
  "start" date NOT NULL,
  "end" date,
  "fractionOfGross" double precision NOT NULL,
  "isSMP" boolean DEFAULT FALSE NOT NULL,
  "isSPP" boolean DEFAULT FALSE NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "PlanningEarningsParentalLeave_pk" PRIMARY KEY ("earningsId", "start"),
  CONSTRAINT "PlanningEarningsParentalLeave_dateRange_ck" CHECK (
    "PlanningEarningsParentalLeave"."end" IS NULL
    OR "PlanningEarningsParentalLeave"."end" >= "PlanningEarningsParentalLeave"."start"
  ),
  CONSTRAINT "PlanningEarningsParentalLeave_fractionOfGross_ck" CHECK (
    "PlanningEarningsParentalLeave"."fractionOfGross" BETWEEN 0 AND 1
  ),
  CONSTRAINT "PlanningEarningsParentalLeave_eligibility_ck" CHECK (
    NOT (
      "PlanningEarningsParentalLeave"."isSMP"
      AND "PlanningEarningsParentalLeave"."isSPP"
    )
  )
);

CREATE TABLE "PlanningEarningsUKTaxCodes" (
  "earningsId" uuid NOT NULL,
  "start" date NOT NULL,
  "end" date,
  "taxCode" text NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "PlanningEarningsUKTaxCodes_pk" PRIMARY KEY ("earningsId", "start"),
  CONSTRAINT "PlanningEarningsUKTaxCodes_dateRange_ck" CHECK (
    "PlanningEarningsUKTaxCodes"."end" IS NULL
    OR "PlanningEarningsUKTaxCodes"."end" >= "PlanningEarningsUKTaxCodes"."start"
  )
);

CREATE TABLE "PlanningMonthBills" (
  "year" integer NOT NULL,
  "date" date NOT NULL,
  "billId" uuid NOT NULL,
  "amount" bigint,
  "currency" "CurrencyCode",
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "PlanningMonthBills_pk" PRIMARY KEY ("year", "date", "billId"),
  CONSTRAINT "PlanningMonthBills_amountCurrency_ck" CHECK (
    ("PlanningMonthBills"."amount" IS NULL) = ("PlanningMonthBills"."currency" IS NULL)
  )
);

CREATE TABLE "PlanningMonths" (
  "year" integer NOT NULL,
  "date" date NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "PlanningMonths_pk" PRIMARY KEY ("year", "date")
);

CREATE TABLE "PlanningPayslipAdjustments" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "payslipId" uuid NOT NULL,
  "amount" bigint NOT NULL,
  "name" text NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
  "liabilityId" uuid
);

CREATE TABLE "PlanningPayslips" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "date" date NOT NULL,
  "amountGross" bigint NOT NULL,
  "currency" "CurrencyCode" NOT NULL,
  "name" text NOT NULL,
  "toAccountId" uuid NOT NULL,
  "fileUrl" text,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "PlanningTransactions" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "year" integer NOT NULL,
  "date" date NOT NULL,
  "amount" bigint NOT NULL,
  "currency" "CurrencyCode" NOT NULL,
  "name" text NOT NULL,
  "accountId" uuid NOT NULL,
  "toAccountId" uuid,
  "liabilityId" uuid,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
  "assetId" uuid,
  "isProvisional" boolean DEFAULT FALSE NOT NULL,
  CONSTRAINT "PlanningTransactions_accounts_ck" CHECK (
    "PlanningTransactions"."toAccountId" IS NULL
    OR "PlanningTransactions"."accountId" <> "PlanningTransactions"."toAccountId"
  ),
  CONSTRAINT "PlanningTransactions_inflow_ck" CHECK (
    "PlanningTransactions"."amount" <= 0
    OR (
      "PlanningTransactions"."toAccountId" IS NULL
      AND "PlanningTransactions"."liabilityId" IS NULL
    )
  ),
  CONSTRAINT "PlanningTransactions_liabilityAssetExclusive_ck" CHECK (
    "PlanningTransactions"."liabilityId" IS NULL
    OR "PlanningTransactions"."assetId" IS NULL
  )
);

CREATE TABLE "PlanningYearUKTaxRates" (
  "year" integer PRIMARY KEY NOT NULL,
  "rateBasic" double precision NOT NULL,
  "rateHigher" double precision NOT NULL,
  "rateAdditional" double precision NOT NULL,
  "thresholdBasic" bigint NOT NULL,
  "thresholdHigher" bigint NOT NULL,
  "thresholdAdditional" bigint NOT NULL,
  "rateNicMain" double precision NOT NULL,
  "rateNicAdditional" double precision NOT NULL,
  "thresholdNicPrimary" bigint NOT NULL,
  "thresholdNicUpperEarnings" bigint NOT NULL,
  "rateStudentLoanPlan2" double precision NOT NULL,
  "thresholdStudentLoanPlan2" bigint NOT NULL,
  "thresholdPersonalAllowanceTaper" bigint NOT NULL,
  "statutoryParentalPayWeekly" bigint DEFAULT 18718 NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "PlanningYearUKTaxRates_rateBasic_ck" CHECK (
    "PlanningYearUKTaxRates"."rateBasic" BETWEEN 0 AND 1
  ),
  CONSTRAINT "PlanningYearUKTaxRates_rateHigher_ck" CHECK (
    "PlanningYearUKTaxRates"."rateHigher" BETWEEN 0 AND 1
  ),
  CONSTRAINT "PlanningYearUKTaxRates_rateAdditional_ck" CHECK (
    "PlanningYearUKTaxRates"."rateAdditional" BETWEEN 0 AND 1
  ),
  CONSTRAINT "PlanningYearUKTaxRates_rateNicMain_ck" CHECK (
    "PlanningYearUKTaxRates"."rateNicMain" BETWEEN 0 AND 1
  ),
  CONSTRAINT "PlanningYearUKTaxRates_rateNicAdditional_ck" CHECK (
    "PlanningYearUKTaxRates"."rateNicAdditional" BETWEEN 0 AND 1
  ),
  CONSTRAINT "PlanningYearUKTaxRates_rateStudentLoanPlan2_ck" CHECK (
    "PlanningYearUKTaxRates"."rateStudentLoanPlan2" BETWEEN 0 AND 1
  )
);

CREATE TABLE "PlanningYears" (
  "year" integer PRIMARY KEY NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "AppSettings" (
  "singleton" boolean PRIMARY KEY NOT NULL,
  "cashAllocationAmount" bigint,
  "cashAllocationCurrency" "CurrencyCode",
  "retirementYear" integer,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "AppSettings_singleton_ck" CHECK ("AppSettings"."singleton" = TRUE),
  CONSTRAINT "AppSettings_cashAllocationAmount_ck" CHECK (
    "AppSettings"."cashAllocationAmount" IS NULL
    OR "AppSettings"."cashAllocationAmount" >= 0
  ),
  CONSTRAINT "AppSettings_cashAllocationPair_ck" CHECK (
    ("AppSettings"."cashAllocationAmount" IS NULL) = ("AppSettings"."cashAllocationCurrency" IS NULL)
  ),
  CONSTRAINT "AppSettings_retirementYear_ck" CHECK (
    "AppSettings"."retirementYear" IS NULL
    OR "AppSettings"."retirementYear" BETWEEN 1900 AND 2200
  )
);

ALTER TABLE "InvestmentAllocations"
ADD CONSTRAINT "InvestmentAllocations_assetId_NetWorthCategoryAssets_id_fk" FOREIGN KEY ("assetId") REFERENCES "public"."NetWorthCategoryAssets" ("id") ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "InvestmentAllocations"
ADD CONSTRAINT "InvestmentAllocations_investmentId_Investments_id_fk" FOREIGN KEY ("investmentId") REFERENCES "public"."Investments" ("id") ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "InvestmentDeposits"
ADD CONSTRAINT "InvestmentDeposits_assetId_NetWorthCategoryAssets_id_fk" FOREIGN KEY ("assetId") REFERENCES "public"."NetWorthCategoryAssets" ("id") ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "InvestmentPrices"
ADD CONSTRAINT "InvestmentPrices_investmentId_Investments_id_fk" FOREIGN KEY ("investmentId") REFERENCES "public"."Investments" ("id") ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "InvestmentPricesLive"
ADD CONSTRAINT "InvestmentPricesLive_investmentId_Investments_id_fk" FOREIGN KEY ("investmentId") REFERENCES "public"."Investments" ("id") ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "InvestmentStockSplits"
ADD CONSTRAINT "InvestmentStockSplits_investmentId_Investments_id_fk" FOREIGN KEY ("investmentId") REFERENCES "public"."Investments" ("id") ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "InvestmentTransactions"
ADD CONSTRAINT "InvestmentTransactions_investmentId_Investments_id_fk" FOREIGN KEY ("investmentId") REFERENCES "public"."Investments" ("id") ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "InvestmentTransactions"
ADD CONSTRAINT "InvestmentTransactions_assetId_NetWorthCategoryAssets_id_fk" FOREIGN KEY ("assetId") REFERENCES "public"."NetWorthCategoryAssets" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "InvestmentTransfers"
ADD CONSTRAINT "InvestmentTransfers_assetIdFrom_NetWorthCategoryAssets_id_fk" FOREIGN KEY ("assetIdFrom") REFERENCES "public"."NetWorthCategoryAssets" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "InvestmentTransfers"
ADD CONSTRAINT "InvestmentTransfers_assetIdTo_NetWorthCategoryAssets_id_fk" FOREIGN KEY ("assetIdTo") REFERENCES "public"."NetWorthCategoryAssets" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "InvestmentValuePoints"
ADD CONSTRAINT "InvestmentValuePoints_investmentId_Investments_id_fk" FOREIGN KEY ("investmentId") REFERENCES "public"."Investments" ("id") ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "InvestmentValuePoints"
ADD CONSTRAINT "InvestmentValuePoints_assetId_NetWorthCategoryAssets_id_fk" FOREIGN KEY ("assetId") REFERENCES "public"."NetWorthCategoryAssets" ("id") ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "NetWorthCategoryLiabilities"
ADD CONSTRAINT "NetWorthCategoryLiabilities_categoryAssetId_NetWorthCategoryAssets_id_fk" FOREIGN KEY ("categoryAssetId") REFERENCES "public"."NetWorthCategoryAssets" ("id") ON DELETE SET NULL ON UPDATE NO ACTION;

ALTER TABLE "NetWorthCategoryLiabilities"
ADD CONSTRAINT "NetWorthCategoryLiabilities_billedFromAccountId_PlanningAccounts_accountId_fk" FOREIGN KEY ("billedFromAccountId") REFERENCES "public"."PlanningAccounts" ("accountId") ON DELETE SET NULL ON UPDATE NO ACTION;

ALTER TABLE "NetWorthCurrencyRates"
ADD CONSTRAINT "NetWorthCurrencyRates_entryId_NetWorthEntries_id_fk" FOREIGN KEY ("entryId") REFERENCES "public"."NetWorthEntries" ("id") ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "NetWorthValueAmounts"
ADD CONSTRAINT "NetWorthValueAmounts_valueId_NetWorthValues_id_fk" FOREIGN KEY ("valueId") REFERENCES "public"."NetWorthValues" ("id") ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "NetWorthValueOptions"
ADD CONSTRAINT "NetWorthValueOptions_valueId_NetWorthValues_id_fk" FOREIGN KEY ("valueId") REFERENCES "public"."NetWorthValues" ("id") ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "NetWorthValues"
ADD CONSTRAINT "NetWorthValues_entryId_NetWorthEntries_id_fk" FOREIGN KEY ("entryId") REFERENCES "public"."NetWorthEntries" ("id") ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "NetWorthValues"
ADD CONSTRAINT "NetWorthValues_categoryAssetId_NetWorthCategoryAssets_id_fk" FOREIGN KEY ("categoryAssetId") REFERENCES "public"."NetWorthCategoryAssets" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "NetWorthValues"
ADD CONSTRAINT "NetWorthValues_categoryLiabilityId_NetWorthCategoryLiabilities_id_fk" FOREIGN KEY ("categoryLiabilityId") REFERENCES "public"."NetWorthCategoryLiabilities" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "NetWorthValues"
ADD CONSTRAINT "NetWorthValues_categoryOptionId_NetWorthCategoryOptions_id_fk" FOREIGN KEY ("categoryOptionId") REFERENCES "public"."NetWorthCategoryOptions" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "PlanningAccounts"
ADD CONSTRAINT "PlanningAccounts_accountId_NetWorthCategoryAssets_id_fk" FOREIGN KEY ("accountId") REFERENCES "public"."NetWorthCategoryAssets" ("id") ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "PlanningBills"
ADD CONSTRAINT "PlanningBills_fromAccountId_PlanningAccounts_accountId_fk" FOREIGN KEY ("fromAccountId") REFERENCES "public"."PlanningAccounts" ("accountId") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "PlanningBills"
ADD CONSTRAINT "PlanningBills_liabilityId_NetWorthCategoryLiabilities_id_fk" FOREIGN KEY ("liabilityId") REFERENCES "public"."NetWorthCategoryLiabilities" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "PlanningEarnings"
ADD CONSTRAINT "PlanningEarnings_toAccountId_PlanningAccounts_accountId_fk" FOREIGN KEY ("toAccountId") REFERENCES "public"."PlanningAccounts" ("accountId") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "PlanningEarnings"
ADD CONSTRAINT "PlanningEarnings_studentLoanLiabilityId_NetWorthCategoryLiabilities_id_fk" FOREIGN KEY ("studentLoanLiabilityId") REFERENCES "public"."NetWorthCategoryLiabilities" ("id") ON DELETE SET NULL ON UPDATE NO ACTION;

ALTER TABLE "PlanningEarnings"
ADD CONSTRAINT "PlanningEarnings_pensionAssetId_NetWorthCategoryAssets_id_fk" FOREIGN KEY ("pensionAssetId") REFERENCES "public"."NetWorthCategoryAssets" ("id") ON DELETE SET NULL ON UPDATE NO ACTION;

ALTER TABLE "PlanningEarningsParentalLeave"
ADD CONSTRAINT "PlanningEarningsParentalLeave_earningsId_PlanningEarnings_id_fk" FOREIGN KEY ("earningsId") REFERENCES "public"."PlanningEarnings" ("id") ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "PlanningEarningsUKTaxCodes"
ADD CONSTRAINT "PlanningEarningsUKTaxCodes_earningsId_PlanningEarnings_id_fk" FOREIGN KEY ("earningsId") REFERENCES "public"."PlanningEarnings" ("id") ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "PlanningMonthBills"
ADD CONSTRAINT "PlanningMonthBills_billId_PlanningBills_id_fk" FOREIGN KEY ("billId") REFERENCES "public"."PlanningBills" ("id") ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "PlanningMonthBills"
ADD CONSTRAINT "PlanningMonthBills_month_fk" FOREIGN KEY ("year", "date") REFERENCES "public"."PlanningMonths" ("year", "date") ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "PlanningMonths"
ADD CONSTRAINT "PlanningMonths_year_PlanningYears_year_fk" FOREIGN KEY ("year") REFERENCES "public"."PlanningYears" ("year") ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "PlanningPayslipAdjustments"
ADD CONSTRAINT "PlanningPayslipAdjustments_payslipId_PlanningPayslips_id_fk" FOREIGN KEY ("payslipId") REFERENCES "public"."PlanningPayslips" ("id") ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "PlanningPayslipAdjustments"
ADD CONSTRAINT "PlanningPayslipAdjustments_liabilityId_NetWorthCategoryLiabilities_id_fk" FOREIGN KEY ("liabilityId") REFERENCES "public"."NetWorthCategoryLiabilities" ("id") ON DELETE SET NULL ON UPDATE NO ACTION;

ALTER TABLE "PlanningPayslips"
ADD CONSTRAINT "PlanningPayslips_toAccountId_PlanningAccounts_accountId_fk" FOREIGN KEY ("toAccountId") REFERENCES "public"."PlanningAccounts" ("accountId") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "PlanningTransactions"
ADD CONSTRAINT "PlanningTransactions_accountId_PlanningAccounts_accountId_fk" FOREIGN KEY ("accountId") REFERENCES "public"."PlanningAccounts" ("accountId") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "PlanningTransactions"
ADD CONSTRAINT "PlanningTransactions_toAccountId_PlanningAccounts_accountId_fk" FOREIGN KEY ("toAccountId") REFERENCES "public"."PlanningAccounts" ("accountId") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "PlanningTransactions"
ADD CONSTRAINT "PlanningTransactions_liabilityId_NetWorthCategoryLiabilities_id_fk" FOREIGN KEY ("liabilityId") REFERENCES "public"."NetWorthCategoryLiabilities" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "PlanningTransactions"
ADD CONSTRAINT "PlanningTransactions_assetId_NetWorthCategoryAssets_id_fk" FOREIGN KEY ("assetId") REFERENCES "public"."NetWorthCategoryAssets" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "PlanningTransactions"
ADD CONSTRAINT "PlanningTransactions_month_fk" FOREIGN KEY ("year", "date") REFERENCES "public"."PlanningMonths" ("year", "date") ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "PlanningYearUKTaxRates"
ADD CONSTRAINT "PlanningYearUKTaxRates_year_PlanningYears_year_fk" FOREIGN KEY ("year") REFERENCES "public"."PlanningYears" ("year") ON DELETE CASCADE ON UPDATE NO ACTION;

CREATE INDEX "InvestmentDeposits_assetId_idx" ON "InvestmentDeposits" USING btree ("assetId");

CREATE INDEX "InvestmentDeposits_date" ON "InvestmentDeposits" USING btree ("date");

CREATE UNIQUE INDEX "InvestmentPrices_investmentId_date_uq" ON "InvestmentPrices" USING btree ("investmentId", "date");

CREATE INDEX "InvestmentPrices_date" ON "InvestmentPrices" USING btree ("date");

CREATE UNIQUE INDEX "InvestmentPrices_investmentId_isLatest_uq" ON "InvestmentPrices" USING btree ("investmentId", "isLatest")
WHERE
  "InvestmentPrices"."isLatest" IS NOT NULL;

CREATE UNIQUE INDEX "InvestmentStockSplits_investmentId_date_uq" ON "InvestmentStockSplits" USING btree ("investmentId", "date");

CREATE INDEX "InvestmentTransactions_investmentId_idx" ON "InvestmentTransactions" USING btree ("investmentId");

CREATE INDEX "InvestmentTransactions_assetId_idx" ON "InvestmentTransactions" USING btree ("assetId");

CREATE INDEX "InvestmentTransactions_date" ON "InvestmentTransactions" USING btree ("date");

CREATE UNIQUE INDEX "InvestmentTransfers_assetIdFrom_uq" ON "InvestmentTransfers" USING btree ("assetIdFrom");

CREATE INDEX "InvestmentTransfers_assetIdTo_idx" ON "InvestmentTransfers" USING btree ("assetIdTo");

CREATE UNIQUE INDEX "InvestmentValuePoints_investmentId_assetId_date_uq" ON "InvestmentValuePoints" USING btree ("investmentId", "assetId", "date");

CREATE INDEX "InvestmentValuePoints_assetId_date_idx" ON "InvestmentValuePoints" USING btree ("assetId", "date");

CREATE INDEX "InvestmentValuePoints_investmentId_date_idx" ON "InvestmentValuePoints" USING btree ("investmentId", "date");

CREATE UNIQUE INDEX "NetWorthEntries_month_uq" ON "NetWorthEntries" USING btree (date_trunc('month', "date"::timestamp));

CREATE UNIQUE INDEX "NetWorthValueAmounts_valueId_currency_uq" ON "NetWorthValueAmounts" USING btree ("valueId", "currency");

CREATE INDEX "NetWorthValues_entryId_idx" ON "NetWorthValues" USING btree ("entryId");

CREATE UNIQUE INDEX "PlanningMonths_year_month_uq" ON "PlanningMonths" USING btree ("year", date_trunc('month', "date"::timestamp));

CREATE FUNCTION "InvestmentPrices_computeAdjusted" (
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
$$;

ALTER TABLE "InvestmentValuePoints"
SET
  UNLOGGED;

ALTER TABLE "PlanningAccounts"
ADD CONSTRAINT "PlanningAccounts_sortOrder_uq" UNIQUE ("sortOrder") DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION "InvestmentPrices_setAdjusted_fn" () RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."priceAdjusted" := "InvestmentPrices_computeAdjusted"(
    NEW."investmentId", NEW.date, NEW.price
  );
  RETURN NEW;
END;
$$;

CREATE FUNCTION "InvestmentPrices_setIsLatest_stmt_fn" () RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  affected uuid[] := ARRAY[]::uuid[];
BEGIN
  -- The function re-enters via its own UPDATEs below. Without a column list
  -- (not permitted on transition-table triggers) the UPDATE trigger fires on
  -- every UPDATE including `isLatest = …`. Guard on `pg_trigger_depth()` so
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

  -- Clear every `isLatest` on the affected investments first so the partial
  -- unique index on `(investmentId, isLatest) WHERE isLatest IS NOT NULL`
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
$$;

CREATE FUNCTION "InvestmentStockSplits_recomputePrices_fn" () RETURNS trigger LANGUAGE plpgsql AS $$
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
$$;

CREATE FUNCTION "InvestmentValuePoints_refreshFromTrigger_fn" () RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  affected uuid[] := ARRAY[]::uuid[];
  from_date date := NULL;
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN NULL;
  END IF;

  -- Splits change every historic priceAdjusted and every historic
  -- adjUnits multiplier — leave from_date NULL so refresh_fn rebuilds
  -- the entire history for the affected investments. For Tx/Prices we
  -- gather MIN(date) across both transition tables; that's the earliest
  -- date whose IVP row could possibly change.
  IF TG_TABLE_NAME = 'InvestmentStockSplits' THEN
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
      affected := affected || ARRAY(SELECT DISTINCT "investmentId" FROM new_rows);
    END IF;
    IF TG_OP IN ('DELETE', 'UPDATE') THEN
      affected := affected || ARRAY(SELECT DISTINCT "investmentId" FROM old_rows);
    END IF;
  ELSE
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
      affected := affected || ARRAY(SELECT DISTINCT "investmentId" FROM new_rows);
      from_date := LEAST(from_date, (SELECT MIN(date) FROM new_rows));
    END IF;
    IF TG_OP IN ('DELETE', 'UPDATE') THEN
      affected := affected || ARRAY(SELECT DISTINCT "investmentId" FROM old_rows);
      from_date := LEAST(from_date, (SELECT MIN(date) FROM old_rows));
    END IF;
  END IF;

  IF cardinality(affected) = 0 THEN
    RETURN NULL;
  END IF;

  PERFORM "InvestmentValuePoints_refresh_fn"(
    ARRAY(SELECT DISTINCT unnest(affected)),
    from_date
  );
  RETURN NULL;
END;
$$;

CREATE FUNCTION "InvestmentValuePoints_refresh_fn" (p_ids UUID[], p_from_date date DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF cardinality(p_ids) = 0 THEN
    RETURN;
  END IF;

  IF p_from_date IS NULL THEN
    DELETE FROM "InvestmentValuePoints" WHERE "investmentId" = ANY(p_ids);
  ELSE
    DELETE FROM "InvestmentValuePoints"
     WHERE "investmentId" = ANY(p_ids)
       AND date >= p_from_date;
  END IF;

  INSERT INTO "InvestmentValuePoints"
    ("investmentId", "assetId", "date", "units", "value", "currency")
  WITH
    -- Per (investmentId, assetId): the date band to materialise.
    --
    -- first_date is the earliest day we re-insert for. It's clamped so we
    -- never insert rows for dates the caller asked us not to touch
    -- (>= p_from_date), but ALSO clamped so that if the new write extends
    -- the IVP series past the previously-materialised last_date, the gap
    -- between the surviving max IVP date and p_from_date gets filled in.
    -- Without this clamp, inserting a price that pushes last_date into a
    -- previously-unmaterialised future would leave the days between the
    -- old last_date and the new price absent from IVP.
    --
    -- last_date is max(latest tx, latest price) so days after the last
    -- "interesting" event aren't materialised (charts forward-fill).
    scope AS (
      SELECT
        t."investmentId",
        t."assetId",
        i.currency,
        GREATEST(
          MIN(t.date),
          LEAST(
            COALESCE(p_from_date, '0001-01-01'::date),
            COALESCE(
              (SELECT MAX(ivp.date) + 1
               FROM "InvestmentValuePoints" ivp
               WHERE ivp."investmentId" = t."investmentId"
                 AND ivp."assetId" = t."assetId"),
              '0001-01-01'::date
            )
          )
        ) AS first_date,
        GREATEST(
          MAX(t.date),
          (SELECT MAX(p.date) FROM "InvestmentPrices" p
            WHERE p."investmentId" = t."investmentId")
        ) AS last_date
      FROM "InvestmentTransactions" t
      INNER JOIN "Investments" i ON i.id = t."investmentId"
      WHERE t."investmentId" = ANY(p_ids)
      GROUP BY t."investmentId", t."assetId", i.currency
    ),
    days AS (
      SELECT s."investmentId", s."assetId", s.currency, gs::date AS date
      FROM scope s,
           generate_series(s.first_date, s.last_date, '1 day'::interval) gs
      WHERE s.first_date <= s.last_date
    ),
    -- Split-adjusted units cumulative through each day. Same shape as
    -- the tx_adj CTE in loadInvestmentStats — keep the ROUND(..., 6) so
    -- floating-point drift in EXP(SUM(LN(...))) doesn't surface as
    -- non-integer unit counts.
    units_per_day AS (
      SELECT
        d."investmentId", d."assetId", d.currency, d.date,
        COALESCE(SUM(
          ROUND((t.units * COALESCE(
            EXP((SELECT SUM(LN(s.ratio::double precision))
                 FROM "InvestmentStockSplits" s
                 WHERE s."investmentId" = t."investmentId"
                   AND s.date > t.date)),
            1
          ))::numeric, 6)
        ), 0)::double precision AS units
      FROM days d
      LEFT JOIN "InvestmentTransactions" t
        ON t."investmentId" = d."investmentId"
       AND t."assetId" = d."assetId"
       AND t.date <= d.date
      GROUP BY d."investmentId", d."assetId", d.currency, d.date
    ),
    -- Latest price ≤ d.date per investment. The (investmentId, date)
    -- unique index serves the ORDER BY DESC LIMIT 1 lookup directly.
    price_per_day AS (
      SELECT u.*,
             (SELECT p."priceAdjusted"
              FROM "InvestmentPrices" p
              WHERE p."investmentId" = u."investmentId"
                AND p.date <= u.date
              ORDER BY p.date DESC
              LIMIT 1) AS price_adj
      FROM units_per_day u
    )
  SELECT
    "investmentId", "assetId", date, units,
    CASE
      WHEN units = 0 THEN 0::bigint
      ELSE ROUND(units * price_adj)::bigint
    END AS "value",
    currency
  FROM price_per_day
  WHERE units = 0 OR price_adj IS NOT NULL;
END;
$$;

CREATE TRIGGER "InvestmentPrices_refreshValuePoints_del_trg"
AFTER DELETE ON "InvestmentPrices" REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
EXECUTE FUNCTION "InvestmentValuePoints_refreshFromTrigger_fn" ();

CREATE TRIGGER "InvestmentPrices_refreshValuePoints_ins_trg"
AFTER INSERT ON "InvestmentPrices" REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION "InvestmentValuePoints_refreshFromTrigger_fn" ();

CREATE TRIGGER "InvestmentPrices_refreshValuePoints_upd_trg"
AFTER
UPDATE ON "InvestmentPrices" REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION "InvestmentValuePoints_refreshFromTrigger_fn" ();

CREATE TRIGGER "InvestmentPrices_setAdjusted_trg" BEFORE INSERT
OR
UPDATE OF price,
date,
"investmentId" ON "InvestmentPrices" FOR EACH ROW
EXECUTE FUNCTION "InvestmentPrices_setAdjusted_fn" ();

CREATE TRIGGER "InvestmentPrices_setIsLatest_del_trg"
AFTER DELETE ON "InvestmentPrices" REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
EXECUTE FUNCTION "InvestmentPrices_setIsLatest_stmt_fn" ();

CREATE TRIGGER "InvestmentPrices_setIsLatest_ins_trg"
AFTER INSERT ON "InvestmentPrices" REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION "InvestmentPrices_setIsLatest_stmt_fn" ();

CREATE TRIGGER "InvestmentPrices_setIsLatest_upd_trg"
AFTER
UPDATE ON "InvestmentPrices" REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION "InvestmentPrices_setIsLatest_stmt_fn" ();

CREATE TRIGGER "InvestmentStockSplits_recomputePrices_trg"
AFTER INSERT
OR
UPDATE
OR DELETE ON "InvestmentStockSplits" FOR EACH ROW
EXECUTE FUNCTION "InvestmentStockSplits_recomputePrices_fn" ();

CREATE TRIGGER "InvestmentStockSplits_refreshValuePoints_del_trg"
AFTER DELETE ON "InvestmentStockSplits" REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
EXECUTE FUNCTION "InvestmentValuePoints_refreshFromTrigger_fn" ();

CREATE TRIGGER "InvestmentStockSplits_refreshValuePoints_ins_trg"
AFTER INSERT ON "InvestmentStockSplits" REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION "InvestmentValuePoints_refreshFromTrigger_fn" ();

CREATE TRIGGER "InvestmentStockSplits_refreshValuePoints_upd_trg"
AFTER
UPDATE ON "InvestmentStockSplits" REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION "InvestmentValuePoints_refreshFromTrigger_fn" ();

CREATE TRIGGER "InvestmentTransactions_refreshValuePoints_del_trg"
AFTER DELETE ON "InvestmentTransactions" REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
EXECUTE FUNCTION "InvestmentValuePoints_refreshFromTrigger_fn" ();

CREATE TRIGGER "InvestmentTransactions_refreshValuePoints_ins_trg"
AFTER INSERT ON "InvestmentTransactions" REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION "InvestmentValuePoints_refreshFromTrigger_fn" ();

CREATE TRIGGER "InvestmentTransactions_refreshValuePoints_upd_trg"
AFTER
UPDATE ON "InvestmentTransactions" REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION "InvestmentValuePoints_refreshFromTrigger_fn" ();

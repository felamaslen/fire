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
  'VEHICLE',
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
CREATE TABLE "DemoSessions" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "schema" text NOT NULL,
  "flavour" text NOT NULL,
  "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL,
  CONSTRAINT "DemoSessions_schema_unique" UNIQUE ("schema")
);

CREATE TABLE "InvestmentAllocations" (
  "assetId" uuid NOT NULL,
  "investmentId" uuid NOT NULL,
  "allocation" DOUBLE PRECISION NOT NULL,
  "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  CONSTRAINT "InvestmentAllocations_pk" PRIMARY KEY ("assetId", "investmentId"),
  CONSTRAINT "InvestmentAllocations_allocation_ck"
    CHECK (
      "InvestmentAllocations"."allocation" > 0
      AND "InvestmentAllocations"."allocation" <= 1
    )
);

CREATE TABLE "InvestmentPrices" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "investmentId" uuid NOT NULL,
  "date" date NOT NULL,
  "price" DOUBLE PRECISION NOT NULL,
  "priceAdjusted" DOUBLE PRECISION DEFAULT 0 NOT NULL,
  "isLatest" BOOLEAN,
  "currency" "CurrencyCode" NOT NULL,
  "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  CONSTRAINT "InvestmentPrices_price_ck"
    CHECK ("InvestmentPrices"."price" >= 0),
  CONSTRAINT "InvestmentPrices_priceAdjusted_ck"
    CHECK ("InvestmentPrices"."priceAdjusted" >= 0),
  CONSTRAINT "InvestmentPrices_isLatest_ck"
    CHECK (
      "InvestmentPrices"."isLatest" IS NULL
      OR "InvestmentPrices"."isLatest" = TRUE
    )
);

CREATE TABLE "InvestmentStockSplits" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "investmentId" uuid NOT NULL,
  "date" date NOT NULL,
  "ratio" NUMERIC(20, 10) NOT NULL,
  "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  CONSTRAINT "InvestmentStockSplits_ratio_ck"
    CHECK ("InvestmentStockSplits"."ratio" > 0)
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
  "growthRate" NUMERIC(6, 4),
  "accessibleFrom" date,
  "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  CONSTRAINT "NetWorthCategoryAssets_growthRate_ck"
    CHECK (
      "NetWorthCategoryAssets"."growthRate" IS NULL
      OR "NetWorthCategoryAssets"."type" IN ('PROPERTY', 'VEHICLE')
    ),
  CONSTRAINT "NetWorthCategoryAssets_accessibleFrom_ck"
    CHECK (
      "NetWorthCategoryAssets"."accessibleFrom" IS NULL
      OR "NetWorthCategoryAssets"."type" = 'PENSION'
    )
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
  "priceStrike" DOUBLE PRECISION NOT NULL,
  "priceMarket" DOUBLE PRECISION,
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
  "sortOrder" INTEGER DEFAULT 0 NOT NULL,
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
  "pensionAssetId" uuid,
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
    ),
  CONSTRAINT "PlanningEarnings_pensionAsset_ck"
    CHECK (
      "PlanningEarnings"."pensionAssetId" IS NULL
      OR (
        "PlanningEarnings"."pensionSalarySacrifice" IS NOT NULL
        OR "PlanningEarnings"."pensionNetPay" IS NOT NULL
        OR "PlanningEarnings"."pensionReliefAtSource" IS NOT NULL
      )
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

CREATE TABLE "AppSettings" (
  "singleton" BOOLEAN PRIMARY KEY NOT NULL,
  "cashAllocationAmount" BIGINT,
  "cashAllocationCurrency" "CurrencyCode",
  "retirementYear" INTEGER,
  "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  CONSTRAINT "AppSettings_singleton_ck"
    CHECK ("AppSettings"."singleton" = TRUE),
  CONSTRAINT "AppSettings_cashAllocationAmount_ck"
    CHECK (
      "AppSettings"."cashAllocationAmount" IS NULL
      OR "AppSettings"."cashAllocationAmount" >= 0
    ),
  CONSTRAINT "AppSettings_cashAllocationPair_ck"
    CHECK (
      ("AppSettings"."cashAllocationAmount" IS NULL) = (
        "AppSettings"."cashAllocationCurrency" IS NULL
      )
    ),
  CONSTRAINT "AppSettings_retirementYear_ck"
    CHECK (
      "AppSettings"."retirementYear" IS NULL
      OR "AppSettings"."retirementYear" BETWEEN 1900 AND 2200
    )
);

ALTER TABLE "InvestmentAllocations"
ADD CONSTRAINT "InvestmentAllocations_assetId_NetWorthCategoryAssets_id_fk"
  FOREIGN KEY ("assetId") REFERENCES "public"."NetWorthCategoryAssets" ("id")
    ON DELETE CASCADE
    ON UPDATE NO ACTION;
ALTER TABLE "InvestmentAllocations"
ADD CONSTRAINT "InvestmentAllocations_investmentId_Investments_id_fk"
  FOREIGN KEY ("investmentId") REFERENCES "public"."Investments" ("id")
    ON DELETE CASCADE
    ON UPDATE NO ACTION;
ALTER TABLE "InvestmentPrices"
ADD CONSTRAINT "InvestmentPrices_investmentId_Investments_id_fk"
  FOREIGN KEY ("investmentId") REFERENCES "public"."Investments" ("id")
    ON DELETE CASCADE
    ON UPDATE NO ACTION;
ALTER TABLE "InvestmentStockSplits"
ADD CONSTRAINT "InvestmentStockSplits_investmentId_Investments_id_fk"
  FOREIGN KEY ("investmentId") REFERENCES "public"."Investments" ("id")
    ON DELETE CASCADE
    ON UPDATE NO ACTION;
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
ADD CONSTRAINT "PlanningEarnings_pensionAssetId_NetWorthCategoryAssets_id_fk"
  FOREIGN KEY ("pensionAssetId") REFERENCES "public"."NetWorthCategoryAssets" (
    "id"
  )
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
CREATE UNIQUE INDEX "InvestmentPrices_investmentId_date_uq" ON "InvestmentPrices" USING btree (
  "investmentId",
  "date"
);
CREATE INDEX "InvestmentPrices_date" ON "InvestmentPrices" USING btree ("date");
CREATE UNIQUE INDEX "InvestmentPrices_investmentId_isLatest_uq" ON "InvestmentPrices" USING btree (
  "investmentId",
  "isLatest"
)
WHERE "InvestmentPrices"."isLatest" IS NOT NULL;
CREATE UNIQUE INDEX "InvestmentStockSplits_investmentId_date_uq" ON "InvestmentStockSplits" USING btree (
  "investmentId",
  "date"
);
CREATE INDEX "InvestmentTransactions_investmentId_idx" ON "InvestmentTransactions" USING btree (
  "investmentId"
);
CREATE INDEX "InvestmentTransactions_assetId_idx" ON "InvestmentTransactions" USING btree (
  "assetId"
);
CREATE INDEX "InvestmentTransactions_date" ON "InvestmentTransactions" USING btree (
  "date"
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
CREATE VIEW "public"."InvestmentPortfolioDailyBreakdown" AS
  (
    WITH
      "priceRange" AS (
        SELECT MIN(date) AS "startDate", MAX(date) AS "endDate"
        FROM "InvestmentPrices"
      ),
      days AS (
        SELECT
          generate_series(
            "startDate",
            "endDate",
            '1 day'::INTERVAL
          )::date AS date
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
            (
              SELECT SUM(t.units)
              FROM "InvestmentTransactions" AS t
              WHERE
                t."assetId" = h."assetId"
                AND t."investmentId" = h."investmentId"
                AND t.date <= d.date
            ),
            0
          ) AS units
        FROM
          holdings AS h
          CROSS JOIN days AS d
      ),
      "priceByDay" AS (
        SELECT
          h."investmentId",
          d.date,
          (
            SELECT p.price
            FROM "InvestmentPrices" AS p
            WHERE p."investmentId" = h."investmentId" AND p.date <= d.date
            ORDER BY p.date DESC
            LIMIT 1
          ) AS price
        FROM
          (SELECT DISTINCT "investmentId" FROM holdings) AS h
          CROSS JOIN days AS d
      )
    SELECT
      i.currency,
      u."assetId",
      u.date,
      SUM(u.units * p.price) AS amount
    FROM
      "unitsByDay" AS u
      JOIN "Investments" AS i ON i.id = u."investmentId"
      JOIN "priceByDay" AS p
        ON p."investmentId" = u."investmentId" AND p.date = u.date
    WHERE p.price IS NOT NULL AND u.units != 0
    GROUP BY i.currency, u."assetId", u.date
  );

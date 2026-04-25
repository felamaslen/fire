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
    OR "InvestmentPrices"."isLatest" = true
  )
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
  "units" bigint NOT NULL,
  "price" double precision NOT NULL,
  "taxes" bigint DEFAULT 0 NOT NULL,
  "fees" bigint DEFAULT 0 NOT NULL,
  "currency" "CurrencyCode" NOT NULL,
  "date" date NOT NULL,
  "drip" boolean DEFAULT false NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "InvestmentTransactions_price_ck" CHECK ("InvestmentTransactions"."price" >= 0),
  CONSTRAINT "InvestmentTransactions_taxes_ck" CHECK ("InvestmentTransactions"."taxes" >= 0),
  CONSTRAINT "InvestmentTransactions_fees_ck" CHECK ("InvestmentTransactions"."fees" >= 0)
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
  "skip" boolean DEFAULT false NOT NULL,
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
  "sortOrder" integer DEFAULT 0 NOT NULL
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
  "studentLoanPlan2" boolean DEFAULT false NOT NULL,
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
    OR "PlanningEarnings"."studentLoanPlan2" = true
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
  CONSTRAINT "PlanningTransactions_accounts_ck" CHECK (
    "PlanningTransactions"."toAccountId" IS NULL
    OR "PlanningTransactions"."accountId" <> "PlanningTransactions"."toAccountId"
  ),
  CONSTRAINT "PlanningTransactions_inflow_ck" CHECK (
    "PlanningTransactions"."amount" <= 0
    OR (
      "PlanningTransactions"."toAccountId" IS NULL
      AND "PlanningTransactions"."liabilityId" IS NULL
      AND "PlanningTransactions"."assetId" IS NULL
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
  CONSTRAINT "AppSettings_singleton_ck" CHECK ("AppSettings"."singleton" = true),
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
ADD CONSTRAINT "InvestmentAllocations_assetId_NetWorthCategoryAssets_id_fk" FOREIGN KEY ("assetId") REFERENCES "public"."NetWorthCategoryAssets" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "InvestmentAllocations"
ADD CONSTRAINT "InvestmentAllocations_investmentId_Investments_id_fk" FOREIGN KEY ("investmentId") REFERENCES "public"."Investments" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "InvestmentPrices"
ADD CONSTRAINT "InvestmentPrices_investmentId_Investments_id_fk" FOREIGN KEY ("investmentId") REFERENCES "public"."Investments" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "InvestmentStockSplits"
ADD CONSTRAINT "InvestmentStockSplits_investmentId_Investments_id_fk" FOREIGN KEY ("investmentId") REFERENCES "public"."Investments" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "InvestmentTransactions"
ADD CONSTRAINT "InvestmentTransactions_investmentId_Investments_id_fk" FOREIGN KEY ("investmentId") REFERENCES "public"."Investments" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "InvestmentTransactions"
ADD CONSTRAINT "InvestmentTransactions_assetId_NetWorthCategoryAssets_id_fk" FOREIGN KEY ("assetId") REFERENCES "public"."NetWorthCategoryAssets" ("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "NetWorthCategoryLiabilities"
ADD CONSTRAINT "NetWorthCategoryLiabilities_categoryAssetId_NetWorthCategoryAssets_id_fk" FOREIGN KEY ("categoryAssetId") REFERENCES "public"."NetWorthCategoryAssets" ("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "NetWorthCategoryLiabilities"
ADD CONSTRAINT "NetWorthCategoryLiabilities_billedFromAccountId_PlanningAccounts_accountId_fk" FOREIGN KEY ("billedFromAccountId") REFERENCES "public"."PlanningAccounts" ("accountId") ON DELETE set null ON UPDATE no action;

ALTER TABLE "NetWorthCurrencyRates"
ADD CONSTRAINT "NetWorthCurrencyRates_entryId_NetWorthEntries_id_fk" FOREIGN KEY ("entryId") REFERENCES "public"."NetWorthEntries" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "NetWorthValueAmounts"
ADD CONSTRAINT "NetWorthValueAmounts_valueId_NetWorthValues_id_fk" FOREIGN KEY ("valueId") REFERENCES "public"."NetWorthValues" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "NetWorthValueOptions"
ADD CONSTRAINT "NetWorthValueOptions_valueId_NetWorthValues_id_fk" FOREIGN KEY ("valueId") REFERENCES "public"."NetWorthValues" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "NetWorthValues"
ADD CONSTRAINT "NetWorthValues_entryId_NetWorthEntries_id_fk" FOREIGN KEY ("entryId") REFERENCES "public"."NetWorthEntries" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "NetWorthValues"
ADD CONSTRAINT "NetWorthValues_categoryAssetId_NetWorthCategoryAssets_id_fk" FOREIGN KEY ("categoryAssetId") REFERENCES "public"."NetWorthCategoryAssets" ("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "NetWorthValues"
ADD CONSTRAINT "NetWorthValues_categoryLiabilityId_NetWorthCategoryLiabilities_id_fk" FOREIGN KEY ("categoryLiabilityId") REFERENCES "public"."NetWorthCategoryLiabilities" ("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "NetWorthValues"
ADD CONSTRAINT "NetWorthValues_categoryOptionId_NetWorthCategoryOptions_id_fk" FOREIGN KEY ("categoryOptionId") REFERENCES "public"."NetWorthCategoryOptions" ("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "PlanningAccounts"
ADD CONSTRAINT "PlanningAccounts_accountId_NetWorthCategoryAssets_id_fk" FOREIGN KEY ("accountId") REFERENCES "public"."NetWorthCategoryAssets" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "PlanningBills"
ADD CONSTRAINT "PlanningBills_fromAccountId_PlanningAccounts_accountId_fk" FOREIGN KEY ("fromAccountId") REFERENCES "public"."PlanningAccounts" ("accountId") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "PlanningBills"
ADD CONSTRAINT "PlanningBills_liabilityId_NetWorthCategoryLiabilities_id_fk" FOREIGN KEY ("liabilityId") REFERENCES "public"."NetWorthCategoryLiabilities" ("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "PlanningEarnings"
ADD CONSTRAINT "PlanningEarnings_toAccountId_PlanningAccounts_accountId_fk" FOREIGN KEY ("toAccountId") REFERENCES "public"."PlanningAccounts" ("accountId") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "PlanningEarnings"
ADD CONSTRAINT "PlanningEarnings_studentLoanLiabilityId_NetWorthCategoryLiabilities_id_fk" FOREIGN KEY ("studentLoanLiabilityId") REFERENCES "public"."NetWorthCategoryLiabilities" ("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "PlanningEarnings"
ADD CONSTRAINT "PlanningEarnings_pensionAssetId_NetWorthCategoryAssets_id_fk" FOREIGN KEY ("pensionAssetId") REFERENCES "public"."NetWorthCategoryAssets" ("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "PlanningEarningsUKTaxCodes"
ADD CONSTRAINT "PlanningEarningsUKTaxCodes_earningsId_PlanningEarnings_id_fk" FOREIGN KEY ("earningsId") REFERENCES "public"."PlanningEarnings" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "PlanningMonthBills"
ADD CONSTRAINT "PlanningMonthBills_billId_PlanningBills_id_fk" FOREIGN KEY ("billId") REFERENCES "public"."PlanningBills" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "PlanningMonthBills"
ADD CONSTRAINT "PlanningMonthBills_month_fk" FOREIGN KEY ("year", "date") REFERENCES "public"."PlanningMonths" ("year", "date") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "PlanningMonths"
ADD CONSTRAINT "PlanningMonths_year_PlanningYears_year_fk" FOREIGN KEY ("year") REFERENCES "public"."PlanningYears" ("year") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "PlanningPayslipAdjustments"
ADD CONSTRAINT "PlanningPayslipAdjustments_payslipId_PlanningPayslips_id_fk" FOREIGN KEY ("payslipId") REFERENCES "public"."PlanningPayslips" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "PlanningPayslipAdjustments"
ADD CONSTRAINT "PlanningPayslipAdjustments_liabilityId_NetWorthCategoryLiabilities_id_fk" FOREIGN KEY ("liabilityId") REFERENCES "public"."NetWorthCategoryLiabilities" ("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "PlanningPayslips"
ADD CONSTRAINT "PlanningPayslips_toAccountId_PlanningAccounts_accountId_fk" FOREIGN KEY ("toAccountId") REFERENCES "public"."PlanningAccounts" ("accountId") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "PlanningTransactions"
ADD CONSTRAINT "PlanningTransactions_accountId_PlanningAccounts_accountId_fk" FOREIGN KEY ("accountId") REFERENCES "public"."PlanningAccounts" ("accountId") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "PlanningTransactions"
ADD CONSTRAINT "PlanningTransactions_toAccountId_PlanningAccounts_accountId_fk" FOREIGN KEY ("toAccountId") REFERENCES "public"."PlanningAccounts" ("accountId") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "PlanningTransactions"
ADD CONSTRAINT "PlanningTransactions_liabilityId_NetWorthCategoryLiabilities_id_fk" FOREIGN KEY ("liabilityId") REFERENCES "public"."NetWorthCategoryLiabilities" ("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "PlanningTransactions"
ADD CONSTRAINT "PlanningTransactions_assetId_NetWorthCategoryAssets_id_fk" FOREIGN KEY ("assetId") REFERENCES "public"."NetWorthCategoryAssets" ("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "PlanningTransactions"
ADD CONSTRAINT "PlanningTransactions_month_fk" FOREIGN KEY ("year", "date") REFERENCES "public"."PlanningMonths" ("year", "date") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "PlanningYearUKTaxRates"
ADD CONSTRAINT "PlanningYearUKTaxRates_year_PlanningYears_year_fk" FOREIGN KEY ("year") REFERENCES "public"."PlanningYears" ("year") ON DELETE cascade ON UPDATE no action;

CREATE UNIQUE INDEX "InvestmentPrices_investmentId_date_uq" ON "InvestmentPrices" USING btree ("investmentId", "date");

CREATE INDEX "InvestmentPrices_date" ON "InvestmentPrices" USING btree ("date");

CREATE UNIQUE INDEX "InvestmentPrices_investmentId_isLatest_uq" ON "InvestmentPrices" USING btree ("investmentId", "isLatest")
WHERE
  "InvestmentPrices"."isLatest" IS NOT NULL;

CREATE UNIQUE INDEX "InvestmentStockSplits_investmentId_date_uq" ON "InvestmentStockSplits" USING btree ("investmentId", "date");

CREATE INDEX "InvestmentTransactions_investmentId_idx" ON "InvestmentTransactions" USING btree ("investmentId");

CREATE INDEX "InvestmentTransactions_assetId_idx" ON "InvestmentTransactions" USING btree ("assetId");

CREATE INDEX "InvestmentTransactions_date" ON "InvestmentTransactions" USING btree ("date");

CREATE UNIQUE INDEX "NetWorthEntries_month_uq" ON "NetWorthEntries" USING btree (date_trunc('month', "date"::timestamp));

CREATE UNIQUE INDEX "NetWorthValueAmounts_valueId_currency_uq" ON "NetWorthValueAmounts" USING btree ("valueId", "currency");

CREATE INDEX "NetWorthValues_entryId_idx" ON "NetWorthValues" USING btree ("entryId");

CREATE UNIQUE INDEX "PlanningMonths_year_month_uq" ON "PlanningMonths" USING btree ("year", date_trunc('month', "date"::timestamp));

CREATE VIEW "public"."InvestmentPortfolioDailyBreakdown" AS (
  WITH
    "priceRange" AS (
      SELECT
        MIN(date) AS "startDate",
        MAX(date) AS "endDate"
      FROM
        "InvestmentPrices"
    ),
    days AS (
      SELECT
        generate_series("startDate", "endDate", '1 day'::interval)::date AS date
      FROM
        "priceRange"
      WHERE
        "startDate" IS NOT NULL
    ),
    holdings AS (
      SELECT DISTINCT
        "assetId",
        "investmentId"
      FROM
        "InvestmentTransactions"
    ),
    "unitsByDay" AS (
      SELECT
        h."assetId",
        h."investmentId",
        d.date,
        COALESCE(
          (
            SELECT
              SUM(t.units)
            FROM
              "InvestmentTransactions" t
            WHERE
              t."assetId" = h."assetId"
              AND t."investmentId" = h."investmentId"
              AND t.date <= d.date
          ),
          0
        ) AS units
      FROM
        holdings h
        CROSS JOIN days d
    ),
    "priceByDay" AS (
      SELECT
        h."investmentId",
        d.date,
        (
          SELECT
            p.price
          FROM
            "InvestmentPrices" p
          WHERE
            p."investmentId" = h."investmentId"
            AND p.date <= d.date
          ORDER BY
            p.date DESC
          LIMIT
            1
        ) AS price
      FROM
        (
          SELECT DISTINCT
            "investmentId"
          FROM
            holdings
        ) h
        CROSS JOIN days d
    )
  SELECT
    i.currency,
    u."assetId",
    u.date,
    SUM(u.units * p.price) AS amount
  FROM
    "unitsByDay" u
    JOIN "Investments" i ON i.id = u."investmentId"
    JOIN "priceByDay" p ON p."investmentId" = u."investmentId"
    AND p.date = u.date
  WHERE
    p.price IS NOT NULL
    AND u.units <> 0
  GROUP BY
    i.currency,
    u."assetId",
    u.date
);

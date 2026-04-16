CREATE TYPE "public"."netWorthCategoryAssetType" AS ENUM (
  'CASH',
  'STOCK',
  'OPTION',
  'PENSION',
  'PROPERTY',
  'MISC'
); -- > statement-breakpoint
CREATE TYPE "public"."netWorthCategoryLiabilityType" AS ENUM (
  'CREDIT_CARD',
  'LOAN',
  'MISC'
); -- > statement-breakpoint
CREATE TABLE "NetWorthCategoryAssets" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "name" text NOT NULL,
  "type" "netWorthCategoryAssetType" NOT NULL,
  "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL
);
-- > statement-breakpoint
CREATE TABLE "NetWorthCategoryLiabilities" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "name" text NOT NULL,
  "type" "netWorthCategoryLiabilityType" NOT NULL,
  "categoryAssetId" uuid,
  "interestRate" NUMERIC(6, 4),
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
    )
);
-- > statement-breakpoint
CREATE TABLE "NetWorthCategoryOptions" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "name" text NOT NULL,
  "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL
);
-- > statement-breakpoint
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
-- > statement-breakpoint
CREATE TABLE "NetWorthEntries" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "date" date NOT NULL,
  "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL
);
-- > statement-breakpoint
CREATE TABLE "NetWorthValueAmounts" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "valueId" uuid NOT NULL,
  "amount" BIGINT NOT NULL,
  "currency" "CurrencyCode" NOT NULL,
  "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL
);
-- > statement-breakpoint
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
-- > statement-breakpoint
ALTER TABLE "NetWorthCategoryLiabilities"
ADD CONSTRAINT "NetWorthCategoryLiabilities_categoryAssetId_NetWorthCategoryAssets_id_fk"
  FOREIGN KEY ("categoryAssetId") REFERENCES "public"."NetWorthCategoryAssets" (
    "id"
  )
    ON DELETE SET NULL
    ON UPDATE NO ACTION; -- > statement-breakpoint
ALTER TABLE "NetWorthCurrencyRates"
ADD CONSTRAINT "NetWorthCurrencyRates_entryId_NetWorthEntries_id_fk"
  FOREIGN KEY ("entryId") REFERENCES "public"."NetWorthEntries" ("id")
    ON DELETE CASCADE
    ON UPDATE NO ACTION; -- > statement-breakpoint
ALTER TABLE "NetWorthValueAmounts"
ADD CONSTRAINT "NetWorthValueAmounts_valueId_NetWorthValues_id_fk"
  FOREIGN KEY ("valueId") REFERENCES "public"."NetWorthValues" ("id")
    ON DELETE CASCADE
    ON UPDATE NO ACTION; -- > statement-breakpoint
ALTER TABLE "NetWorthValues"
ADD CONSTRAINT "NetWorthValues_entryId_NetWorthEntries_id_fk"
  FOREIGN KEY ("entryId") REFERENCES "public"."NetWorthEntries" ("id")
    ON DELETE CASCADE
    ON UPDATE NO ACTION; -- > statement-breakpoint
ALTER TABLE "NetWorthValues"
ADD CONSTRAINT "NetWorthValues_categoryAssetId_NetWorthCategoryAssets_id_fk"
  FOREIGN KEY ("categoryAssetId") REFERENCES "public"."NetWorthCategoryAssets" (
    "id"
  )
    ON DELETE RESTRICT
    ON UPDATE NO ACTION; -- > statement-breakpoint
ALTER TABLE "NetWorthValues"
ADD CONSTRAINT "NetWorthValues_categoryLiabilityId_NetWorthCategoryLiabilities_id_fk"
  FOREIGN KEY (
    "categoryLiabilityId"
  ) REFERENCES "public"."NetWorthCategoryLiabilities" ("id")
    ON DELETE RESTRICT
    ON UPDATE NO ACTION; -- > statement-breakpoint
ALTER TABLE "NetWorthValues"
ADD CONSTRAINT "NetWorthValues_categoryOptionId_NetWorthCategoryOptions_id_fk"
  FOREIGN KEY (
    "categoryOptionId"
  ) REFERENCES "public"."NetWorthCategoryOptions" ("id")
    ON DELETE RESTRICT
    ON UPDATE NO ACTION; -- > statement-breakpoint
CREATE UNIQUE INDEX "NetWorthEntries_month_uq" ON "NetWorthEntries" USING btree (
  date_trunc('month', "date"::TIMESTAMP)
); -- > statement-breakpoint
CREATE UNIQUE INDEX "NetWorthValueAmounts_valueId_currency_uq" ON "NetWorthValueAmounts" USING btree (
  "valueId",
  "currency"
); -- > statement-breakpoint
CREATE INDEX "NetWorthValues_entryId_idx" ON "NetWorthValues" USING btree (
  "entryId"
);

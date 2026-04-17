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
-- > statement-breakpoint
ALTER TABLE "NetWorthCategoryLiabilities"
ADD COLUMN "skip" BOOLEAN DEFAULT FALSE NOT NULL; -- > statement-breakpoint
ALTER TABLE "PlanningPayslipAdjustments" ADD COLUMN "liabilityId" uuid; -- > statement-breakpoint
ALTER TABLE "NetWorthValueOptions"
ADD CONSTRAINT "NetWorthValueOptions_valueId_NetWorthValues_id_fk"
  FOREIGN KEY ("valueId") REFERENCES "public"."NetWorthValues" ("id")
    ON DELETE CASCADE
    ON UPDATE NO ACTION; -- > statement-breakpoint
ALTER TABLE "PlanningPayslipAdjustments"
ADD CONSTRAINT "PlanningPayslipAdjustments_liabilityId_NetWorthCategoryLiabilities_id_fk"
  FOREIGN KEY (
    "liabilityId"
  ) REFERENCES "public"."NetWorthCategoryLiabilities" ("id")
    ON DELETE SET NULL
    ON UPDATE NO ACTION;

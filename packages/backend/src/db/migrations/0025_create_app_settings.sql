CREATE TABLE "AppSettings" (
	"singleton" boolean PRIMARY KEY NOT NULL,
	"cashAllocationAmount" bigint,
	"cashAllocationCurrency" "CurrencyCode",
	"retirementYear" integer,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "AppSettings_singleton_ck" CHECK ("AppSettings"."singleton" = true),
	CONSTRAINT "AppSettings_cashAllocationAmount_ck" CHECK ("AppSettings"."cashAllocationAmount" IS NULL OR "AppSettings"."cashAllocationAmount" >= 0),
	CONSTRAINT "AppSettings_cashAllocationPair_ck" CHECK (("AppSettings"."cashAllocationAmount" IS NULL) = ("AppSettings"."cashAllocationCurrency" IS NULL)),
	CONSTRAINT "AppSettings_retirementYear_ck" CHECK ("AppSettings"."retirementYear" IS NULL OR "AppSettings"."retirementYear" BETWEEN 1900 AND 2200)
);
--> statement-breakpoint
INSERT INTO "AppSettings" ("singleton", "cashAllocationAmount", "cashAllocationCurrency")
SELECT true, "amount", "currency" FROM "InvestmentCashAllocation" WHERE "singleton" = true;
--> statement-breakpoint
DROP TABLE "InvestmentCashAllocation";

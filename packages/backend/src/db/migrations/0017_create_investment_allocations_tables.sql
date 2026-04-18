CREATE TABLE "InvestmentAllocations" (
	"assetId" uuid NOT NULL,
	"investmentId" uuid NOT NULL,
	"allocation" double precision NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "InvestmentAllocations_pk" PRIMARY KEY("assetId","investmentId"),
	CONSTRAINT "InvestmentAllocations_allocation_ck" CHECK ("InvestmentAllocations"."allocation" > 0 AND "InvestmentAllocations"."allocation" <= 1)
);
--> statement-breakpoint
CREATE TABLE "InvestmentCashAllocation" (
	"singleton" boolean PRIMARY KEY NOT NULL,
	"allocation" double precision NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "InvestmentCashAllocation_singleton_ck" CHECK ("InvestmentCashAllocation"."singleton" = true),
	CONSTRAINT "InvestmentCashAllocation_allocation_ck" CHECK ("InvestmentCashAllocation"."allocation" >= 0 AND "InvestmentCashAllocation"."allocation" <= 1)
);
--> statement-breakpoint
ALTER TABLE "InvestmentAllocations" ADD CONSTRAINT "InvestmentAllocations_assetId_NetWorthCategoryAssets_id_fk" FOREIGN KEY ("assetId") REFERENCES "public"."NetWorthCategoryAssets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "InvestmentAllocations" ADD CONSTRAINT "InvestmentAllocations_investmentId_Investments_id_fk" FOREIGN KEY ("investmentId") REFERENCES "public"."Investments"("id") ON DELETE cascade ON UPDATE no action;
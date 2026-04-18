CREATE TABLE "InvestmentStockSplits" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"investmentId" uuid NOT NULL,
	"date" date NOT NULL,
	"ratio" numeric(20, 10) NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "InvestmentStockSplits_ratio_ck" CHECK ("InvestmentStockSplits"."ratio" > 0)
);
--> statement-breakpoint
ALTER TABLE "InvestmentStockSplits" ADD CONSTRAINT "InvestmentStockSplits_investmentId_Investments_id_fk" FOREIGN KEY ("investmentId") REFERENCES "public"."Investments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "InvestmentStockSplits_investmentId_date_uq" ON "InvestmentStockSplits" USING btree ("investmentId","date");
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
--> statement-breakpoint
ALTER TABLE "InvestmentTransactions" ADD CONSTRAINT "InvestmentTransactions_investmentId_Investments_id_fk" FOREIGN KEY ("investmentId") REFERENCES "public"."Investments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "InvestmentTransactions" ADD CONSTRAINT "InvestmentTransactions_assetId_NetWorthCategoryAssets_id_fk" FOREIGN KEY ("assetId") REFERENCES "public"."NetWorthCategoryAssets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "InvestmentTransactions_investmentId_idx" ON "InvestmentTransactions" USING btree ("investmentId");--> statement-breakpoint
CREATE INDEX "InvestmentTransactions_assetId_idx" ON "InvestmentTransactions" USING btree ("assetId");
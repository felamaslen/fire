CREATE TABLE "InvestmentPrices" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"investmentId" uuid NOT NULL,
	"date" date NOT NULL,
	"price" double precision NOT NULL,
	"priceAdjusted" double precision DEFAULT 0 NOT NULL,
	"currency" "CurrencyCode" NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "InvestmentPrices_price_ck" CHECK ("InvestmentPrices"."price" >= 0),
	CONSTRAINT "InvestmentPrices_priceAdjusted_ck" CHECK ("InvestmentPrices"."priceAdjusted" >= 0)
);
--> statement-breakpoint
ALTER TABLE "InvestmentPrices" ADD CONSTRAINT "InvestmentPrices_investmentId_Investments_id_fk" FOREIGN KEY ("investmentId") REFERENCES "public"."Investments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "InvestmentPrices_investmentId_date_uq" ON "InvestmentPrices" USING btree ("investmentId","date");
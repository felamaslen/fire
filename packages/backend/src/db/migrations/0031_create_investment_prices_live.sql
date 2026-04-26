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
--> statement-breakpoint
ALTER TABLE "InvestmentPricesLive" ADD CONSTRAINT "InvestmentPricesLive_investmentId_Investments_id_fk" FOREIGN KEY ("investmentId") REFERENCES "public"."Investments"("id") ON DELETE cascade ON UPDATE no action;
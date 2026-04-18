CREATE TABLE "Investments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"stockCode" text,
	"fundLink" text,
	"currency" "CurrencyCode" NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "Investments_stockCode_fundLink_ck" CHECK (("Investments"."stockCode" IS NOT NULL)::int + ("Investments"."fundLink" IS NOT NULL)::int = 1)
);

CREATE TABLE "public"."InvestmentDeposits" (
  "id" uuid NOT NULL DEFAULT uuidv7(),
  "assetId" uuid NOT NULL,
  "date" date NOT NULL,
  "amount" bigint NOT NULL,
  "currency" "CurrencyCode" NOT NULL,
  "name" text NOT NULL,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "InvestmentDeposits_assetId_idx" ON public."InvestmentDeposits" USING btree ("assetId");

CREATE INDEX "InvestmentDeposits_date" ON public."InvestmentDeposits" USING btree (date);

CREATE UNIQUE INDEX "InvestmentDeposits_pkey" ON public."InvestmentDeposits" USING btree (id);

ALTER TABLE "public"."InvestmentDeposits"
ADD CONSTRAINT "InvestmentDeposits_pkey" PRIMARY KEY USING index "InvestmentDeposits_pkey";

ALTER TABLE "public"."InvestmentDeposits"
ADD CONSTRAINT "InvestmentDeposits_assetId_NetWorthCategoryAssets_id_fk" FOREIGN KEY ("assetId") REFERENCES "NetWorthCategoryAssets" (id) ON DELETE CASCADE NOT valid;

ALTER TABLE "public"."InvestmentDeposits" validate CONSTRAINT "InvestmentDeposits_assetId_NetWorthCategoryAssets_id_fk";

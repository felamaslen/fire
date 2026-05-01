CREATE TABLE "public"."InvestmentTransfers" (
  "id" uuid NOT NULL DEFAULT uuidv7(),
  "assetIdFrom" uuid NOT NULL,
  "assetIdTo" uuid NOT NULL,
  "date" date NOT NULL,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "InvestmentTransfers_assetIdFrom_uq" ON public."InvestmentTransfers" USING btree ("assetIdFrom");

CREATE INDEX "InvestmentTransfers_assetIdTo_idx" ON public."InvestmentTransfers" USING btree ("assetIdTo");

CREATE UNIQUE INDEX "InvestmentTransfers_pkey" ON public."InvestmentTransfers" USING btree (id);

ALTER TABLE "public"."InvestmentTransfers"
ADD CONSTRAINT "InvestmentTransfers_pkey" PRIMARY KEY USING index "InvestmentTransfers_pkey";

ALTER TABLE "public"."InvestmentTransfers"
ADD CONSTRAINT "InvestmentTransfers_assetIdFrom_NetWorthCategoryAssets_id_fk" FOREIGN KEY ("assetIdFrom") REFERENCES "NetWorthCategoryAssets" (id) ON DELETE RESTRICT NOT valid;

ALTER TABLE "public"."InvestmentTransfers" validate CONSTRAINT "InvestmentTransfers_assetIdFrom_NetWorthCategoryAssets_id_fk";

ALTER TABLE "public"."InvestmentTransfers"
ADD CONSTRAINT "InvestmentTransfers_assetIdFrom_assetIdTo_ck" CHECK (("assetIdFrom" <> "assetIdTo")) NOT valid;

ALTER TABLE "public"."InvestmentTransfers" validate CONSTRAINT "InvestmentTransfers_assetIdFrom_assetIdTo_ck";

ALTER TABLE "public"."InvestmentTransfers"
ADD CONSTRAINT "InvestmentTransfers_assetIdTo_NetWorthCategoryAssets_id_fk" FOREIGN KEY ("assetIdTo") REFERENCES "NetWorthCategoryAssets" (id) ON DELETE RESTRICT NOT valid;

ALTER TABLE "public"."InvestmentTransfers" validate CONSTRAINT "InvestmentTransfers_assetIdTo_NetWorthCategoryAssets_id_fk";

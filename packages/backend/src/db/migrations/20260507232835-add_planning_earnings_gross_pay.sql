CREATE TABLE "public"."PlanningEarningsGrossPay" (
  "id" uuid NOT NULL DEFAULT uuidv7(),
  "earningsId" uuid NOT NULL,
  "startDate" date,
  "amountGross" bigint NOT NULL,
  "currency" "CurrencyCode" NOT NULL,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "PlanningEarningsGrossPay_pkey" ON public."PlanningEarningsGrossPay" USING btree (id);

ALTER TABLE "public"."PlanningEarningsGrossPay"
ADD CONSTRAINT "PlanningEarningsGrossPay_pkey" PRIMARY KEY USING index "PlanningEarningsGrossPay_pkey";

ALTER TABLE "public"."PlanningEarningsGrossPay"
ADD CONSTRAINT "PlanningEarningsGrossPay_earningsId_PlanningEarnings_id_fk" FOREIGN KEY ("earningsId") REFERENCES "PlanningEarnings" (id) ON DELETE CASCADE NOT valid;

ALTER TABLE "public"."PlanningEarningsGrossPay" validate CONSTRAINT "PlanningEarningsGrossPay_earningsId_PlanningEarnings_id_fk";

CREATE UNIQUE INDEX "PlanningEarningsGrossPay_earningsStart_uq" ON public."PlanningEarningsGrossPay" USING btree ("earningsId", "startDate") NULLS NOT DISTINCT;

ALTER TABLE "public"."PlanningEarningsGrossPay"
ADD CONSTRAINT "PlanningEarningsGrossPay_earningsStart_uq" UNIQUE USING index "PlanningEarningsGrossPay_earningsStart_uq";

-- Migrate existing earnings' single amountGross/currency into a NULL-startDate
-- gross-pay row (the "initial" rate). Pay rises and cuts are added as further
-- dated rows by the user.
INSERT INTO "public"."PlanningEarningsGrossPay" ("earningsId", "startDate", "amountGross", "currency")
SELECT "id", NULL, "amountGross", "currency" FROM "public"."PlanningEarnings";

ALTER TABLE "public"."PlanningEarnings"
DROP COLUMN "amountGross";

ALTER TABLE "public"."PlanningEarnings"
DROP COLUMN "currency";

CREATE TABLE "public"."PlanningEarningsParentalLeave" (
  "earningsId" uuid NOT NULL,
  "start" date NOT NULL,
  "end" date,
  "fractionOfGross" double precision NOT NULL,
  "isSMP" boolean NOT NULL DEFAULT FALSE,
  "isSPP" boolean NOT NULL DEFAULT FALSE,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE "public"."PlanningYearUKTaxRates"
ADD COLUMN "statutoryParentalPayWeekly" bigint NOT NULL DEFAULT 18718;

CREATE UNIQUE INDEX "PlanningEarningsParentalLeave_pk" ON public."PlanningEarningsParentalLeave" USING btree ("earningsId", start);

ALTER TABLE "public"."PlanningEarningsParentalLeave"
ADD CONSTRAINT "PlanningEarningsParentalLeave_pk" PRIMARY KEY USING index "PlanningEarningsParentalLeave_pk";

ALTER TABLE "public"."PlanningEarningsParentalLeave"
ADD CONSTRAINT "PlanningEarningsParentalLeave_dateRange_ck" CHECK (
  (
    ("end" IS NULL)
    OR ("end" >= start)
  )
) NOT valid;

ALTER TABLE "public"."PlanningEarningsParentalLeave" validate CONSTRAINT "PlanningEarningsParentalLeave_dateRange_ck";

ALTER TABLE "public"."PlanningEarningsParentalLeave"
ADD CONSTRAINT "PlanningEarningsParentalLeave_earningsId_PlanningEarnings_id_fk" FOREIGN KEY ("earningsId") REFERENCES "PlanningEarnings" (id) ON DELETE CASCADE NOT valid;

ALTER TABLE "public"."PlanningEarningsParentalLeave" validate CONSTRAINT "PlanningEarningsParentalLeave_earningsId_PlanningEarnings_id_fk";

ALTER TABLE "public"."PlanningEarningsParentalLeave"
ADD CONSTRAINT "PlanningEarningsParentalLeave_eligibility_ck" CHECK (
  (
    NOT (
      "isSMP"
      AND "isSPP"
    )
  )
) NOT valid;

ALTER TABLE "public"."PlanningEarningsParentalLeave" validate CONSTRAINT "PlanningEarningsParentalLeave_eligibility_ck";

ALTER TABLE "public"."PlanningEarningsParentalLeave"
ADD CONSTRAINT "PlanningEarningsParentalLeave_fractionOfGross_ck" CHECK (
  (
    ("fractionOfGross" >= (0)::double precision)
    AND ("fractionOfGross" <= (1)::double precision)
  )
) NOT valid;

ALTER TABLE "public"."PlanningEarningsParentalLeave" validate CONSTRAINT "PlanningEarningsParentalLeave_fractionOfGross_ck";

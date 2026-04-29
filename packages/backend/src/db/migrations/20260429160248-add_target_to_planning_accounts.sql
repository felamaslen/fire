ALTER TABLE "public"."PlanningAccounts"
ADD COLUMN "currency" "CurrencyCode";

ALTER TABLE "public"."PlanningAccounts"
ADD COLUMN "target" bigint;

ALTER TABLE "public"."PlanningAccounts"
ADD CONSTRAINT "PlanningAccounts_target_currency_ck" CHECK (((target IS NULL) = (currency IS NULL))) NOT valid;

ALTER TABLE "public"."PlanningAccounts" validate CONSTRAINT "PlanningAccounts_target_currency_ck";

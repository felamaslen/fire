ALTER TABLE "public"."PlanningTransactions"
DROP CONSTRAINT "PlanningTransactions_inflow_ck";

ALTER TABLE "public"."PlanningTransactions"
ADD CONSTRAINT "PlanningTransactions_inflow_ck" CHECK (
  (
    (amount <= 0)
    OR (
      ("toAccountId" IS NULL)
      AND ("liabilityId" IS NULL)
    )
  )
) NOT valid;

ALTER TABLE "public"."PlanningTransactions" validate CONSTRAINT "PlanningTransactions_inflow_ck";

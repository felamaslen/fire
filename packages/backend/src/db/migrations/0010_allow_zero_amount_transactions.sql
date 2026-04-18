ALTER TABLE "PlanningTransactions" DROP CONSTRAINT "PlanningTransactions_inflow_ck";--> statement-breakpoint
ALTER TABLE "PlanningTransactions" ADD CONSTRAINT "PlanningTransactions_inflow_ck" CHECK ("PlanningTransactions"."amount" <= 0
           OR ("PlanningTransactions"."toAccountId" IS NULL AND "PlanningTransactions"."liabilityId" IS NULL AND "PlanningTransactions"."assetId" IS NULL));
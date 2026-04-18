ALTER TABLE "PlanningTransactions" DROP CONSTRAINT "PlanningTransactions_inflow_ck";--> statement-breakpoint
ALTER TABLE "NetWorthCategoryLiabilities" ADD COLUMN "billedFromAccountId" uuid;--> statement-breakpoint
ALTER TABLE "NetWorthCategoryLiabilities" ADD CONSTRAINT "NetWorthCategoryLiabilities_billedFromAccountId_PlanningAccounts_accountId_fk" FOREIGN KEY ("billedFromAccountId") REFERENCES "public"."PlanningAccounts"("accountId") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "NetWorthCategoryLiabilities" ADD CONSTRAINT "NetWorthCategoryLiabilities_billedFromAccount_ck" CHECK ("NetWorthCategoryLiabilities"."billedFromAccountId" IS NULL OR "NetWorthCategoryLiabilities"."type" = 'CREDIT_CARD');--> statement-breakpoint
ALTER TABLE "PlanningTransactions" ADD CONSTRAINT "PlanningTransactions_inflow_ck" CHECK ("PlanningTransactions"."amount" < 0
           OR ("PlanningTransactions"."amount" = 0 AND ("PlanningTransactions"."liabilityId" IS NOT NULL OR "PlanningTransactions"."assetId" IS NOT NULL))
           OR ("PlanningTransactions"."toAccountId" IS NULL AND "PlanningTransactions"."liabilityId" IS NULL AND "PlanningTransactions"."assetId" IS NULL));
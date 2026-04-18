ALTER TABLE "PlanningTransactions" RENAME COLUMN "fromAccountId" TO "accountId";--> statement-breakpoint
ALTER TABLE "PlanningTransactions" DROP CONSTRAINT "PlanningTransactions_accounts_ck";--> statement-breakpoint
ALTER TABLE "PlanningTransactions" DROP CONSTRAINT "PlanningTransactions_fromAccountId_PlanningAccounts_accountId_fk";
--> statement-breakpoint
-- Flip stored sign: before this migration every row was a positive magnitude
-- and the sign was derived from which side (`from` vs `to`) the account was on.
-- After this migration `amount` is signed: all existing rows were outflows, so
-- they're now stored as negative values.
UPDATE "PlanningTransactions" SET "amount" = -"amount" WHERE "amount" > 0;--> statement-breakpoint
ALTER TABLE "PlanningTransactions" ADD CONSTRAINT "PlanningTransactions_accountId_PlanningAccounts_accountId_fk" FOREIGN KEY ("accountId") REFERENCES "public"."PlanningAccounts"("accountId") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "PlanningTransactions" ADD CONSTRAINT "PlanningTransactions_inflow_ck" CHECK ("PlanningTransactions"."amount" < 0 OR ("PlanningTransactions"."toAccountId" IS NULL AND "PlanningTransactions"."liabilityId" IS NULL));--> statement-breakpoint
ALTER TABLE "PlanningTransactions" ADD CONSTRAINT "PlanningTransactions_accounts_ck" CHECK ("PlanningTransactions"."toAccountId" IS NULL OR "PlanningTransactions"."accountId" <> "PlanningTransactions"."toAccountId");
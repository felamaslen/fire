DELETE FROM "InvestmentCashAllocation";--> statement-breakpoint
ALTER TABLE "InvestmentCashAllocation" DROP CONSTRAINT "InvestmentCashAllocation_allocation_ck";--> statement-breakpoint
ALTER TABLE "InvestmentCashAllocation" ADD COLUMN "amount" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "InvestmentCashAllocation" ADD COLUMN "currency" "CurrencyCode" NOT NULL;--> statement-breakpoint
ALTER TABLE "InvestmentCashAllocation" DROP COLUMN "allocation";--> statement-breakpoint
ALTER TABLE "InvestmentCashAllocation" ADD CONSTRAINT "InvestmentCashAllocation_amount_ck" CHECK ("InvestmentCashAllocation"."amount" >= 0);
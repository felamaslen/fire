ALTER TYPE "public"."netWorthCategoryAssetType" ADD VALUE 'VEHICLE' BEFORE 'MISC';--> statement-breakpoint
ALTER TABLE "NetWorthCategoryAssets" ADD COLUMN "growthRate" numeric(6, 4);
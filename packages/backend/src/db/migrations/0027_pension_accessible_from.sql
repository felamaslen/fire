ALTER TABLE "NetWorthCategoryAssets" ADD COLUMN "accessibleFrom" date;--> statement-breakpoint
ALTER TABLE "NetWorthCategoryAssets" ADD CONSTRAINT "NetWorthCategoryAssets_accessibleFrom_ck" CHECK ("NetWorthCategoryAssets"."accessibleFrom" IS NULL OR "NetWorthCategoryAssets"."type" = 'PENSION');

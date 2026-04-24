ALTER TABLE "PlanningAccounts" ADD COLUMN "sortOrder" integer DEFAULT 0 NOT NULL;--> statement-breakpoint

-- Backfill existing rows with a dense ordering by creation order so the
-- unique constraint below is satisfied out of the gate.
UPDATE "PlanningAccounts" SET "sortOrder" = t.rn - 1
FROM (
  SELECT "accountId", row_number() OVER (ORDER BY "createdAt", "accountId") AS rn
  FROM "PlanningAccounts"
) AS t
WHERE "PlanningAccounts"."accountId" = t."accountId";--> statement-breakpoint

-- Deferred so the reorder / unassign mutations can shift multiple rows
-- inside one transaction (setting intermediate duplicates that resolve by
-- commit) without tripping the constraint mid-way.
ALTER TABLE "PlanningAccounts"
  ADD CONSTRAINT "PlanningAccounts_sortOrder_uq" UNIQUE ("sortOrder")
  DEFERRABLE INITIALLY DEFERRED;

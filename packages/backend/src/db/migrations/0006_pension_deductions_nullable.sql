ALTER TABLE "PlanningEarnings"
DROP CONSTRAINT "PlanningEarnings_pensionReliefAtSource_ck"; -- > statement-breakpoint
ALTER TABLE "PlanningEarnings"
DROP CONSTRAINT "PlanningEarnings_pensionNetPay_ck"; -- > statement-breakpoint
ALTER TABLE "PlanningEarnings"
ALTER COLUMN "pensionReliefAtSource" DROP NOT NULL; -- > statement-breakpoint
ALTER TABLE "PlanningEarnings" ALTER COLUMN "pensionNetPay" DROP NOT NULL; -- > statement-breakpoint
ALTER TABLE "PlanningEarnings"
ADD CONSTRAINT "PlanningEarnings_pensionReliefAtSource_ck"
  CHECK (
    "PlanningEarnings"."pensionReliefAtSource" IS NULL
    OR "PlanningEarnings"."pensionReliefAtSource" BETWEEN 0 AND 1
  ); -- > statement-breakpoint
ALTER TABLE "PlanningEarnings"
ADD CONSTRAINT "PlanningEarnings_pensionNetPay_ck"
  CHECK (
    "PlanningEarnings"."pensionNetPay" IS NULL
    OR "PlanningEarnings"."pensionNetPay" BETWEEN 0 AND 1
  );

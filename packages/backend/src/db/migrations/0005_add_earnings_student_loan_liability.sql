ALTER TABLE "PlanningEarnings" ADD COLUMN "studentLoanLiabilityId" uuid; -- > statement-breakpoint
ALTER TABLE "PlanningEarnings"
ADD CONSTRAINT "PlanningEarnings_studentLoanLiabilityId_NetWorthCategoryLiabilities_id_fk"
  FOREIGN KEY (
    "studentLoanLiabilityId"
  ) REFERENCES "public"."NetWorthCategoryLiabilities" ("id")
    ON DELETE SET NULL
    ON UPDATE NO ACTION; -- > statement-breakpoint
ALTER TABLE "PlanningEarnings"
ADD CONSTRAINT "PlanningEarnings_studentLoanLiability_ck"
  CHECK (
    "PlanningEarnings"."studentLoanLiabilityId" IS NULL
    OR "PlanningEarnings"."studentLoanPlan2" = TRUE
  );

import { seedCoupleTwoKids } from "./couple-two-kids";
import { seedExecutiveHighBurn } from "./executive-high-burn";
import { seedHenryMaxedAccounts } from "./henry-maxed-accounts";
import { seedStrugglingSingleParent } from "./struggling-single-parent";
import { seedStudentSideJob } from "./student-side-job";
import type { DemoSeedFn } from "./types";

/** Map each `DemoFlavour` GraphQL enum value onto its seed function. `demoLogin` reads this to populate a freshly-provisioned demo schema. */
export const DEMO_SEEDS: Record<string, DemoSeedFn> = {
  COUPLE_TWO_KIDS: seedCoupleTwoKids,
  STUDENT_SIDE_JOB: seedStudentSideJob,
  STRUGGLING_SINGLE_PARENT: seedStrugglingSingleParent,
  EXECUTIVE_HIGH_BURN: seedExecutiveHighBurn,
  HENRY_MAXED_ACCOUNTS: seedHenryMaxedAccounts,
};

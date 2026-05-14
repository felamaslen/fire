import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { Home } from "../components/home/home";

/** Calculator UI state lives in the URL so refreshes / shared links restore the same view. `op` encodes per-loan overpayments as `"<id>:<minor>,…"`; `hidden` is a comma-separated list of loan ids the user has unticked. */
const loanCalculatorSearchSchema = z.object({
  cumulative: z.coerce.boolean().optional().catch(undefined),
  op: z.string().optional().catch(undefined),
  hidden: z.string().optional().catch(undefined),
});

/** Same component as `/`; the loan-overpayment dialog reads the path and opens itself when the user is here. Having a dedicated path means a page refresh / shared link reopens the dialog. */
export const Route = createFileRoute("/loan-calculator")({
  component: Home,
  validateSearch: loanCalculatorSearchSchema,
});

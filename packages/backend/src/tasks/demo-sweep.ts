import { schedule, type ScheduledTask } from "node-cron";

import { sweepExpiredDemoSessions } from "@/auth/demo-session";
import { log } from "@/log";

let scheduled: ScheduledTask | null = null;

/** Sweep expired demo sessions every 15 minutes. Idempotent: calling twice keeps only the most recent schedule. */
export function scheduleDemoSessionSweep(): void {
  if (scheduled) scheduled.stop();
  scheduled = schedule("*/15 * * * *", () => {
    sweepExpiredDemoSessions().catch((err) => {
      log.error("demo session sweep failed", { err });
    });
  });
}

import "./graphql/server";
import "./graphql/schema-download";
import "./uploads";
import "./spa";

import { ensureDemoTemplateDatabase } from "./auth/demo-database";
import { sweepExpiredDemoSessions } from "./auth/demo-session";
import { env } from "./env";
import { log } from "./log";
import { router } from "./router";
import { scheduleDemoSessionSweep } from "./tasks/demo-sweep";
import { scheduleQuoteRefresh } from "./tasks/quote-cron";

if (env.NODE_ENV !== "test") {
  scheduleQuoteRefresh();
  scheduleDemoSessionSweep();
  ensureDemoTemplateDatabase().catch((err) => {
    log.error("Ensuring demo template database failed", {
      err,
      cause: (err as Error)?.cause,
      message: (err as Error)?.message,
    });
  });
  sweepExpiredDemoSessions().catch((err) => {
    log.error("Initial demo sweep failed", {
      err,
      cause: (err as Error)?.cause,
      message: (err as Error)?.message,
    });
  });
}

export const viteNodeApp = router;

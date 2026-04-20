import "./graphql/server";
import "./graphql/schema-download";
import "./uploads";
import "./spa";

import { env } from "./env";
import { router } from "./router";
import { scheduleQuoteRefresh } from "./tasks/quote-cron";

if (env.NODE_ENV !== "test") {
  scheduleQuoteRefresh();
}

export const viteNodeApp = router;

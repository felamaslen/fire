import "./graphql/server";
import "./graphql/schema-download";
import "./uploads";

import { env } from "./env";
import { router } from "./router";

if (env.NODE_ENV !== "test") {
  await router.listen({ port: env.PORT, host: "0.0.0.0" });

  for (const signal of ["SIGINT", "SIGTERM", "SIGUSR2"] as const) {
    process.once(signal, () => {
      void router.close().then(() => {
        process.kill(process.pid, signal);
      });
    });
  }
}

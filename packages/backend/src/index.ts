import { viteNodeApp } from "./app";
import { env } from "./env";

if (env.NODE_ENV !== "test") {
  await viteNodeApp.listen({ port: env.PORT, host: "0.0.0.0" });

  for (const signal of ["SIGINT", "SIGTERM", "SIGUSR2"] as const) {
    process.once(signal, () => {
      void viteNodeApp.close().then(() => {
        process.kill(process.pid, signal);
      });
    });
  }
}

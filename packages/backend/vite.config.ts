import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  ssr: {
    noExternal: ["graphql", "@apollo/server", "@as-integrations/fastify"],
  },
  test: {
    globalSetup: ["./test/global-setup.ts"],
    setupFiles: ["./test/setup.ts"],
    pool: "forks",
    env: {
      DATABASE_URL: "postgres://fire:fire@localhost:5433/postgres",
    },
  },
});

import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "#test": fileURLToPath(new URL("./test", import.meta.url)),
    },
    dedupe: ["graphql"],
  },
  ssr: {
    noExternal: [
      "graphql",
      "@apollo/server",
      "@as-integrations/fastify",
      "@graphql-tools/schema",
      "@graphql-tools/merge",
      "@graphql-tools/utils",
      "@graphql-tools/executor",
    ],
  },
  test: {
    globalSetup: ["./test/global-setup.ts"],
    setupFiles: ["./test/setup.ts"],
    pool: "forks",
    globals: true,
    silent: "passed-only",
    env: {
      DATABASE_URL: "postgres://fire:fire@localhost:5433/postgres",
      UPLOADS_DIR: "./.uploads-test",
    },
  },
});

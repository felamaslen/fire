import { fileURLToPath } from "node:url";

import { loadEnv } from "vite";
import { VitePluginNode } from "vite-plugin-node";
import { defineConfig } from "vitest/config";

export default defineConfig(({ mode }) => {
  Object.assign(process.env, loadEnv(mode, process.cwd(), ""));

  return {
    server: {
      port: 4000,
      host: "0.0.0.0",
    },
    plugins: [
      ...VitePluginNode({
        adapter: "fastify",
        appPath: "./src/app.ts",
        exportName: "viteNodeApp",
        tsCompiler: "vite",
      }),
    ],
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
      maxConcurrency: 8,
      globals: true,
      silent: "passed-only",
      env: loadEnv("test", process.cwd(), ""),
    },
  };
});

import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  server: { port: 4001 },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  plugins: [
    tanstackRouter({
      autoCodeSplitting: false,
      generatedRouteTree: "src/__generated__/routeTree.gen.ts",
      routeFileIgnorePattern: ".stories.tsx",
      routesDirectory: "src/routes",
    }),
    react(),
    tailwindcss(),
  ],
});

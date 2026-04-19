import js from "@eslint/js";
import prettier from "eslint-plugin-prettier/recommended";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import tseslint from "typescript-eslint";

import { gqlResolverNullabilityRule } from "./eslint-rules/gql-resolver-nullability.mjs";

const localPlugin = {
  rules: {
    "gql-resolver-nullability": gqlResolverNullabilityRule,
  },
};

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/.idea/**",
      "packages/backend/src/__generated__/**",
      "packages/web/src/routeTree.gen.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // `.mjs` entry points (notably `packages/backend/otel.mjs`) run as Node
    // scripts, not through the TS compiler, so their globals aren't in the
    // default set.
    files: ["**/*.mjs"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
      },
    },
  },
  {
    plugins: { "simple-import-sort": simpleImportSort },
    rules: {
      "simple-import-sort/imports": "error",
      "simple-import-sort/exports": "error",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["packages/backend/src/**/*.ts"],
    plugins: { local: localPlugin },
    rules: {
      "local/gql-resolver-nullability": "error",
    },
  },
  prettier,
);

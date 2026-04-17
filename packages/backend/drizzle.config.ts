import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/*.ts",
  out: "./src/db/migrations",
  casing: "camelCase",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://fire:fire@localhost:5433/fire",
  },
});

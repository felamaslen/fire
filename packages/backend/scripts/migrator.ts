#!/usr/bin/env -S npx tsx

import assert from "node:assert";
import path from "node:path";

import { Migrator, noopLogger } from "@pgkit/migrator";
import pg from "pg";
import winston, { format } from "winston";

const dbDir = path.resolve(import.meta.dirname, "../src/db");

const logLikeFormat: Parameters<typeof format.combine>[number] = {
  transform(info) {
    const { timestamp, message } = info;
    const level = info.level;
    const args = info[Symbol.for("splat")];
    info[Symbol.for("message")] =
      `${timestamp} ${level}: ${message}${Array.isArray(args) && args.length ? ` ${args.join(" ")}` : ""}`;
    return info;
  },
};

const logger = winston.createLogger({
  format: format.combine(
    winston.format.colorize({
      colors: winston.config.npm.colors,
    }),
    format.timestamp(),
    logLikeFormat,
  ),
  transports: [new winston.transports.Console()],
});

// Run CLI when executed directly (not when imported)
const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("/migrator.ts");

export async function migrator(clientUrl?: string) {
  const client =
    clientUrl ??
    process.env.DATABASE_URL ??
    "postgres://fire:fire@localhost:5433/fire";
  assert(client, "Missing database client URL");

  const pool = new pg.Pool({ connectionString: client });
  await pool.query("CREATE SCHEMA IF NOT EXISTS migrator_internal");
  await pool.end();

  return new Migrator({
    client,
    migrationsPath: path.join(dbDir, "migrations"),
    migrationTableName: ["migrator_internal", "migrations"],
    logger: isMain ? logger : noopLogger,
  });
}

if (isMain) {
  await (await migrator()).cli().run();
}

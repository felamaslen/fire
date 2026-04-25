/**
 * Backfills a database migrated using drizzle-kit, to use @pgkit/migrator (see scripts/migrator.ts)
 * This requires copying the migrations table to a different schema
 *
 * Usage: `npx tsx scripts/backfill-migrations.ts`
 */

import assert from "node:assert";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import sql from "fake-tag";
import pg from "pg";
import winston from "winston";

const logger = winston.createLogger({
  transports: [new winston.transports.Console()],
});

const client =
  process.env.DATABASE_URL ?? "postgres://fire:fire@localhost:5433/fire";
assert(client, "Missing database client URL");

const pool = new pg.Pool({ connectionString: client });

await pool.query(sql`CREATE SCHEMA IF NOT EXISTS migrator_internal`);
await pool.query(sql`CREATE TABLE IF NOT EXISTS migrator_internal.migrations (
  name text primary key,
  content text not null,
  status text,
  date timestamptz not null default now()
)`);
const migrationsDirectory = resolve(
  import.meta.dirname,
  "../src/db/migrations",
);
const files = await readdir(migrationsDirectory);
for (const file of files) {
  if (!file.endsWith(".sql")) continue;
  const content = await readFile(resolve(migrationsDirectory, file), "utf8");
  logger.info("Backfilling migration", { name: file });
  await pool.query(
    sql`
  insert into migrator_internal.migrations (name, content, status, date)
  select \$1 as name, \$2 as content, \$3 as status, to_timestamp(d.created_at / 1000) as date
  from drizzle.__drizzle_migrations d
  on conflict do nothing
  `,
    [file, content, "executed"],
  );
}
await pool.end();

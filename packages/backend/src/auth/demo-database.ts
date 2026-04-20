import path from "node:path";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import { env } from "@/env";
import { log } from "@/log";

/**
 * Per-demo-session Postgres **database** orchestration. Each demo session gets a dedicated database provisioned via `CREATE DATABASE demo_<hex> WITH TEMPLATE <template>` so the session starts with a fully-migrated, empty copy of the real app's schema — no SQL munging, no manual enum / view / trigger handling. The `<template>` database (`fire_demo_template` by default, derived from the app's `DATABASE_URL`) is migrated once at boot via the same drizzle-kit migrations the real DB runs.
 */

/** Name of the template database. Derived from `DATABASE_URL` at boot so tests and prod each get their own (isolates the template-migrations stamp table per environment). */
function parseUrl(urlString: string): URL {
  return new URL(urlString);
}

function currentDatabaseName(): string {
  return parseUrl(env.DATABASE_URL).pathname.replace(/^\//u, "");
}

function templateDatabaseName(): string {
  return `${currentDatabaseName()}_demo_template`;
}

/** Build a connection URL pointing at `dbName` on the same Postgres server as `DATABASE_URL`. */
function urlForDatabase(dbName: string): string {
  const u = parseUrl(env.DATABASE_URL);
  u.pathname = `/${dbName}`;
  return u.toString();
}

/** Admin URL used for `CREATE DATABASE` / `DROP DATABASE` — points at the server's `postgres` maintenance DB so we never try to drop a database we're connected to. */
function adminUrl(): string {
  return urlForDatabase("postgres");
}

/** Identifier-quote check. Callers generate these ourselves (hex + `demo_` prefix / the fixed template name), so a stray quote would be a bug; belt-and-braces. */
function quoteIdent(name: string): string {
  if (!/^[A-Za-z0-9_]+$/u.test(name)) {
    throw new Error(`Invalid database name: ${name}`);
  }
  return `"${name}"`;
}

/** Path to the drizzle migrations folder, resolved relative to this source file so it works under both `pnpm dev` (vite-node) and `pnpm start` (built). */
function migrationsFolder(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../db/migrations");
}

async function databaseExists(name: string): Promise<boolean> {
  const admin = postgres(adminUrl(), { max: 1, onnotice: () => {} });
  try {
    const rows = await admin<{ count: number }[]>`
      SELECT 1 FROM pg_database WHERE datname = ${name}
    `;
    return rows.length > 0;
  } finally {
    await admin.end();
  }
}

async function createDatabase(name: string, template?: string): Promise<void> {
  const admin = postgres(adminUrl(), { max: 1, onnotice: () => {} });
  try {
    const quoted = quoteIdent(name);
    if (template) {
      const quotedTemplate = quoteIdent(template);
      await admin.unsafe(
        `CREATE DATABASE ${quoted} TEMPLATE ${quotedTemplate}`,
      );
    } else {
      await admin.unsafe(`CREATE DATABASE ${quoted}`);
    }
  } finally {
    await admin.end();
  }
}

async function dropDatabase(name: string): Promise<void> {
  const admin = postgres(adminUrl(), { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(
      `DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`,
    );
  } finally {
    await admin.end();
  }
}

/**
 * Ensure the template database exists and is fully migrated. Safe to call repeatedly — the `CREATE DATABASE` is guarded by a `pg_database` lookup and migrations are idempotent via drizzle's `__drizzle_migrations` stamp. Called once at backend boot.
 *
 * Important: we open a migration connection, migrate, then close it immediately. `CREATE DATABASE … WITH TEMPLATE` fails if any session is connected to the template, so leaving the pool open would break every subsequent demo login.
 */
export async function ensureDemoTemplateDatabase(): Promise<void> {
  const name = templateDatabaseName();
  if (!(await databaseExists(name))) {
    await createDatabase(name);
    log.info("Created demo template database", { name });
  }
  const templateSql = postgres(urlForDatabase(name), {
    max: 1,
    onnotice: () => {},
  });
  try {
    const tmpl = drizzle(templateSql);
    await migrate(tmpl, { migrationsFolder: migrationsFolder() });
  } finally {
    await templateSql.end();
  }
}

/** Provision a fresh demo database by cloning the template. `name` must be a fresh `demo_<hex>` value. */
export async function provisionDemoDatabase(name: string): Promise<void> {
  await createDatabase(name, templateDatabaseName());
}

/** Drop a demo database (no-op if already gone). Uses `WITH (FORCE)` so a lingering connection in the per-session pool doesn't block teardown. */
export async function dropDemoDatabase(name: string): Promise<void> {
  await dropDatabase(name);
}

/** URL a per-session Drizzle pool should connect to. */
export function demoDatabaseUrl(name: string): string {
  return urlForDatabase(name);
}

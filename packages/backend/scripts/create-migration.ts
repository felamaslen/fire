#!/usr/bin/env -S pnpm exec tsx

/**
 * This script will:
 * 1. Spin up a database from schema.sql
 * 2. Spin up a database from migrations/*.sql
 * 3. Creates a new migration from the diff of the last two steps
 *
 * The created migration file will be named as follows:
 * YYYYMMDDHHmmss-NAME.sql
 *
 * Name is a required argument unless --exit-code is used.
 *
 * Options:
 *   --name <name>    Migration name (required unless --exit-code)
 *   --allow-empty    Allow creating an empty migration file when there are no differences
 *   --exit-code      Exit with code 1 if there are pending schema changes, 0 otherwise.
 *                    Does not create a migration file. Useful for CI drift checks.
 */

import assert from "node:assert";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

import { run as migra } from "@pgkit/migra";
import pg from "pg";
import { argv } from "zx";

import { migrator } from "./migrator";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://fire:fire@localhost:5433/fire";
assert(DATABASE_URL, "Missing database URL");

const { Pool } = pg;

export const pgPool = new Pool({
  connectionString: DATABASE_URL,
});

const databaseUrl = new URL(DATABASE_URL);

if (!argv["exit-code"] && !argv.name) {
  if (!process.stdin.isTTY) {
    throw new Error("You must provide a name via --name");
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  argv.name = await new Promise<string>((resolve) => {
    rl.question("Migration name: ", (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
  assert(argv.name, "You must provide a name");
}

const dbDir = path.resolve(import.meta.dirname, "../src/db");
const schemaPath = path.join(dbDir, "__generated__/schema.sql");
const migrationsDir = path.join(dbDir, "migrations");

const desiredDbName = "migration_desired";
const currentDbName = "migration_current";

async function createDb(name: string) {
  await pgPool
    .query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(name)}`)
    .catch(() => {});
  await pgPool.query(`CREATE DATABASE ${pg.escapeIdentifier(name)}`);
}

async function runSqlFile(connectionString: string, filePath: string) {
  const pool = new Pool({ connectionString });
  try {
    const sql = fs.readFileSync(filePath, "utf8");
    await pool.query(sql);
  } finally {
    await pool.end();
  }
}

function buildConnectionString(dbName: string) {
  const url = new URL(databaseUrl.toString());
  url.pathname = `/${dbName}`;
  return url.toString();
}

try {
  // Step 1: Create both temporary databases
  await createDb(desiredDbName);
  await createDb(currentDbName);

  const desiredUrl = buildConnectionString(desiredDbName);
  const currentUrl = buildConnectionString(currentDbName);

  // Step 2: Load schema.sql into the "desired" database
  await runSqlFile(desiredUrl, schemaPath);

  // Step 3: Apply all existing migrations to the "current" database
  const m = await migrator(currentUrl);
  await m.up();
  await m.client.end();

  // Step 4: Use migra to diff "current" → "desired"
  const migration = await migra(currentUrl, desiredUrl, {
    unsafe: true,
    excludeSchema: ["migrator_internal"],
  });

  const trimmed = migration.sql.trim();

  const now = new Date();
  const timestamp = [
    now.getFullYear().toString(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");

  const migrationFileName = `${timestamp}-${argv.name}.sql`;
  const migrationFilePath = path.join(migrationsDir, migrationFileName);

  if (!trimmed) {
    if (argv["allow-empty"]) {
      fs.writeFileSync(migrationFilePath, "");
      console.log(
        `No differences found. Created empty migration: ${migrationFilePath}`,
      );
    } else if (argv["exit-code"]) {
      console.log("No differences found. Schema is up to date.");
    } else {
      console.error(
        "No differences found. Schema is up to date. Use --allow-empty to create an empty migration.",
      );
      process.exitCode = 1;
    }
  } else if (argv["exit-code"]) {
    console.error("Schema drift detected. Differences:\n" + trimmed);
    process.exitCode = 1;
  } else {
    // Step 5: Write the new migration file
    fs.writeFileSync(migrationFilePath, `${trimmed}\n`);
    execSync(`npx prettier --write ${migrationFilePath}`, { stdio: "pipe" });

    console.log(`Created migration: ${migrationFilePath}`);
  }
} catch (e) {
  console.error("Error", e);
  process.exitCode = 1;
} finally {
  console.log("Cleaning up...");
  // Cleanup: drop temporary databases
  await pgPool
    .query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(desiredDbName)}`)
    .catch(() => {});
  await pgPool
    .query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(currentDbName)}`)
    .catch(() => {});
  await pgPool.end();
}

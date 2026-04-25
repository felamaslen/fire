#!/usr/bin/env -S npx tsx

import { execSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { StringChunk } from "drizzle-orm";
import * as prettier from "prettier";

import { PgCustomSQL } from "../src/db/sql";

/**
 * Generates `db/__generated__/schema.sql` by combining drizzle-kit's migration output with custom SQL snippets from the schema files.
 *
 * 1. Run `drizzle-kit generate` into a temp directory (no prior snapshots, so
 *    the output is a full-schema migration).
 * 2. Import schema files and collect `PgCustomSQL` instances.
 * 3. Sort snippets by priority, place negative-priority snippets before the
 *    migration and zero-or-positive-priority snippets after.
 */
const SCHEMA_SQL = path.resolve(
  import.meta.dirname,
  "../src/db/__generated__/schema.sql",
);
const DRIZZLE_SCHEMA = path.resolve(import.meta.dirname, "../src/db/schema");

// ---------------------------------------------------------------------------
// 1. Generate migration via drizzle-kit
// ---------------------------------------------------------------------------

const tempDir = mkdtempSync(path.join(tmpdir(), "drizzle-schema-"));

try {
  execSync(
    `npx drizzle-kit generate --dialect postgresql --schema '${DRIZZLE_SCHEMA}' --out '${tempDir}' --prefix none`,
    { stdio: "pipe" },
  );
} catch (error: unknown) {
  const stderr =
    error instanceof Error && "stderr" in error
      ? (error as { stderr: Buffer }).stderr?.toString()
      : "";
  console.error(
    "drizzle-kit generate failed:",
    stderr,
    error instanceof Error && "stdout" in error
      ? (error.stdout as Buffer).toString()
      : undefined,
  );
  rmSync(tempDir, { recursive: true, force: true });
  process.exit(1);
}

// Find the generated .sql file
const sqlFiles = readdirSync(tempDir).filter((f) => f.endsWith(".sql"));
if (sqlFiles.length !== 1) {
  console.error(
    `Expected exactly 1 SQL file in ${tempDir}, found ${sqlFiles.length}`,
  );
  rmSync(tempDir, { recursive: true, force: true });
  process.exit(1);
}

let migrationSql = readFileSync(path.join(tempDir, sqlFiles[0]), "utf8");

// Remove drizzle-kit statement breakpoint markers
migrationSql = migrationSql.replaceAll("--> statement-breakpoint", "");

// Clean up temp dir
rmSync(tempDir, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// 2. Import schema files and collect PgCustomSQL instances
// ---------------------------------------------------------------------------

/** Extracts the raw SQL text from a drizzle `SQL` object's query chunks. */
function sqlToString(sql: { queryChunks: unknown[] }): string {
  return sql.queryChunks
    .flatMap((chunk) => (chunk instanceof StringChunk ? chunk.value : []))
    .join("")
    .trim();
}

const snippets: { text: string; priority: number }[] = [];

const schemaFiles = readdirSync(DRIZZLE_SCHEMA)
  .filter((f) => f.endsWith(".ts"))
  .sort();

for (const file of schemaFiles) {
  const mod = await import(path.resolve(DRIZZLE_SCHEMA, file));

  for (const value of Object.values(mod)) {
    if (value instanceof PgCustomSQL) {
      snippets.push({
        text: sqlToString(value.sql),
        priority: value.options?.priority ?? 0,
      });
    }
  }
}

snippets.sort((a, b) => a.priority - b.priority);

// ---------------------------------------------------------------------------
// 3. Combine: pre-migration snippets + migration + post-migration snippets
// ---------------------------------------------------------------------------

const header = [
  "-- AUTO-GENERATED FILE. DO NOT EDIT.",
  "-- Intermediary DB schema used for generating migrations and checking drift.",
  "-- The Drizzle schema (src/db/schema/) is the source of truth.",
  "-- Regenerate with: pnpm db:generate",
].join("\n");

const preMigration = snippets.filter((s) => s.priority < 0).map((s) => s.text);
const postMigration = snippets
  .filter((s) => s.priority >= 0)
  .map((s) => s.text);

const parts: string[] = [header];

if (preMigration.length > 0) {
  parts.push(preMigration.join("\n\n"));
}

parts.push(migrationSql.trim());

if (postMigration.length > 0) {
  parts.push(postMigration.join("\n\n"));
}

const prettierConfig = await prettier.resolveConfig(SCHEMA_SQL);
const output = await prettier.format(parts.join("\n\n") + "\n", {
  ...prettierConfig,
  filepath: SCHEMA_SQL,
});

writeFileSync(SCHEMA_SQL, output);

console.log(
  `Generated ${SCHEMA_SQL} (${preMigration.length} pre-migration, ${postMigration.length} post-migration SQL snippets)`,
);

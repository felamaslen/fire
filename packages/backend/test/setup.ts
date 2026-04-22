import "./bootstrap-env";

import { rm } from "node:fs/promises";
import path from "node:path";

import { sql } from "drizzle-orm";
import postgres from "postgres";

import { env } from "@/env";

vi.mock("@/db/client");

/**
 * Freeze the clock at a deterministic instant for every test. Anything that
 * depends on "today" (UK FY derivation, `planningYearCurrent`, etc.) can now
 * be snapshotted without replicating the calculation in the test file.
 *
 * 2026-04-18 is a post-cutover date → UK FY starts 2026.
 */
export const TEST_NOW = new Date("2026-04-18T12:00:00Z");
export const TEST_FY = 2026;

beforeAll(() => {
  vi.useFakeTimers({ now: TEST_NOW, shouldAdvanceTime: true });
});

afterAll(() => {
  vi.useRealTimers();
});

const ADMIN_URL = "postgres://fire:fire@localhost:5433/postgres";
const TEMPLATE_DB = "fire_template";

function testDbName(): string {
  const workerId =
    process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? "1";
  return `fire_test_${workerId}`;
}

beforeAll(async () => {
  const dbName = testDbName();
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE "${dbName}" TEMPLATE "${TEMPLATE_DB}"`);
  } finally {
    await admin.end();
  }
});

/**
 * Tables whose contents come from the template DB and should be preserved
 * across tests. `global-setup.ts` pre-seeds a `PlanningYears` row + its 12
 * `PlanningMonths` so planning tests don't each pay the cost of creating a
 * year from scratch. Tests that exercise year creation directly
 * (`graphql/planning/planning.test.ts`) truncate these in their own
 * `beforeEach` to start from empty.
 */
const SEED_TABLES = new Set([
  "PlanningYears",
  "PlanningMonths",
  "PlanningYearUKTaxRates",
]);

beforeEach(async () => {
  const { db } = await import("@/db");
  const rows = await db.execute<{ tablename: string }>(sql`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '__drizzle_migrations'
  `);
  const truncatable = rows.filter((r) => !SEED_TABLES.has(r.tablename));
  if (truncatable.length > 0) {
    const list = truncatable.map((r) => `"${r.tablename}"`).join(", ");
    await db.execute(sql.raw(`TRUNCATE ${list} RESTART IDENTITY CASCADE`));
  }
  // Wipe the uploads bucket so file-count assertions in upload tests are deterministic.
  await rm(path.resolve(env.UPLOADS_DIR), { recursive: true, force: true });
  // Process-wide caches added for performance (DrizzleModel rows, per-asset
  // allocations, per-investment wrappers) live for the life of the Node
  // process — after a test TRUNCATE they'd serve stale rows to the next
  // test. Flush them alongside the DB reset.
  const [dm, ps, al] = await Promise.all([
    import("@/db/drizzle-model"),
    import("@/graphql/investments/position"),
    import("@/graphql/investments/allocations"),
  ]);
  dm.TEST__clearModelCaches();
  ps.TEST__clearWrapperCache();
  al.TEST__clearAllocationCaches();
});

afterAll(async () => {
  const dbName = testDbName();
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  } finally {
    await admin.end();
  }
});

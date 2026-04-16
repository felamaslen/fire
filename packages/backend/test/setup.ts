import { sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, vi } from "vitest";

vi.mock("@/db/client");

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

beforeEach(async () => {
  const { db } = await import("@/db");
  const rows = await db.execute<{ tablename: string }>(sql`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '__drizzle_migrations'
  `);
  if (rows.length === 0) return;
  const list = rows.map((r) => `"${r.tablename}"`).join(", ");
  await db.execute(sql.raw(`TRUNCATE ${list} RESTART IDENTITY CASCADE`));
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

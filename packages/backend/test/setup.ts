import postgres from "postgres";
import { afterAll, beforeAll, vi } from "vitest";

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
  const admin = postgres(ADMIN_URL, { max: 1 });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE "${dbName}" TEMPLATE "${TEMPLATE_DB}"`);
  } finally {
    await admin.end();
  }
});

afterAll(async () => {
  const dbName = testDbName();
  const admin = postgres(ADMIN_URL, { max: 1 });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  } finally {
    await admin.end();
  }
});

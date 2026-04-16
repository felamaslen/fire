import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { schema } from "../schema";

function testDbName(): string {
  const workerId =
    process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? "1";
  return `fire_test_${workerId}`;
}

const url = `postgres://fire:fire@localhost:5433/${testDbName()}`;

export const db = drizzle(postgres(url), { schema });
export type DB = typeof db;

import { AsyncLocalStorage } from "node:async_hooks";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { schema } from "../schema";

function testDbName(): string {
  const workerId =
    process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? "1";
  return `fire_test_${workerId}`;
}

const url = `postgres://fire:fire@localhost:5433/${testDbName()}`;

const defaultDb = drizzle(postgres(url), { schema });
export type DB = typeof defaultDb;

const als = new AsyncLocalStorage<DB>();

export function runWithDb<T>(scopedDb: DB, fn: () => Promise<T>): Promise<T> {
  return als.run(scopedDb, fn);
}

export const db: DB = new Proxy(defaultDb, {
  get(_target, prop) {
    const active = als.getStore() ?? defaultDb;
    const value = Reflect.get(active, prop, active);
    return typeof value === "function" ? value.bind(active) : value;
  },
}) as DB;

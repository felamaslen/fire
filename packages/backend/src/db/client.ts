import { AsyncLocalStorage } from "node:async_hooks";

import { instrumentDrizzleClient } from "@kubiks/otel-drizzle";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { env } from "../env";
import { schema } from "./schema";

const sql = postgres(env.DATABASE_URL);

/** Untrapped Drizzle client bound to the real `public` schema. Resolvers should import `db` from this module — `defaultDb` is only exported so request wrappers can pass it to `runWithDb` (passing the `db` proxy would re-enter the proxy and blow the stack). */
export const defaultDb = drizzle(sql, { schema });
export type DB = typeof defaultDb;

if (env.OTEL_ENABLED) {
  const dbName = (() => {
    try {
      return new URL(env.DATABASE_URL).pathname.replace(/^\//, "") || undefined;
    } catch {
      return undefined;
    }
  })();
  instrumentDrizzleClient(defaultDb, { dbSystem: "postgresql", dbName });
}

/**
 * Request-scoped db override. When set (via `runWithDb`), every access to the
 * exported `db` proxy routes through this db instead of `defaultDb`, so demo
 * sessions read/write their dedicated Postgres schema without each resolver
 * having to plumb `ctx.db`.
 */
const als = new AsyncLocalStorage<DB>();

/**
 * Run `fn` with `scopedDb` as the active db for all `db`-proxy accesses made
 * inside it. Typically called from the GraphQL Fastify handler so a whole
 * request sees one db. Nested calls shadow the outer db for the duration of
 * the inner scope.
 */
export function runWithDb<T>(scopedDb: DB, fn: () => Promise<T>): Promise<T> {
  return als.run(scopedDb, fn);
}

/** Open a Postgres transaction on the active db (the request-scoped one if set, otherwise `defaultDb`) and rebind the `db` proxy to it for the duration of `fn`. Every `db.*` call made inside `fn` — including in functions it calls — runs inside the transaction, so business-logic helpers compose without having to thread a `tx` parameter through their signatures. The transaction commits when `fn` resolves and rolls back when it throws. */
export function runInTransaction<T>(fn: () => Promise<T>): Promise<T> {
  const active = als.getStore() ?? defaultDb;
  return active.transaction((tx) => runWithDb(tx as unknown as DB, fn));
}

/** `defaultDb` wrapped so property reads inside an `als.run(...)` scope come from the scoped db. */
export const db: DB = new Proxy(defaultDb, {
  get(_target, prop) {
    const active = als.getStore() ?? defaultDb;
    const value = Reflect.get(active, prop, active);
    return typeof value === "function" ? value.bind(active) : value;
  },
}) as DB;

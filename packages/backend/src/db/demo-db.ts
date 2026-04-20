import { drizzle } from "drizzle-orm/postgres-js";
import { LRUCache } from "lru-cache";
import postgres from "postgres";

import { demoDatabaseUrl } from "@/auth/demo-database";

import type { DB } from "./client";
import { schema } from "./schema";

/**
 * Per-database pool of Drizzle clients for demo sessions. Each entry owns its own `postgres-js` connection pool talking to a dedicated Postgres database (`demo_<hex>`) cloned from the template. Bounded so a burst of demo sessions can't leak connections.
 */
const cache = new LRUCache<string, { db: DB; sql: postgres.Sql }>({
  max: 32,
  dispose: (value) => {
    // Fire-and-forget — closing is advisory; if it fails the pool is still GCable.
    void value.sql.end({ timeout: 5 });
  },
});

/** Get (or lazily create) a Drizzle client bound to the demo database named `databaseName`. */
export function getDemoDb(databaseName: string): DB {
  const cached = cache.get(databaseName);
  if (cached) return cached.db;
  const sql = postgres(demoDatabaseUrl(databaseName), { max: 4 });
  const db = drizzle(sql, { schema });
  cache.set(databaseName, { db, sql });
  return db;
}

/** Drop the cached client for a demo database (called right before `DROP DATABASE`). */
export function forgetDemoDb(databaseName: string): void {
  cache.delete(databaseName);
}

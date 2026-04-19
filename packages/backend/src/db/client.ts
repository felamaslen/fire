import { instrumentDrizzleClient } from "@kubiks/otel-drizzle";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { env } from "../env";
import { schema } from "./schema";

const sql = postgres(env.DATABASE_URL);

export const db = drizzle(sql, { schema });
export type DB = typeof db;

if (env.OTEL_ENABLED) {
  const dbName = (() => {
    try {
      return new URL(env.DATABASE_URL).pathname.replace(/^\//, "") || undefined;
    } catch {
      return undefined;
    }
  })();
  instrumentDrizzleClient(db, { dbSystem: "postgresql", dbName });
}

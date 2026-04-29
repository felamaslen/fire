import pgImport from "pg";

import { env } from "../env";

// `pg-native` uses libpq for native Postgres bindings — generally faster than
// the pure-JS path for query throughput. `pg.native` is `null` if the build
// is missing, so fall through to the JS pool in that case rather than crash.
const PgImpl = pgImport.native ?? pgImport;

/** Single Postgres connection pool shared across the process. Limits are explicit so they can be tuned per-environment. */
export const pool = new PgImpl.Pool({
  connectionString: env.DATABASE_URL,
  max: env.DATABASE_POOL_MAX,
  idleTimeoutMillis: env.DATABASE_POOL_IDLE_TIMEOUT * 1000,
});

import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Registry of live demo sessions. Each row owns a dedicated Postgres **database** (named `demo_<hex>`), provisioned via `CREATE DATABASE … WITH TEMPLATE fire_demo_template` so it inherits the full schema (tables, FKs, enums, functions, triggers, views) with zero SQL string manipulation. Rows expire 6 hours after creation; a boot-time and interval sweeper drops databases whose row has expired, and `logout` drops its own row + database immediately. Lives in the main `fire` DB's `public` schema because we need a single registry visible across all sessions.
 */
export const DemoSessions = pgTable("DemoSessions", {
  id: uuid("id")
    .primaryKey()
    .default(sql`uuidv7()`),
  /** Postgres database name holding this session's data. Unique so two sessions can never collide. DB column is named `schema` for historical reasons — at one point demos ran in schemas, not databases. */
  database: text("schema").notNull().unique(),
  /** Which `DemoFlavour` seeded this session. Stored as text so adding / removing flavours doesn't need a migration. */
  flavour: text("flavour").notNull(),
  createdAt: timestamp("createdAt", { withTimezone: true })
    .notNull()
    .defaultNow(),
  /** Hard TTL — the sweeper drops the database once this passes. */
  expiresAt: timestamp("expiresAt", { withTimezone: true }).notNull(),
});

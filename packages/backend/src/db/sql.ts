import type { SQL } from "drizzle-orm";

/** Marker class for custom SQL snippets injected into `schema.sql`. */
export class PgCustomSQL {
  constructor(
    public readonly sql: SQL,
    public readonly options?: {
      priority?: number;
    },
  ) {}
}

/**
 * Injects a raw SQL snippet into the generated `db/__generated__/schema.sql` file.
 *
 * Snippets are sorted by `priority` ascending. The drizzle-kit migration
 * output sits at priority `0`, so:
 *
 * - **Negative priorities** (e.g. `-10`) place the snippet *before* the table defs — use this for extensions, PL/pgSQL functions, or anything that must exist before tables are created.
 * - **Positive priorities** (e.g. `1`) place the snippet *after* the table defs — use this for triggers, deferrable constraints, or other constructs that reference tables.
 *
 * ```ts
 * // Extension — must come first
 * export const fuzzystrmatch = pgCustomSQL(sql`
 *   CREATE EXTENSION IF NOT EXISTS fuzzystrmatch;
 * `, { priority: -10 });
 *
 * // Function used by triggers — before tables but after extensions
 * export const myFunction = pgCustomSQL(sql`
 *   CREATE FUNCTION public.my_fn() RETURNS trigger ...
 * `, { priority: -1 });
 *
 * // Trigger — after tables
 * export const myTrigger = pgCustomSQL(sql`
 *   CREATE TRIGGER "MyTable_trigger"
 *   AFTER INSERT ON public."MyTable" FOR EACH ROW
 *   EXECUTE FUNCTION public.task_event_trigger('id');
 * `, { priority: 1 });
 * ```
 */
export function pgCustomSQL(
  sql: SQL,
  options?: {
    /**
     * Controls ordering relative to the Drizzle schema and other snippets.
     * The Drizzle schema sits at priority `0`. Use negative values (e.g. `-10` for extensions, `-1` for functions) to place snippets before the table definitions.
     * Defaults to `0`.
     */
    priority?: number;
  },
): PgCustomSQL {
  return new PgCustomSQL(sql, options);
}

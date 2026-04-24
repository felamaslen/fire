import { strict as assert } from "node:assert";

import DataLoader from "dataloader";
import { and, eq, or, type SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";

import { currentScope } from "@/auth/session-als";

import { db } from "./client";
import { type Schema, schema } from "./schema";

/** Keys of `schema` that point to a `PgTable` (filters out enums, relations, and other non-table exports). */
export type DrizzleTableName = {
  [K in keyof Schema]: Schema[K] extends PgTable ? K : never;
}[keyof Schema];

type TableOf<N extends DrizzleTableName> = Extract<Schema[N], PgTable>;
type RowOf<N extends DrizzleTableName> = TableOf<N>["$inferSelect"];
type InsertOf<N extends DrizzleTableName> = TableOf<N>["$inferInsert"];

type ColumnsOf<N extends DrizzleTableName> = TableOf<N>["_"]["columns"];

/**
 * Union of primary-key column names inferred from the table's column types.
 *
 * Drizzle only propagates `isPrimaryKey: true` at the type level for columns declared with `.primaryKey()` directly on the column builder. Composite primary keys declared via `primaryKey({ columns })` in a table's extra-config callback are invisible at the type level (the callback's return type is erased to `PgTableExtraConfigValue[]`), so this resolves to `never` for those tables — the runtime still discovers the composite PK via `getTableConfig` and `DrizzleModelId<N>` widens to `Partial<RowOf<N>>` in that case.
 */
export type DrizzlePrimaryKeyColumns<N extends DrizzleTableName> = {
  [K in keyof ColumnsOf<N>]: ColumnsOf<N>[K] extends {
    _: { isPrimaryKey: true };
  }
    ? K
    : never;
}[keyof ColumnsOf<N>];

type IsUnion<T, U extends T = T> = T extends unknown
  ? [U] extends [T]
    ? false
    : true
  : never;

/**
 * Identifier accepted by `findById` / `updateById` / `deleteById`.
 *
 * For a single-column primary key (detected via `_.isPrimaryKey` on the column), this is the bare value type of that column (e.g. `string` for `Investments.id`). For tables whose primary key is type-erased by Drizzle — composite PKs declared via `primaryKey({ columns })`, as well as truly PK-less tables — this widens to `Partial<RowOf<N>>` and the constructor validates at runtime that the object contains exactly the PK columns resolved from `getTableConfig`.
 */
export type DrizzleModelId<N extends DrizzleTableName> = [
  DrizzlePrimaryKeyColumns<N>,
] extends [never]
  ? Partial<RowOf<N>>
  : DrizzlePrimaryKeyColumns<N> extends infer K extends keyof RowOf<N>
    ? IsUnion<K> extends true
      ? Pick<RowOf<N>, K>
      : RowOf<N>[K]
    : never;

type Row = Record<string, unknown>;

/**
 * Thin wrapper around a Drizzle `PgTable` that adds request-agnostic batching + caching via `DataLoader` and a handful of convenience methods (`findById`, `findMany`, `findFirst`, `updateById`, `deleteById`, `insert`).
 *
 * The primary-key shape is discovered at construction via `getTableConfig`: single `.primary` column, or a composite `primaryKey({ columns })` constraint. `findById` accepts either a bare value (single-column PK) or an object keyed by column name (either shape).
 */
export class DrizzleModel<N extends DrizzleTableName> {
  private readonly table: TableOf<N>;
  private readonly pkColumns: readonly string[];
  private readonly loader: DataLoader<DrizzleModelId<N>, RowOf<N> | null>;

  constructor(public readonly tableName: N) {
    const table = schema[tableName] as TableOf<N>;
    this.table = table;
    this.pkColumns = resolvePrimaryKey(table, tableName);
    this.loader = new DataLoader(async (ids) => this.batchLoad(ids), {
      cacheKeyFn: (id) => this.cacheKey(id),
    });
  }

  async findById(id: DrizzleModelId<N>): Promise<RowOf<N>> {
    const row = await this.loader.load(id);
    assert(
      row !== null,
      `${this.tableName}: row not found for id ${this.describeId(id)}`,
    );
    return row;
  }

  /** Like `findById` but resolves to `null` (cached, batched just like a hit) when the row doesn't exist, instead of throwing. Useful for singleton-row tables whose only PK value may or may not yet have a row. */
  async findByIdOrNull(id: DrizzleModelId<N>): Promise<RowOf<N> | null> {
    return this.loader.load(id);
  }

  async findFirst(opts: { where: SQL | undefined }): Promise<RowOf<N> | null> {
    const [row] = await selectWhere(this.table, opts.where, 1);
    if (row) this.prime(row);
    return row ?? null;
  }

  async findMany(opts: { where?: SQL | undefined }): Promise<RowOf<N>[]> {
    const rows = await selectWhere(this.table, opts.where);
    for (const row of rows) this.prime(row);
    return rows;
  }

  async updateById(
    id: DrizzleModelId<N>,
    patch: Partial<InsertOf<N>>,
  ): Promise<RowOf<N>> {
    const [row] = await updateWhere(this.table, patch, this.idPredicate(id));
    assert(
      row,
      `${this.tableName}: row not found for id ${this.describeId(id)}`,
    );
    this.prime(row);
    return row;
  }

  async deleteById(id: DrizzleModelId<N>): Promise<void> {
    const [row] = await deleteWhere(this.table, this.idPredicate(id));
    assert(
      row,
      `${this.tableName}: row not found for id ${this.describeId(id)}`,
    );
    this.loader.clear(id);
  }

  /** Returns the raw Drizzle insert builder, so callers can chain `.returning()`, `.onConflictDoUpdate(...)`, etc. Invalidates the entire DataLoader cache for this table on the way in: an insert (or upsert) may touch any row, and a chained `.onConflictDoUpdate` mutates an existing one — the previously-cached row would silently stay stale otherwise, because the caller never goes through `updateById`. */
  insert(row: InsertOf<N>) {
    this.loader.clearAll();
    return insertInto(this.table, row);
  }

  /** Drop a cached row for `id` so the next `findById` / `findByIdOrNull` re-reads from the database. Use when a mutation path wrote to the table without going through `updateById` / `deleteById`. */
  clearCache(id: DrizzleModelId<N>): void {
    this.loader.clear(id);
  }

  /** Drop every cached row, so every subsequent lookup re-reads from the database. Use after a bulk mutation (delete-all, transactional rewrite) where listing each affected id isn't practical. */
  clearAll(): void {
    this.loader.clearAll();
  }

  private async batchLoad(
    ids: readonly DrizzleModelId<N>[],
  ): Promise<(RowOf<N> | null)[]> {
    const predicates = ids.map((id) => this.idPredicate(id));
    const where = predicates.length === 1 ? predicates[0] : or(...predicates);
    const rows = await selectWhere(this.table, where);
    const byKey = new Map<string, RowOf<N>>();
    for (const row of rows) {
      byKey.set(this.rowCacheKey(row), row);
    }
    return ids.map((id) => byKey.get(this.cacheKey(id)) ?? null);
  }

  private idPredicate(id: DrizzleModelId<N>): SQL {
    const values = this.extractPkValues(id);
    const parts = this.pkColumns.map((name) =>
      eq((this.table as unknown as Row)[name] as never, values[name] as never),
    );
    const combined = parts.length === 1 ? parts[0] : and(...parts);
    assert(combined, "DrizzleModel: empty primary key predicate");
    return combined;
  }

  private extractPkValues(id: DrizzleModelId<N>): Record<string, unknown> {
    if (typeof id === "object" && id !== null) {
      const obj = id as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const name of this.pkColumns) {
        assert(
          name in obj && obj[name] !== undefined,
          `${this.tableName}: id is missing primary-key column "${name}"`,
        );
        out[name] = obj[name];
      }
      const expected = new Set(this.pkColumns);
      for (const name of Object.keys(obj)) {
        assert(
          expected.has(name),
          `${this.tableName}: id has unexpected column "${name}" (primary key is ${this.pkColumns.join(", ")})`,
        );
      }
      return out;
    }
    assert(
      this.pkColumns.length === 1,
      `${this.tableName}: composite primary key (${this.pkColumns.join(", ")}) requires an object, got ${typeof id}`,
    );
    return { [this.pkColumns[0]!]: id };
  }

  private prime(row: RowOf<N>): void {
    const id = this.rowId(row);
    this.loader.clear(id).prime(id, row);
  }

  private rowId(row: RowOf<N>): DrizzleModelId<N> {
    const r = row as unknown as Row;
    if (this.pkColumns.length === 1) {
      return r[this.pkColumns[0]!] as DrizzleModelId<N>;
    }
    const out: Row = {};
    for (const name of this.pkColumns) out[name] = r[name];
    return out as DrizzleModelId<N>;
  }

  private cacheKey(id: DrizzleModelId<N>): string {
    const values = this.extractPkValues(id);
    return this.pkColumns.map((name) => String(values[name])).join("\u0000");
  }

  private rowCacheKey(row: RowOf<N>): string {
    const r = row as unknown as Row;
    return this.pkColumns.map((name) => String(r[name])).join("\u0000");
  }

  private describeId(id: DrizzleModelId<N>): string {
    try {
      return JSON.stringify(this.extractPkValues(id));
    } catch {
      return String(id);
    }
  }
}

/**
 * Thin wrappers around `db.select/update/delete/insert` that keep a fresh generic `T extends PgTable` at the call site — so callers get `T["$inferSelect"]` / `T["$inferInsert"]` back instead of having to cast.
 *
 * Drizzle's public overloads reject a table typed via `Extract<Schema[N], PgTable>` (an unresolved union when `N` is a type parameter); we only cast the argument to `PgTable` once, inside these helpers, and the result type is expressed purely in terms of `T`.
 */
function selectWhere<T extends PgTable>(
  table: T,
  where: SQL | undefined,
  limit?: number,
): Promise<T["$inferSelect"][]> {
  const q = db
    .select()
    .from(table as PgTable)
    .where(where);
  return (limit === undefined ? q : q.limit(limit)) as Promise<
    T["$inferSelect"][]
  >;
}

function updateWhere<T extends PgTable>(
  table: T,
  patch: Partial<T["$inferInsert"]>,
  where: SQL,
): Promise<T["$inferSelect"][]> {
  return db
    .update(table as PgTable)
    .set(patch as Record<string, unknown>)
    .where(where)
    .returning() as Promise<T["$inferSelect"][]>;
}

function deleteWhere<T extends PgTable>(
  table: T,
  where: SQL,
): Promise<T["$inferSelect"][]> {
  return db
    .delete(table as PgTable)
    .where(where)
    .returning() as Promise<T["$inferSelect"][]>;
}

function insertInto<T extends PgTable>(table: T, row: T["$inferInsert"]) {
  return db.insert(table as PgTable).values(row as Record<string, unknown>);
}

/**
 * `DrizzleModel` cache keyed by `"<scope>|<tableName>"` so each session's data scope (main fire DB vs. per-session demo DB) gets its own model instance + DataLoader — otherwise a demo session would see rows cached from the real user's DB (and vice versa) because DataLoader caches by id across requests.
 */
const modelCache = new Map<string, DrizzleModel<DrizzleTableName>>();

function modelCacheKey(scope: string, tableName: DrizzleTableName): string {
  return `${scope}|${tableName}`;
}

/** Discard every `DrizzleModel` instance and their DataLoader caches. Tests only — production mutations invalidate entries via `updateById` / `deleteById` / `clearCache`. */
export function TEST__clearModelCaches(): void {
  for (const m of modelCache.values()) m.clearAll();
  modelCache.clear();
}

/**
 * Process-wide `DrizzleModel` for `tableName`, lazily constructed on first access and memoised thereafter. The backend owns every mutation on these tables, so caching rows across requests is safe; `updateById` / `deleteById` invalidate the relevant entry, and other mutation paths in this codebase should do the same when they run alongside a long-running process. Scoped per session data-scope — see `modelCache`.
 */
export function model<N extends DrizzleTableName>(
  tableName: N,
): DrizzleModel<N> {
  const key = modelCacheKey(currentScope(), tableName);
  let m = modelCache.get(key);
  if (!m) {
    m = new DrizzleModel(tableName) as DrizzleModel<DrizzleTableName>;
    modelCache.set(key, m);
  }
  return m as DrizzleModel<N>;
}

function resolvePrimaryKey(table: PgTable, tableName: string): string[] {
  const config = getTableConfig(table);
  const composite = config.primaryKeys[0];
  if (composite) return composite.columns.map((c) => c.name);
  const single = config.columns.filter((c) => c.primary).map((c) => c.name);
  assert(
    single.length > 0,
    `DrizzleModel(${tableName}): table has no primary key`,
  );
  return single;
}

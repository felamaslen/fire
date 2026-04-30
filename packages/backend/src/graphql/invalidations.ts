import { EventEmitter, on } from "node:events";

import {
  type GraphQLNamedType,
  type GraphQLSchema,
  type GraphQLType,
  isInterfaceType,
  isListType,
  isNonNullType,
  isObjectType,
  isUnionType,
} from "graphql";
import type { ID } from "grats";

import type { Context, Session } from "./context";

/**
 * A cache-invalidation event broadcast over the `invalidations` subscription. Names the `Query` fields whose result has gone stale; the client evicts those on `ROOT_QUERY` and any active query selecting them refetches in the background.
 *
 * Resolvers call `ctx.invalidate({ typename, id })` server-side; `typename` is the resolver-author handle and is mapped (via the schema-derived dependency map) to the `rootFields` carried on the wire — so the client never has to know about typenames or maintain its own typename → field map.
 *
 * @gqlType
 */
export type Invalidation = {
  /** `Query` field names whose result depends on the invalidated data. The client evicts each on `ROOT_QUERY`; consumers refetch. @gqlField */
  rootFields: string[];
};

/**
 * Subscribers get isolated channels. Demo sessions are partitioned by their per-flavour database schema, so each demo connection has its own channel and can never see another's invalidations.
 *
 * The single `"real"` channel assumes the app is **single-tenant** for real sessions: every real connection writes to the same default database, and `Session` carries no user id to scope on. If the data model ever grows multi-user real accounts, this is the spot to fix — the channel must include the owning user's id (e.g. `real:<userId>`), or two connected users would receive each other's invalidations (id leak + spurious cache evictions).
 */
function channelForSession(session: Session): string | null {
  if (session.kind === "real") return "real";
  if (session.kind === "demo") return `demo:${session.database}`;
  return null;
}

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

/**
 * Map from a typename to every `Query` field whose return type structurally references that typename — built from the schema at server boot. When a resolver invalidates a typename, the published event carries the matching field list so the client can evict exactly those entries on `ROOT_QUERY` without keeping its own copy of the dependency graph.
 */
let typenameToRootFields: Map<string, Set<string>> = new Map();

/** Initialise the typename → `Query` fields map from `schema`. Called once at server boot. Subsequent calls overwrite. */
export function initInvalidations(schema: GraphQLSchema): void {
  typenameToRootFields = buildTypenameToRootFields(schema);
}

function buildTypenameToRootFields(
  schema: GraphQLSchema,
): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  const queryType = schema.getQueryType();
  if (!queryType) return result;
  for (const [fieldName, field] of Object.entries(queryType.getFields())) {
    const reachable = collectReachableTypes(field.type, schema, new Set());
    for (const typename of reachable) {
      let set = result.get(typename);
      if (!set) {
        set = new Set();
        result.set(typename, set);
      }
      set.add(fieldName);
    }
  }
  return result;
}

/**
 * A type is an "entity" if it exposes `id: ID!` — every persisted record in this codebase does (see `graphql-schema` skill: "Every persisted object type has `id: ID!`"). Entity types are recorded in the reachable set but the walker does NOT descend into their fields, so a Query field's reachable set only includes:
 *
 * - non-entity wrapper types it walks through (connections, edges, computed-aggregate types)
 * - the immediate entity types those wrappers expose
 *
 * Without this stop, schemas where one entity references another (e.g. `NetWorthCategoryAsset.investmentAllocations.investments[].investment: Investment`) would let the walker cross every entity boundary and conclude that almost every Query field's result transitively depends on every other entity — which is structurally true, but not what we want for invalidations: entity-self updates already merge via the mutation response, so only the *containing field* needs to refetch.
 */
function isEntityType(type: GraphQLNamedType): boolean {
  if (!isObjectType(type) && !isInterfaceType(type)) return false;
  const idField = type.getFields().id;
  if (!idField) return false;
  let t: GraphQLType = idField.type;
  if (isNonNullType(t)) t = t.ofType;
  return "name" in t && t.name === "ID";
}

function collectReachableTypes(
  type: GraphQLType,
  schema: GraphQLSchema,
  visited: Set<string>,
): Set<string> {
  if (isNonNullType(type) || isListType(type)) {
    return collectReachableTypes(type.ofType, schema, visited);
  }
  const named = type as GraphQLNamedType;
  if (visited.has(named.name)) return new Set();
  visited.add(named.name);
  if (!isObjectType(named) && !isInterfaceType(named) && !isUnionType(named)) {
    return new Set();
  }
  const result = new Set<string>([named.name]);
  if (isInterfaceType(named) || isUnionType(named)) {
    for (const t of schema.getPossibleTypes(named)) {
      const sub = collectReachableTypes(t, schema, visited);
      for (const x of sub) result.add(x);
    }
  }
  if (isEntityType(named)) return result;
  if (isObjectType(named) || isInterfaceType(named)) {
    for (const f of Object.values(named.getFields())) {
      const sub = collectReachableTypes(f.type, schema, visited);
      for (const x of sub) result.add(x);
    }
  }
  return result;
}

/** Broadcast an invalidation to every subscriber on `session`'s channel. No-op for anonymous sessions, and a no-op when `typename` has no fields depending on it (skip writing dead events to the wire). */
export function publish(
  session: Session,
  event: { typename: string; id: ID | null },
): void {
  const channel = channelForSession(session);
  if (!channel) return;
  const rootFields = Array.from(typenameToRootFields.get(event.typename) ?? []);
  if (rootFields.length === 0) return;
  emitter.emit(channel, { rootFields });
}

/**
 * Stream of cache-invalidation events for the current session. The client subscribes once at boot; mutation resolvers call `ctx.invalidate(...)` to push events here, which the client handler then translates into Apollo cache evictions. The channel is per-session: real sessions share one channel, each demo session has its own.
 *
 * @gqlSubscriptionField
 */
export async function* invalidations(
  ctx: Context,
): AsyncIterable<Invalidation> {
  const channel = channelForSession(ctx.session);
  if (!channel) return;

  const controller = new AbortController();
  try {
    for await (const [event] of on(emitter, channel, {
      signal: controller.signal,
    })) {
      yield event as Invalidation;
    }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") return;
    throw err;
  } finally {
    controller.abort();
  }
}

import { EventEmitter, on } from "node:events";

import type { ID } from "grats";

import type { Context, Session } from "./context";

/**
 * A cache-invalidation event broadcast over the `invalidations` subscription. Tells the client to evict an entity (or every entity of a given type) from its normalised cache so subsequent reads refetch from the server.
 *
 * @gqlType
 */
export type Invalidation = {
  /** GraphQL type name to invalidate (e.g. `"NetWorthEntry"`). The client evicts cache entries keyed by this `__typename`. @gqlField */
  typename: string;
  /** Specific entity id to invalidate, or null to invalidate every cached entity of this `typename` (used for creates / deletes / aggregate types where the affected list isn't addressable). @gqlField */
  id: ID | null;
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

/** Broadcast an invalidation to every subscriber on `session`'s channel. No-op for anonymous sessions. */
export function publish(session: Session, event: Invalidation): void {
  const channel = channelForSession(session);
  if (channel) emitter.emit(channel, event);
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

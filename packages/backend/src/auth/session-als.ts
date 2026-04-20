import { AsyncLocalStorage } from "node:async_hooks";

import type { Session } from "@/graphql/context";

/**
 * Request-scoped storage for the current `Session`. Set by the GraphQL Fastify handler so non-resolver code (background fetches, cache helpers) can branch on the session without threading `ctx` through every call site.
 *
 * Outside of a request (cron jobs, boot tasks) this returns `undefined` — callers should treat that as "real app" behaviour.
 */
const als = new AsyncLocalStorage<Session>();

export function runWithSession<T>(
  session: Session,
  fn: () => Promise<T>,
): Promise<T> {
  return als.run(session, fn);
}

export function currentSession(): Session | undefined {
  return als.getStore();
}

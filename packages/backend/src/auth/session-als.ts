import { AsyncLocalStorage } from "node:async_hooks";

import type { Session } from "@/graphql/context";

/**
 * Request-scoped storage for the current `Session`. Set by the GraphQL Fastify handler so non-resolver code (background fetches, cache helpers) can branch on "am I serving a demo user?" without threading `ctx` through every call site.
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

/** `true` when called inside a demo-session request. Used to short-circuit outbound paid API calls (Yahoo live quotes, etc.) so synthetic demo data never triggers real network traffic. */
export function isDemoSession(): boolean {
  return currentSession()?.kind === "demo";
}

/**
 * Short identifier for the current session's *data scope* (i.e. which Postgres database its queries land on). Used as a cache-key prefix for every module-level cache / DataLoader that would otherwise leak across sessions:
 *
 *   - `"main"` — the real `fire` DB (real + anon + cron / boot contexts).
 *   - `"demo:<database>"` — a demo session's dedicated DB.
 *
 * Without this prefix, module caches keyed only by "natural" attributes (a currency, a table name, an id) would silently hand cached real-user rows to demo sessions and vice versa.
 */
export function currentScope(): string {
  const session = currentSession();
  if (session?.kind === "demo") return `demo:${session.database}`;
  return "main";
}

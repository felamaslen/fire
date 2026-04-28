import type { Span } from "@opentelemetry/api";
import type { FastifyRequest } from "fastify";

import { type TokenPayload, verifyToken } from "@/auth/token";
import { kFastifyRequestSpan } from "@/router";

/** Resolved session attached to a request's `Context`. Anonymous requests only see unauth'd fields (those carrying `@noAuth`); every other field throws `UNAUTHENTICATED`. */
export type Session =
  | { kind: "anon" }
  | { kind: "real" }
  | { kind: "demo"; database: string; flavour: string };

/**
 * Per-request GraphQL context. Carries the resolved `session` for the auth plugin + any resolver that needs to branch on it (e.g. `logout` to know which demo schema to drop); its identity also acts as the hook that request-scoped caches (e.g. per-entry totals) key off via WeakMap.
 *
 * @gqlContext
 */
export class Context {
  constructor(
    public readonly session: Session,
    /** Top-level `@fastify/otel` `request` span for this HTTP request, if OTel is enabled. Captured at `onRequest` time by `router.ts`; `traceNamePlugin` renames it to the GraphQL operation name so the trace root reads `query Foo` instead of `request`. */
    public readonly requestSpan?: Span,
  ) {}
}

/** Build a `Context` from a Fastify request. Reads `Authorization: Bearer <token>`; unverifiable / expired tokens resolve to an `anon` session (the auth plugin then rejects the operation unless every selected field is `@noAuth`). */
export function createContext({
  request,
}: {
  request: FastifyRequest;
}): Context {
  const header = request.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  const payload = token ? verifyToken(token) : null;
  return new Context(sessionFromPayload(payload), request[kFastifyRequestSpan]);
}

function sessionFromPayload(payload: TokenPayload | null): Session {
  if (!payload) return { kind: "anon" };
  if (payload.kind === "real") return { kind: "real" };
  return {
    kind: "demo",
    database: payload.database,
    flavour: payload.flavour,
  };
}

/**
 * Memoise a loader by GraphQL `Context` identity: the first call in a request runs `fn`, and every subsequent call within the same request returns the cached value.
 *
 * The WeakMap is keyed by `Context`, so the cache is inherently request-scoped — once the context is garbage-collected after the request ends, the entry drops.
 *
 * `args` are forwarded to `fn` on the first call and ignored on cache hits, so typical usage has `fn` return a container (e.g. a `Map`) that callers then index into per-row (`(await loader(ctx)).get(id)`). For loaders where `fn` takes no extra parameters, call it as `loader(ctx)`.
 *
 * The wrapper is intentionally synchronous: when `fn` returns a `Promise<T>`, the wrapper passes the same promise through (so `await loader(ctx)` still works), but when `fn` returns a bare value (e.g. a `DataLoader` instance), callers can use it immediately — without an `await` — in the same microtask. That matters for batching-sensitive consumers like `DataLoader.load`, which coalesces calls made in a single execution frame: an intervening `await` drops the subsequent `.load(...)` into the next microtask and splits the batch.
 */
export function contextAwareDataLoader<T, Args extends unknown[]>(
  /** Function that produces the per-request value. Receives `ctx` plus any forwarded `args` */
  fn: (ctx: Context, ...args: Args) => T,
) {
  const cache = new WeakMap<Context, Map<string, T>>();
  return (ctx: Context, ...args: Args): T => {
    if (!cache.has(ctx)) cache.set(ctx, new Map());
    const key = args.length ? JSON.stringify(args) : "";
    let v = cache.get(ctx)!.get(key);
    if (v === undefined) {
      v = fn(ctx, ...args);
      cache.get(ctx)!.set(key, v);
    }
    return v;
  };
}

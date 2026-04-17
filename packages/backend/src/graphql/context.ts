/**
 * Per-request GraphQL context. Carries no data of its own; its identity is the hook that request-scoped caches (e.g. per-entry totals) key off via WeakMap.
 *
 * @gqlContext
 */
export class Context {}

export async function createContext(): Promise<Context> {
  return new Context();
}

/**
 * Memoise a loader by GraphQL `Context` identity: the first call in a request runs `fn`, and every subsequent call within the same request returns the cached value.
 *
 * The WeakMap is keyed by `Context`, so the cache is inherently request-scoped — once the context is garbage-collected after the request ends, the entry drops.
 *
 * `args` are forwarded to `fn` on the first call and ignored on cache hits, so typical usage has `fn` return a container (e.g. a `Map`) that callers then index into per-row (`(await loader(ctx)).get(id)`). For loaders where `fn` takes no extra parameters, call it as `loader(ctx)`.
 */
export function contextAwareDataLoader<T, Args extends unknown[]>(
  /** Function that produces the per-request value. Receives `ctx` plus any forwarded `args` */
  fn: (ctx: Context, ...args: Args) => T | Promise<T>,
) {
  const cache = new WeakMap<Context, Map<string, T | Promise<T>>>();
  return async (ctx: Context, ...args: Args) => {
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

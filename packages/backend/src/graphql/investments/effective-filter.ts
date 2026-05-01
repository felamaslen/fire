/**
 * Resolve the transfer-aware view of a `filterAssetIdIn` shape — what the
 * stats / chart / xirr / allocation resolvers need to know about a given
 * selection: which assets actually contribute their own series, which are
 * folded in as `extraScopes` sources, and whether the whole view freezes
 * at a `dateCap`. The same logic backs both the `Portfolio` resolvers (via
 * `Portfolio.loadEffectiveFilter`) and free helpers like `Investment.position`,
 * `Query.investments`, the forecast workings, and the allocations mutation.
 *
 * Lives in its own module so it can be shared between `index.ts` and
 * `position.ts` without re-introducing a `position → index → position`
 * import cycle. Cached per-`Context` via `DataLoader` so the underlying
 * transfer / sold-out queries fire once per (sorted asset-id list) per
 * request.
 */

import DataLoader from "dataloader";

import { HOME_CURRENCY } from "@/config";

import { Context, contextAwareDataLoader } from "../context";
import { loadAssetSoldOutCaps } from "./portfolio";
import {
  loadInvestmentTransferInScopesForAsset,
  loadInvestmentTransferOutScopeForAsset,
} from "./transfers";

export type EffectiveAssetFilter = {
  /** The user's filter with any asset whose outgoing-transfer destination is also in the filter dropped (`[src, dest]` collapses to `[dest]` so the source is folded as extras instead of double-counted). `null` mirrors "no asset filter at all". */
  effectiveAssetIds: string[] | null;
  /** Union across surviving assets: each effective asset's inbound transfers' source, capped at the day before the transfer. Source assets may include the dropped ones (that's the whole point of dropping them). */
  extraScopes: ReadonlyArray<{ assetId: string; dateCap: string }>;
  /** `transferDate − 1` (transfer-out) or `lastSellOfWindDown − 1` (sold-out) when *every* effective asset is defunct. `null` otherwise. Multiplexes both reasons because the chart's freeze-at-end behaviour is the same in both cases. */
  dateCap: string | null;
};

const dayBefore = (date: Date | string): string => {
  const d = new Date(date as Date);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

async function computeEffectiveFilter(
  ctx: Context,
  filterAssetIdIn: readonly string[] | null,
): Promise<EffectiveAssetFilter> {
  if (!filterAssetIdIn || filterAssetIdIn.length === 0) {
    return { effectiveAssetIds: null, extraScopes: [], dateCap: null };
  }
  const filterSet = new Set(filterAssetIdIn);
  // Three round-trips fan out in parallel against `filterAssetIdIn` rather
  // than serialising on `effective`: `effective` is always a subset of
  // `filterAssetIdIn`, so speculatively fetching transfers-in / sold-out
  // caps for the dropped ids only adds a few rows to a batched query, but
  // collapses three sequential DataLoader trips into one.
  const [outgoing, incomingByAsset, soldOutCaps] = await Promise.all([
    Promise.all(
      filterAssetIdIn.map((id) =>
        loadInvestmentTransferOutScopeForAsset(ctx, id),
      ),
    ),
    Promise.all(
      filterAssetIdIn.map((id) =>
        loadInvestmentTransferInScopesForAsset(ctx, id),
      ),
    ),
    loadAssetSoldOutCaps(ctx, filterAssetIdIn, HOME_CURRENCY),
  ]);
  const effective: string[] = [];
  for (let i = 0; i < filterAssetIdIn.length; i++) {
    const t = outgoing[i];
    if (t && filterSet.has(t.assetIdTo)) continue;
    effective.push(filterAssetIdIn[i]);
  }
  const effectiveSet = new Set(effective);
  const extras: { assetId: string; dateCap: string }[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < filterAssetIdIn.length; i++) {
    if (!effectiveSet.has(filterAssetIdIn[i])) continue;
    for (const t of incomingByAsset[i]) {
      const cap = dayBefore(t.date);
      const key = `${t.assetIdFrom}@${cap}`;
      if (seen.has(key)) continue;
      seen.add(key);
      extras.push({ assetId: t.assetIdFrom, dateCap: cap });
    }
  }
  let dateCap: string | null = null;
  if (effective.length >= 1) {
    const caps = effective.flatMap((id) => {
      const t = outgoing[filterAssetIdIn.indexOf(id)];
      if (t) return [dayBefore(t.date)];
      const sold = soldOutCaps.get(id);
      return sold ? [sold] : [];
    });
    if (caps.length === effective.length) {
      dateCap = caps.reduce((acc, d) => (d > acc ? d : acc));
    }
  }
  return { effectiveAssetIds: effective, extraScopes: extras, dateCap };
}

// "No asset filter at all" is a distinct shape from `[]`; use a sentinel
// string so `DataLoader.load` (which rejects null/undefined keys) can
// still cache it on a single slot.
const NO_FILTER_KEY = "*";

const effectiveFilterLoader = contextAwareDataLoader(
  (ctx: Context) =>
    new DataLoader<string, EffectiveAssetFilter, string>(
      async (keys) =>
        Promise.all(
          keys.map((k) =>
            computeEffectiveFilter(
              ctx,
              k === NO_FILTER_KEY ? null : k.split(","),
            ),
          ),
        ),
      // Identity cache key — the keys we pass in are already the
      // canonical `sortedIds.join(",")` string.
      { cacheKeyFn: (k) => k },
    ),
);

/** Resolve the transfer-aware filter shape for `filterAssetIdIn`. Cached per-`Context` — repeated calls with the same set of asset ids reuse the underlying SQL. */
export function effectiveAssetFilter(
  ctx: Context,
  filterAssetIdIn: readonly string[] | null | undefined,
): Promise<EffectiveAssetFilter> {
  const key =
    !filterAssetIdIn || filterAssetIdIn.length === 0
      ? NO_FILTER_KEY
      : [...filterAssetIdIn].sort().join(",");
  return effectiveFilterLoader(ctx).load(key);
}

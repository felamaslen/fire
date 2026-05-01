import { strict as assert } from "node:assert";

import DataLoader from "dataloader";
import { eq, inArray } from "drizzle-orm";
import type { ID } from "grats";

import { HOME_CURRENCY } from "@/config";
import { db } from "@/db";
import { InvestmentTransfers } from "@/db/schema/investments";
import { NetWorthCategoryAssets } from "@/db/schema/net-worth";

import { type Context, contextAwareDataLoader } from "../context";
import type { Date as CalendarDate } from "../date";
import { NetWorthCategoryAsset } from "../net-worth/categories";
import { Portfolio } from "./portfolio";

/** Records that all stock holdings (and uninvested cash) of `assetFrom` migrated into `assetTo` on `date`. An asset can be the source of at most one transfer; transferring chains its holdings, cash, and historical transactions through to the destination wrapper for portfolio aggregation. @gqlType */
export class InvestmentTransfer {
  constructor(
    /** @gqlField */
    public readonly id: ID,
    private readonly assetIdFrom_: string,
    private readonly assetIdTo_: string,
    /** Calendar date the holdings moved out of `assetFrom` and into `assetTo`. @gqlField */
    public readonly date: CalendarDate,
  ) {}

  static load(
    row: typeof InvestmentTransfers.$inferSelect,
  ): InvestmentTransfer {
    return new InvestmentTransfer(
      row.id as ID,
      row.assetIdFrom,
      row.assetIdTo,
      row.date,
    );
  }

  /** Wrapper the holdings moved out of. @gqlField */
  async assetFrom(): Promise<NetWorthCategoryAsset> {
    return NetWorthCategoryAsset.fromId(this.assetIdFrom_);
  }

  /** Wrapper the holdings moved into. @gqlField */
  async assetTo(): Promise<NetWorthCategoryAsset> {
    return NetWorthCategoryAsset.fromId(this.assetIdTo_);
  }
}

function invalidateTransferReachable(ctx: Context): void {
  ctx.invalidate({ typename: "InvestmentTransfer", id: null });
  ctx.invalidate({ typename: "NetWorthCategoryAsset", id: null });
  ctx.invalidate({ typename: "Portfolio", id: null });
}

async function assertAssetsAreStockOrPension(
  assetIds: string[],
): Promise<void> {
  const rows = await db
    .select({
      id: NetWorthCategoryAssets.id,
      type: NetWorthCategoryAssets.type,
    })
    .from(NetWorthCategoryAssets)
    .where(inArray(NetWorthCategoryAssets.id, assetIds));
  for (const id of assetIds) {
    const row = rows.find((r) => r.id === id);
    assert(row, `Asset ${id} not found`);
    assert(
      row.type === "STOCK" || row.type === "PENSION",
      `Asset ${id} must be STOCK or PENSION, got ${row.type}`,
    );
  }
}

/** Walk the transfer chain forward from `startAssetId` and throw if it reaches `forbiddenAssetId`. Catches cycles like `A→B; B→A` and longer rings. */
async function assertNoCycle(
  startAssetId: string,
  forbiddenAssetId: string,
): Promise<void> {
  const seen = new Set<string>();
  let current: string | null = startAssetId;
  while (current !== null) {
    assert(
      current !== forbiddenAssetId,
      `Transfer would create a cycle through asset ${forbiddenAssetId}`,
    );
    if (seen.has(current)) return;
    seen.add(current);
    const [next] = await db
      .select({ assetIdTo: InvestmentTransfers.assetIdTo })
      .from(InvestmentTransfers)
      .where(eq(InvestmentTransfers.assetIdFrom, current));
    current = next?.assetIdTo ?? null;
  }
}

/** Record that all stock holdings and uninvested cash of `assetIdFrom` migrated into `assetIdTo` on `date`. The source wrapper is treated as fully sold from that date onwards; the destination wrapper inherits the source's transaction and cash history for portfolio aggregation. An asset can be the source of at most one transfer. @gqlMutationField */
export async function assetStockTransferCreate(
  ctx: Context,
  /** Wrapper the holdings move out of. Must be a `STOCK` or `PENSION` net-worth asset. */
  assetIdFrom: ID,
  /** Wrapper the holdings move into. Must be a `STOCK` or `PENSION` net-worth asset, distinct from `assetIdFrom`. */
  assetIdTo: ID,
  date: CalendarDate,
): Promise<Portfolio> {
  assert(
    assetIdFrom !== assetIdTo,
    "assetIdFrom and assetIdTo must be different",
  );
  await assertAssetsAreStockOrPension([assetIdFrom, assetIdTo]);
  const [existing] = await db
    .select({ id: InvestmentTransfers.id })
    .from(InvestmentTransfers)
    .where(eq(InvestmentTransfers.assetIdFrom, assetIdFrom));
  assert(!existing, `Asset ${assetIdFrom} already has an outgoing transfer`);
  await assertNoCycle(assetIdTo, assetIdFrom);
  await db.insert(InvestmentTransfers).values({ assetIdFrom, assetIdTo, date });
  invalidateTransferReachable(ctx);
  return new Portfolio(HOME_CURRENCY, [assetIdFrom], null, false);
}

/** Update the date of an existing transfer. The source and destination wrappers cannot be changed — delete and recreate to repoint a transfer. @gqlMutationField */
export async function assetStockTransferUpdate(
  ctx: Context,
  assetIdFrom: ID,
  date: CalendarDate,
): Promise<Portfolio> {
  const [row] = await db
    .update(InvestmentTransfers)
    .set({ date, updatedAt: new Date() })
    .where(eq(InvestmentTransfers.assetIdFrom, assetIdFrom))
    .returning();
  assert(row, `No outgoing transfer for asset ${assetIdFrom}`);
  invalidateTransferReachable(ctx);
  return new Portfolio(HOME_CURRENCY, [assetIdFrom], null, false);
}

/** Delete the outgoing transfer on `assetIdFrom`. Both ids must match the existing transfer. Holdings and cash of `assetIdFrom` are no longer chained into `assetIdTo`. @gqlMutationField */
export async function assetStockTransferDelete(
  ctx: Context,
  assetIdFrom: ID,
  assetIdTo: ID,
): Promise<Portfolio> {
  const [existing] = await db
    .select()
    .from(InvestmentTransfers)
    .where(eq(InvestmentTransfers.assetIdFrom, assetIdFrom));
  assert(existing, `No outgoing transfer for asset ${assetIdFrom}`);
  assert(
    existing.assetIdTo === assetIdTo,
    `Transfer from ${assetIdFrom} does not point to ${assetIdTo}`,
  );
  await db
    .delete(InvestmentTransfers)
    .where(eq(InvestmentTransfers.assetIdFrom, assetIdFrom));
  invalidateTransferReachable(ctx);
  return new Portfolio(HOME_CURRENCY, [assetIdFrom], null, false);
}

export async function loadInvestmentTransferOutForAsset(
  assetId: string,
): Promise<InvestmentTransfer | null> {
  const [row] = await db
    .select()
    .from(InvestmentTransfers)
    .where(eq(InvestmentTransfers.assetIdFrom, assetId));
  return row ? InvestmentTransfer.load(row) : null;
}

/** Per-request batched loader for `loadInvestmentTransferOutScopeForAsset`. One SQL covers every requested asset's outgoing transfer (`assetIdFrom IN (...)`). The unique index on `assetIdFrom` guarantees at most one row per key, so the loader maps directly to a per-key value or null. */
const transferOutScopeLoader = contextAwareDataLoader(
  () =>
    new DataLoader<string, { assetIdTo: string; date: Date } | null>(
      async (assetIds) => {
        const ids = [...assetIds];
        const rows = await db
          .select({
            assetIdFrom: InvestmentTransfers.assetIdFrom,
            assetIdTo: InvestmentTransfers.assetIdTo,
            date: InvestmentTransfers.date,
          })
          .from(InvestmentTransfers)
          .where(inArray(InvestmentTransfers.assetIdFrom, ids));
        const byFrom = new Map<string, { assetIdTo: string; date: Date }>();
        for (const r of rows) {
          byFrom.set(r.assetIdFrom, { assetIdTo: r.assetIdTo, date: r.date });
        }
        return ids.map((id) => byFrom.get(id) ?? null);
      },
    ),
);

/** Raw `(assetIdTo, date)` of `assetId`'s outgoing transfer. Internal counterpart to `loadInvestmentTransferOutForAsset` for callers (e.g. `Portfolio.loadEffectiveFilter`) that need the destination id directly without going through the `InvestmentTransfer.assetTo` resolver. */
export async function loadInvestmentTransferOutScopeForAsset(
  ctx: Context,
  assetId: string,
): Promise<{ assetIdTo: string; date: Date } | null> {
  return transferOutScopeLoader(ctx).load(assetId);
}

export async function loadInvestmentTransfersInForAsset(
  assetId: string,
): Promise<InvestmentTransfer[]> {
  const rows = await db
    .select()
    .from(InvestmentTransfers)
    .where(eq(InvestmentTransfers.assetIdTo, assetId));
  return rows.map(InvestmentTransfer.load);
}

/** Per-request batched loader for `loadInvestmentTransferInScopesForAsset`. One SQL covers every requested asset's inbound transfers (`assetIdTo IN (...)`). Each key may have zero or many rows — the loader groups by `assetIdTo` and returns an array per key. */
const transferInScopesLoader = contextAwareDataLoader(
  () =>
    new DataLoader<string, ReadonlyArray<{ assetIdFrom: string; date: Date }>>(
      async (assetIds) => {
        const ids = [...assetIds];
        const rows = await db
          .select({
            assetIdFrom: InvestmentTransfers.assetIdFrom,
            assetIdTo: InvestmentTransfers.assetIdTo,
            date: InvestmentTransfers.date,
          })
          .from(InvestmentTransfers)
          .where(inArray(InvestmentTransfers.assetIdTo, ids));
        const byTo = new Map<string, { assetIdFrom: string; date: Date }[]>();
        for (const r of rows) {
          const list = byTo.get(r.assetIdTo) ?? [];
          list.push({ assetIdFrom: r.assetIdFrom, date: r.date });
          byTo.set(r.assetIdTo, list);
        }
        return ids.map((id) => byTo.get(id) ?? []);
      },
    ),
);

/** Raw `(assetIdFrom, date)` pairs of every inbound transfer into `assetId`. Used by `Portfolio` / `Investment` resolvers to fold each source's pre-transfer transaction history into the destination's aggregates — the public `InvestmentTransfer` class hides `assetIdFrom` behind a `NetWorthCategoryAsset` resolver, which is the wrong shape for this internal use. */
export async function loadInvestmentTransferInScopesForAsset(
  ctx: Context,
  assetId: string,
): Promise<ReadonlyArray<{ assetIdFrom: string; date: Date }>> {
  return transferInScopesLoader(ctx).load(assetId);
}

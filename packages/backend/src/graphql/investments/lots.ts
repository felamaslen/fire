import DataLoader from "dataloader";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  InvestmentStockSplits,
  InvestmentTransactions,
} from "@/db/schema/investments";

import { type Context, contextAwareDataLoader } from "../context";

/**
 * Lot-based FIFO numbers for a single-investment slice. DRIP buys are opened at zero cost so the dividend isn't double-counted: the dividend was already received as income, and the reinvested shares contribute their full market value to the total return.
 *
 * - `costOfRemainingMinor` — sum, over open lots after FIFO consumption, of `lot.units × lot.price` (DRIP lots contribute 0).
 * - `realisedGainMinor` — sum, over sells, of `(sell proceeds − cost-of-FIFO-consumed-lots)` (DRIP-lot consumption contributes 0 to cost-of-consumed).
 *
 * Total return on the slice equals `unrealised + realised` where `unrealised = totalValue − costOfRemainingMinor`.
 */
export type InvestmentLots = {
  costOfRemainingMinor: number;
  realisedGainMinor: number;
};

/** Filter for `loadInvestmentLots`. Mirrors the relevant subset of `InvestmentStatsFilter`: scope is always a single investment, optionally narrowed to wrappers, with the same `dateCap` / `extraScopes` semantics for transferred wrappers. */
export type InvestmentLotsFilter = {
  investmentId: string;
  /** Wrapper scope. Empty / omitted = aggregate across every wrapper. */
  assetIds?: string[];
  dateCap?: string;
  extraScopes?: ReadonlyArray<{ assetId: string; dateCap: string }>;
};

export function loadInvestmentLots(
  ctx: Context,
  key: InvestmentLotsFilter,
): Promise<InvestmentLots> {
  return getLoader(ctx).load(key);
}

/** Tests / mutations clear this when transactions change. */
export function clearInvestmentLotsLoader(ctx: Context): void {
  getLoader(ctx).clearAll();
}

const getLoader = contextAwareDataLoader(
  () =>
    new DataLoader<InvestmentLotsFilter, InvestmentLots, string>(
      async (keys) => {
        // Group by `(dateCap, extraScopes)` so each batch hits one SQL whose
        // `WHERE` shape is consistent across keys (mirrors `loadInvestmentStats`).
        const groupId = (k: InvestmentLotsFilter) => {
          const extra = k.extraScopes
            ? [...k.extraScopes]
                .sort((a, b) =>
                  a.assetId === b.assetId
                    ? a.dateCap.localeCompare(b.dateCap)
                    : a.assetId.localeCompare(b.assetId),
                )
                .map((s) => `${s.assetId}@${s.dateCap}`)
                .join(",")
            : "";
          return `${k.dateCap ?? ""}|${extra}`;
        };
        const byGroup = new Map<string, InvestmentLotsFilter[]>();
        for (const k of keys) {
          const id = groupId(k);
          const list = byGroup.get(id) ?? [];
          list.push(k);
          byGroup.set(id, list);
        }
        const rowsByGroup = new Map<string, TxRow[]>();
        await Promise.all(
          [...byGroup.entries()].map(async ([id, group]) => {
            rowsByGroup.set(id, await fetchTxRows(group));
          }),
        );
        return keys.map((k) => aggregateKey(rowsByGroup.get(groupId(k))!, k));
      },
      { cacheKeyFn },
    ),
);

function cacheKeyFn(k: InvestmentLotsFilter): string {
  const assetIds = k.assetIds ? [...k.assetIds].sort().join(",") : "";
  const extra = k.extraScopes
    ? [...k.extraScopes]
        .sort((a, b) =>
          a.assetId === b.assetId
            ? a.dateCap.localeCompare(b.dateCap)
            : a.assetId.localeCompare(b.assetId),
        )
        .map((s) => `${s.assetId}@${s.dateCap}`)
        .join(",")
    : "";
  return `${k.investmentId}|${assetIds}|${k.dateCap ?? ""}|${extra}`;
}

type TxRow = {
  investmentId: string;
  assetId: string;
  date: string;
  createdAt: Date;
  txId: string;
  units: number;
  price: number;
  drip: boolean;
  adjUnits: number;
};

async function fetchTxRows(
  keys: ReadonlyArray<InvestmentLotsFilter>,
): Promise<TxRow[]> {
  const dateCap = keys[0]?.dateCap;
  const extraScopes = keys[0]?.extraScopes ?? [];
  const investmentIds = [...new Set(keys.map((k) => k.investmentId))];
  // Asset narrowing: union of all assets across keys + extraScopes. Only
  // applied to the SQL when *every* key constrains the asset dimension —
  // a key without `assetIds` wants all wrappers, so we have to scan all.
  const everyKeyHasAssets = keys.every(
    (k) => k.assetIds && k.assetIds.length > 0,
  );
  const mainAssetIdSet = everyKeyHasAssets
    ? [
        ...new Set(
          keys.flatMap((k) => [
            ...(k.assetIds ?? []),
            ...(k.extraScopes ?? []).map((s) => s.assetId),
          ]),
        ),
      ]
    : null;

  const rows = await db
    .select({
      investmentId: InvestmentTransactions.investmentId,
      assetId: InvestmentTransactions.assetId,
      date: sql<string>`${InvestmentTransactions.date}`.as("txDate"),
      createdAt: InvestmentTransactions.createdAt,
      txId: InvestmentTransactions.id,
      units: InvestmentTransactions.units,
      price: InvestmentTransactions.price,
      drip: InvestmentTransactions.drip,
      adjUnits:
        sql<number>`ROUND((${InvestmentTransactions.units} * COALESCE(EXP(SUM(LN(${InvestmentStockSplits.ratio}::double precision))), 1))::numeric, 6)`.as(
          "adjUnits",
        ),
    })
    .from(InvestmentTransactions)
    .leftJoin(
      InvestmentStockSplits,
      and(
        eq(
          InvestmentStockSplits.investmentId,
          InvestmentTransactions.investmentId,
        ),
        gt(InvestmentStockSplits.date, InvestmentTransactions.date),
      ),
    )
    .where(
      and(
        inArray(InvestmentTransactions.investmentId, investmentIds),
        // Asset+date predicate. When extraScopes are present, OR-combine
        // the main scope with each extra scope's `(assetId, dateCap)` pair —
        // mirrors the predicate used in `fetchSlices` so the lots loader and
        // the stats loader agree on which transactions are in scope.
        (() => {
          if (!mainAssetIdSet && extraScopes.length === 0) {
            return dateCap
              ? sql`${InvestmentTransactions.date} <= ${dateCap}::date`
              : undefined;
          }
          if (extraScopes.length === 0) {
            return and(
              mainAssetIdSet
                ? inArray(InvestmentTransactions.assetId, mainAssetIdSet)
                : undefined,
              dateCap
                ? sql`${InvestmentTransactions.date} <= ${dateCap}::date`
                : undefined,
            );
          }
          const branches: ReturnType<typeof sql>[] = [];
          if (mainAssetIdSet && mainAssetIdSet.length > 0) {
            const dateClause = dateCap
              ? sql` AND ${InvestmentTransactions.date} <= ${dateCap}::date`
              : sql``;
            branches.push(
              sql`(${inArray(InvestmentTransactions.assetId, mainAssetIdSet)}${dateClause})`,
            );
          }
          for (const s of extraScopes) {
            branches.push(
              sql`(${InvestmentTransactions.assetId} = ${s.assetId} AND ${InvestmentTransactions.date} <= ${s.dateCap}::date)`,
            );
          }
          return sql`(${sql.join(branches, sql` OR `)})`;
        })(),
      ),
    )
    .groupBy(InvestmentTransactions.id)
    .orderBy(
      asc(InvestmentTransactions.date),
      asc(InvestmentTransactions.createdAt),
      asc(InvestmentTransactions.id),
    );

  // `numeric` columns surface as strings through the postgres driver; coerce
  // to `number` at the boundary so JS arithmetic doesn't silently concatenate.
  return rows.map((r) => ({
    ...r,
    units: Number(r.units),
    price: Number(r.price),
    adjUnits: Number(r.adjUnits),
  }));
}

function aggregateKey(
  rows: TxRow[],
  key: InvestmentLotsFilter,
): InvestmentLots {
  const baseAssets =
    key.assetIds && key.assetIds.length > 0 ? key.assetIds : [];
  const extraAssets = key.extraScopes
    ? key.extraScopes.map((s) => s.assetId)
    : [];
  const assetSet =
    baseAssets.length + extraAssets.length > 0
      ? new Set<string>([...baseAssets, ...extraAssets])
      : null;

  const matches = rows.filter((r) => {
    if (r.investmentId !== key.investmentId) return false;
    if (assetSet && !assetSet.has(r.assetId)) return false;
    return true;
  });

  return computeFifo(matches);
}

/**
 * Walk transactions in chronological order maintaining a FIFO queue of open lots. Each buy opens a lot of `(adjUnits, costMinor)` where DRIP buys carry zero cost — the dividend was already income, so reinvested shares contribute their full market value to total return rather than appearing as new capital. Each sell consumes the oldest lots first; the consumed lots' cost is the basis of that sell's realised gain. Splits are pre-folded into `adjUnits`, so consumption units and held units are in the same coordinate system.
 */
function computeFifo(
  txs: ReadonlyArray<{
    adjUnits: number;
    units: number;
    price: number;
    drip: boolean;
  }>,
): InvestmentLots {
  const lots: { units: number; costMinor: number }[] = [];
  let realisedGainMinor = 0;
  for (const tx of txs) {
    if (tx.adjUnits > 0) {
      const costMinor = tx.drip ? 0 : tx.units * tx.price;
      lots.push({ units: tx.adjUnits, costMinor });
    } else if (tx.adjUnits < 0) {
      let toSell = -tx.adjUnits;
      let costOfConsumedMinor = 0;
      while (toSell > 1e-9 && lots.length > 0) {
        const lot = lots[0];
        const taken = Math.min(lot.units, toSell);
        const portion = lot.units > 0 ? taken / lot.units : 0;
        const costPart = lot.costMinor * portion;
        costOfConsumedMinor += costPart;
        lot.units -= taken;
        lot.costMinor -= costPart;
        toSell -= taken;
        if (lot.units <= 1e-9) lots.shift();
      }
      // Sale proceeds = |units| × price (raw cash), independent of any
      // future split (the proceeds were settled in pre-future-split currency).
      const proceeds = -tx.units * tx.price;
      realisedGainMinor += proceeds - costOfConsumedMinor;
    }
  }
  const costOfRemainingMinor = lots.reduce((a, l) => a + l.costMinor, 0);
  return { costOfRemainingMinor, realisedGainMinor };
}

/**
 * Shared annualised-XIRR computation for a portfolio slice. Used by `Portfolio.xirr` (the investment-page resolver) and by the net-worth-forecast workings, so both surfaces agree exactly on the rate they show for the same wrapper.
 */

import DataLoader from "dataloader";
import { and, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/db";
import { Investments, InvestmentTransactions } from "@/db/schema/investments";
import { solveXirr } from "@/forecast/growth";

import { type Context, contextAwareDataLoader } from "../context";
import { type InvestmentStatsFilter, loadInvestmentStats } from "./stats";

export type PortfolioXirrFilter = {
  /** ISO-4217 currency the slice is expressed in. Investments held in any other currency are excluded from both the cash flows and the terminal value. */
  currency: string;
  /** Asset wrappers in scope, or `null` for "every wrapper". */
  assetIds: readonly string[] | null;
  /** Investments in scope, or `null` for "every investment". */
  investmentIds: readonly string[] | null;
  /** When `true`, the terminal flow uses the most recent cached close instead of the live intraday quote. */
  skipLive: boolean;
  /** ISO-`YYYY-MM-DD` cap, when set: drop transactions with `date > dateCap`, value the terminal flow as of `dateCap` (not "now"). Used for transferred-out wrappers. */
  dateCap?: string;
};

/**
 * Solve XIRR over the slice's full transaction history (each buy as a negative flow, each sell as a positive flow) plus today's live-overlaid market value as the terminal flow at "now". Returns `null` when there are no transactions, when any contributing held investment is missing a price (matching `Portfolio.totalValue`'s graceful-degradation rule), or when the solver doesn't converge.
 */
export async function computePortfolioXirr(
  ctx: Context,
  { currency, assetIds, investmentIds, skipLive, dateCap }: PortfolioXirrFilter,
): Promise<number | null> {
  // Fire stats (live terminal value) and tx history in parallel — they're
  // independent. Both go through per-`Context` DataLoaders so concurrent
  // calls (e.g. one per portfolio wrapper from the forecast loader)
  // coalesce into one SQL each rather than fanning out to N round-trips.
  const txKeys = expandTxKeys({ currency, assetIds, investmentIds, dateCap });
  const [todayValueMinor, txGroups] = await Promise.all([
    loadTodayValueMinor(ctx, {
      currency,
      assetIds,
      investmentIds,
      skipLive,
      dateCap,
    }),
    Promise.all(txKeys.map((k) => getTxLoader(ctx).load(k))),
  ]);
  if (todayValueMinor === null) return null;

  const txRows = txGroups.flat();
  if (txRows.length === 0) return null;

  // Each buy is money out (negative), each sell is money in (positive).
  // `t.units` is already signed, so `-t.units × price` gets the right sign
  // in one step.
  const flows: { date: Date; amount: number }[] = txRows.map((t) => ({
    date: t.date,
    amount: -t.units * t.price,
  }));
  if (todayValueMinor > 0) {
    // Terminal flow at `dateCap` (frozen pre-transfer) when capped, "now"
    // otherwise.
    const terminalDate = dateCap
      ? new Date(`${dateCap}T00:00:00Z`)
      : new Date();
    flows.push({ date: terminalDate, amount: todayValueMinor });
  }
  return solveXirr(flows);
}

/**
 * Sum `InvestmentStats.totalValueMinor` across the per-slice expansion of the filter, propagating `null` the same way `Portfolio.totalValue` does (any contributing held investment missing a price nulls the whole aggregate). Mirrors `Portfolio.loadStats` so both callers see the same DataLoader batch.
 */
async function loadTodayValueMinor(
  ctx: Context,
  { currency, assetIds, investmentIds, skipLive, dateCap }: PortfolioXirrFilter,
): Promise<number | null> {
  const base = {
    currency,
    skipLive,
    ...(dateCap ? { dateCap } : {}),
  } satisfies InvestmentStatsFilter;
  const keys: InvestmentStatsFilter[] = [];
  if (assetIds && investmentIds) {
    for (const assetId of assetIds) {
      for (const investmentId of investmentIds) {
        keys.push({ ...base, assetIds: [assetId], investmentId });
      }
    }
  } else if (assetIds) {
    for (const assetId of assetIds) keys.push({ ...base, assetIds: [assetId] });
  } else if (investmentIds) {
    for (const investmentId of investmentIds) {
      keys.push({ ...base, investmentId });
    }
  } else {
    keys.push(base);
  }
  const slices = await Promise.all(
    keys.map((k) => loadInvestmentStats(ctx, k)),
  );
  let total = 0;
  for (const s of slices) {
    if (s.totalValueMinor === null) return null;
    total += s.totalValueMinor;
  }
  return total;
}

/** One DataLoader key — exactly one `(currency, assetId|null, investmentId|null)` triple identifying a single tx group. `null` on a dimension means "no constraint on that dimension". */
type TxKey = {
  currency: string;
  assetId: string | null;
  investmentId: string | null;
  dateCap?: string;
};

/** Tx row fields needed for XIRR. */
type TxRow = { date: Date; units: number; price: number };

/** Expand a filter into the cartesian product of `(currency, assetId|null, investmentId|null)` keys — one per tx group the caller wants. */
function expandTxKeys(
  f: Pick<
    PortfolioXirrFilter,
    "currency" | "assetIds" | "investmentIds" | "dateCap"
  >,
): TxKey[] {
  const { currency, assetIds, investmentIds, dateCap } = f;
  const cap = dateCap ? { dateCap } : {};
  const out: TxKey[] = [];
  if (assetIds && investmentIds) {
    for (const a of assetIds) {
      for (const i of investmentIds) {
        out.push({ currency, assetId: a, investmentId: i, ...cap });
      }
    }
  } else if (assetIds) {
    for (const a of assetIds) {
      out.push({ currency, assetId: a, investmentId: null, ...cap });
    }
  } else if (investmentIds) {
    for (const i of investmentIds) {
      out.push({ currency, assetId: null, investmentId: i, ...cap });
    }
  } else {
    out.push({ currency, assetId: null, investmentId: null, ...cap });
  }
  return out;
}

// Per-`Context` DataLoader: every concurrent `computePortfolioXirr` call
// in a request expands its filter into one or more `TxKey`s and `.load()`s
// each. The batch fn fires a single SQL covering every key in the tick,
// scoping it to whichever dimensions every key constrains (matching the
// `loadInvestmentStats` batch's "tighten if every key has it" rule), then
// partitions rows back to keys in JS. The forecast loader's per-wrapper
// fan-out collapses into one round-trip; per-request callers stay correct.
const getTxLoader = contextAwareDataLoader(
  () =>
    new DataLoader<TxKey, TxRow[], string>(
      async (keys) => {
        // Group keys by `dateCap` so each batch issues one SQL whose `WHERE`
        // shape matches the cap. Mixing capped + uncapped corrupts per-key
        // results.
        const byCap = new Map<string, TxKey[]>();
        for (const k of keys) {
          const id = k.dateCap ?? "";
          const list = byCap.get(id) ?? [];
          list.push(k);
          byCap.set(id, list);
        }
        const rowsByCap = new Map<string, FetchedRow[]>();
        await Promise.all(
          [...byCap.entries()].map(async ([id, group]) => {
            rowsByCap.set(id, await fetchTxRows(group));
          }),
        );
        return keys.map((k) =>
          filterRowsForKey(rowsByCap.get(k.dateCap ?? "") ?? [], k),
        );
      },
      { cacheKeyFn: txCacheKey },
    ),
);

function txCacheKey(k: TxKey): string {
  return `${k.currency}|${k.assetId ?? ""}|${k.investmentId ?? ""}|${k.dateCap ?? ""}`;
}

type FetchedRow = TxRow & {
  currency: string;
  assetId: string;
  investmentId: string;
};

async function fetchTxRows(keys: ReadonlyArray<TxKey>): Promise<FetchedRow[]> {
  // Every key in the batch shares the same `dateCap` (see the loader's
  // grouping), so we read it from the first key.
  const dateCap = keys[0]?.dateCap;
  const currencies = [...new Set(keys.map((k) => k.currency))];
  const assetIdSet = keys.every((k) => k.assetId !== null)
    ? [...new Set(keys.map((k) => k.assetId as string))]
    : null;
  const investmentIdSet = keys.every((k) => k.investmentId !== null)
    ? [...new Set(keys.map((k) => k.investmentId as string))]
    : null;

  const conditions = [sql`${Investments.currency} IN ${currencies}`];
  if (assetIdSet) {
    conditions.push(inArray(InvestmentTransactions.assetId, assetIdSet));
  }
  if (investmentIdSet) {
    conditions.push(
      inArray(InvestmentTransactions.investmentId, investmentIdSet),
    );
  }
  if (dateCap) {
    conditions.push(sql`${InvestmentTransactions.date} <= ${dateCap}::date`);
  }
  return db
    .select({
      date: InvestmentTransactions.date,
      units: InvestmentTransactions.units,
      price: InvestmentTransactions.price,
      currency: Investments.currency,
      assetId: InvestmentTransactions.assetId,
      investmentId: InvestmentTransactions.investmentId,
    })
    .from(InvestmentTransactions)
    .innerJoin(
      Investments,
      eq(Investments.id, InvestmentTransactions.investmentId),
    )
    .where(and(...conditions));
}

function filterRowsForKey(rows: ReadonlyArray<FetchedRow>, k: TxKey): TxRow[] {
  const out: TxRow[] = [];
  for (const r of rows) {
    if (r.currency !== k.currency) continue;
    if (k.assetId !== null && r.assetId !== k.assetId) continue;
    if (k.investmentId !== null && r.investmentId !== k.investmentId) continue;
    out.push({ date: r.date, units: r.units, price: r.price });
  }
  return out;
}

import DataLoader from "dataloader";
import { and, eq, inArray, isNotNull, sql, sum } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";

import { db } from "@/db";
import {
  InvestmentDeposits,
  InvestmentTransactions,
} from "@/db/schema/investments";
import { PlanningTransactions } from "@/db/schema/planning";

import { type Context, contextAwareDataLoader } from "../context";
import { assertCurrencyCode } from "../money";

/** Per-currency cash float for one wrapper (or wrapper set). Each entry is the net "uninvested cash" the wrapper(s) hold in `currency`, in fractional units. Negative when withdrawals exceed deposits. */
export type AssetCashFloat = {
  currency: string;
  amountMinor: number;
};

/** DataLoader key. `assetIds === null` means "every wrapper" (no asset-id filter). Equivalent (modulo asset-id ordering) keys collapse to one cache slot via `cacheKeyFn`. */
type CashKey = {
  assetIds: string[] | null;
};

function cacheKeyFn(key: CashKey): string {
  return key.assetIds === null ? "*" : [...key.assetIds].sort().join(",");
}

type CashContributionRow = {
  assetId: string;
  currency: string;
  amount: number;
};

/**
 * Run the unioned aggregation that backs the loader. One SQL: three contribution branches (`PlanningTransactions` flipped to the wrapper's perspective, `InvestmentDeposits` straight through, non-DRIP `InvestmentTransactions` as `-round(units × price)`), unioned and grouped per `(assetId, currency)`.
 */
async function fetchContributions(
  assetIds: string[] | null,
): Promise<CashContributionRow[]> {
  // PlanningTransactions.assetId is nullable; the predicate prunes the
  // nulls. The `sql<string>` cast tells Drizzle's result inference that the
  // column is non-nullable inside the union, matching the other branches.
  // Provisional rows (user-authored drafts) are excluded — they're modelled
  // in the planner's balance projections but not part of the wrapper's
  // actual cash float.
  const planning = db
    .select({
      assetId: sql<string>`${PlanningTransactions.assetId}`.as("assetId"),
      currency: PlanningTransactions.currency,
      value: sql<number>`(-${PlanningTransactions.amount})::bigint`.as("value"),
    })
    .from(PlanningTransactions)
    .where(
      and(
        isNotNull(PlanningTransactions.assetId),
        eq(PlanningTransactions.isProvisional, false),
      ),
    );

  const deposits = db
    .select({
      assetId: InvestmentDeposits.assetId,
      currency: InvestmentDeposits.currency,
      value: sql<number>`${InvestmentDeposits.amount}::bigint`.as("value"),
    })
    .from(InvestmentDeposits);

  const trades = db
    .select({
      assetId: InvestmentTransactions.assetId,
      currency: InvestmentTransactions.currency,
      value:
        sql<number>`(-ROUND(${InvestmentTransactions.units} * ${InvestmentTransactions.price}))::bigint`.as(
          "value",
        ),
    })
    .from(InvestmentTransactions)
    .where(eq(InvestmentTransactions.drip, false));

  const contributions = unionAll(planning, deposits, trades).as(
    "contributions",
  );

  const rows = await db
    .select({
      assetId: contributions.assetId,
      currency: contributions.currency,
      amount: sum(contributions.value).mapWith(Number).as("amount"),
    })
    .from(contributions)
    .where(
      assetIds === null ? undefined : inArray(contributions.assetId, assetIds),
    )
    .groupBy(contributions.assetId, contributions.currency);

  return rows.map((r) => ({
    assetId: r.assetId,
    currency: r.currency,
    amount: r.amount,
  }));
}

/**
 * Per-request DataLoader, vended via `contextAwareDataLoader` so each `Context` gets its own instance (and its own cache) — demo and real sessions never share rows. The batch step pre-resolves the union of every requested asset-id set within the batch (with `null` short-circuiting to "no filter"), runs the unioned aggregation once, then projects the per-(assetId, currency) totals back into one `AssetCashFloat[]` per key.
 */
const cashFloatLoader = contextAwareDataLoader(
  () =>
    new DataLoader<CashKey, AssetCashFloat[], string>(
      async (keys) => {
        const needAll = keys.some((k) => k.assetIds === null);
        const requestedIds = needAll
          ? null
          : [
              ...new Set(
                keys.flatMap((k) => (k.assetIds === null ? [] : k.assetIds)),
              ),
            ];

        const rows = await fetchContributions(requestedIds);

        // Index per (assetId → per-currency sum) so each key's aggregation is
        // a simple lookup over its own asset set.
        const byAsset = new Map<string, Map<string, number>>();
        for (const r of rows) {
          let m = byAsset.get(r.assetId);
          if (!m) {
            m = new Map();
            byAsset.set(r.assetId, m);
          }
          m.set(r.currency, (m.get(r.currency) ?? 0) + r.amount);
        }

        return keys.map((key) => {
          const ids =
            key.assetIds === null ? [...byAsset.keys()] : key.assetIds;
          const totals = new Map<string, number>();
          for (const id of ids) {
            const perCurrency = byAsset.get(id);
            if (!perCurrency) continue;
            for (const [currency, amount] of perCurrency) {
              totals.set(currency, (totals.get(currency) ?? 0) + amount);
            }
          }
          return [...totals.entries()].map(([currency, amountMinor]) => ({
            currency,
            amountMinor,
          }));
        });
      },
      { cacheKeyFn },
    ),
);

/** Per-currency uninvested cash float for one wrapper. */
export async function loadAssetCashFloat(
  ctx: Context,
  assetId: string,
): Promise<AssetCashFloat[]> {
  return cashFloatLoader(ctx).load({ assetIds: [assetId] });
}

/** Aggregate uninvested cash across many wrappers (or every `STOCK` / `PENSION` wrapper when `assetIds` is `null`), scoped to a single currency. Returns the total in fractional units of `currency`, clamped to ≥ 0 — recording cash contributions is optional, and a wrapper with held positions but no contribution log shouldn't surface a negative "available to invest" pulled out of the buy cost. */
export async function loadPortfolioCashMinor(
  ctx: Context,
  assetIds: string[] | null,
  currency: string,
): Promise<number> {
  assertCurrencyCode(currency);
  const floats = await cashFloatLoader(ctx).load({ assetIds });
  const minor = floats.find((f) => f.currency === currency)?.amountMinor ?? 0;
  return Math.max(0, minor);
}

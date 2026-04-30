import DataLoader from "dataloader";
import { and, desc, eq, inArray, isNotNull, sql, sum } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";

import { db } from "@/db";
import {
  InvestmentDeposits,
  InvestmentTransactions,
} from "@/db/schema/investments";
import {
  NetWorthEntries,
  NetWorthValueAmounts,
  NetWorthValues,
} from "@/db/schema/net-worth";
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
  kind: "C" | "T";
  amount: number;
};

type SnapshotRow = {
  assetId: string;
  currency: string;
  amount: number;
};

/**
 * Sum of cash contributions and trades per `(assetId, currency, kind)` over the full history. Three branches: `PlanningTransactions` flipped to the wrapper's perspective and `InvestmentDeposits` tagged `C` for contributions, non-DRIP `InvestmentTransactions` as `-round(units × price)` tagged `T` for trades.
 */
async function fetchFlows(
  assetIds: string[] | null,
): Promise<CashContributionRow[]> {
  const planning = db
    .select({
      assetId: sql<string>`${PlanningTransactions.assetId}`.as("assetId"),
      currency: PlanningTransactions.currency,
      value: sql<number>`(-${PlanningTransactions.amount})::bigint`.as("value"),
      kind: sql<"C" | "T">`'C'`.as("kind"),
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
      kind: sql<"C" | "T">`'C'`.as("kind"),
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
      kind: sql<"C" | "T">`'T'`.as("kind"),
    })
    .from(InvestmentTransactions)
    .where(eq(InvestmentTransactions.drip, false));

  const flows = unionAll(planning, deposits, trades).as("flows");

  const rows = await db
    .select({
      assetId: flows.assetId,
      currency: flows.currency,
      kind: flows.kind,
      amount: sum(flows.value).mapWith(Number).as("amount"),
    })
    .from(flows)
    .where(assetIds === null ? undefined : inArray(flows.assetId, assetIds))
    .groupBy(flows.assetId, flows.currency, flows.kind);

  return rows.map((r) => ({
    assetId: r.assetId,
    currency: r.currency,
    kind: r.kind,
    amount: r.amount,
  }));
}

/** Latest `NetWorthEntries.date`, or `null` when no entries exist yet. The cash float anchors on this date — a wrapper's recorded value at the latest entry plus net flows since is taken to absorb the effect of fees, dividends, and price drift between snapshots. */
async function fetchLatestEntryDate(): Promise<Date | null> {
  const [row] = await db
    .select({ d: NetWorthEntries.date })
    .from(NetWorthEntries)
    .orderBy(desc(NetWorthEntries.date))
    .limit(1);
  return row?.d ?? null;
}

/** Per-(assetId, currency) recorded value at `date`. Assets missing from the entry don't appear in the result — the loader treats their absence as "defunct" (zero cash float). */
async function fetchSnapshotValues(
  date: Date,
  assetIds: string[] | null,
): Promise<SnapshotRow[]> {
  const rows = await db
    .select({
      assetId: NetWorthValues.categoryAssetId,
      currency: NetWorthValueAmounts.currency,
      amount: NetWorthValueAmounts.amount,
    })
    .from(NetWorthValues)
    .innerJoin(
      NetWorthValueAmounts,
      eq(NetWorthValueAmounts.valueId, NetWorthValues.id),
    )
    .innerJoin(NetWorthEntries, eq(NetWorthEntries.id, NetWorthValues.entryId))
    .where(
      and(
        eq(NetWorthEntries.date, date),
        isNotNull(NetWorthValues.categoryAssetId),
        assetIds === null
          ? undefined
          : inArray(NetWorthValues.categoryAssetId, assetIds),
      ),
    );
  return rows.flatMap((r) =>
    r.assetId === null
      ? []
      : [
          {
            assetId: r.assetId,
            currency: r.currency,
            amount: Number(r.amount),
          },
        ],
  );
}

/**
 * Per-request DataLoader, vended via `contextAwareDataLoader` so each `Context` gets its own instance (and its own cache) — demo and real sessions never share rows. The batch step pre-resolves the union of every requested asset-id set within the batch (with `null` short-circuiting to "no filter"), then sums the wrapper's full flow history (`deposits` + `planning` + `-buys + sells`) but gates each asset on the latest `NetWorthEntries`: an asset whose latest snapshot is missing or zero in every currency is considered defunct and yields zero, regardless of historic cash flows. When no `NetWorthEntries` exist yet, falls back to a contribution-tracked rule (assets without any deposit / planning row drop their trade rows, so sells > buys can't surface phantom cash on their own).
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

        const latestEntryDate = await fetchLatestEntryDate();
        const flows = await fetchFlows(requestedIds);

        const tracked = await loadTrackedAssetSet(latestEntryDate, flows);

        const byAsset = new Map<string, Map<string, number>>();
        for (const r of flows) {
          if (!tracked(r)) continue;
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

/** Build the per-flow-row "should this asset's flows count?" predicate. With a `latestEntryDate`, an asset is tracked iff it has a positive recorded value in that entry (in any currency). Without one, fall back to the contribution-tracked rule — at least one deposit / planning row must exist for the asset, otherwise its trades alone could surface phantom cash. */
async function loadTrackedAssetSet(
  latestEntryDate: Date | null,
  flows: CashContributionRow[],
): Promise<(row: CashContributionRow) => boolean> {
  if (latestEntryDate !== null) {
    const snapshots = await fetchSnapshotValues(latestEntryDate, null);
    const tracked = new Set<string>();
    for (const s of snapshots) {
      if (s.amount > 0) tracked.add(s.assetId);
    }
    return (r) => tracked.has(r.assetId);
  }
  const contributionTracked = new Set<string>();
  for (const r of flows) {
    if (r.kind === "C") contributionTracked.add(r.assetId);
  }
  return (r) => r.kind === "C" || contributionTracked.has(r.assetId);
}

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

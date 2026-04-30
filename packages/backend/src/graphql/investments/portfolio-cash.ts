import DataLoader from "dataloader";
import { and, desc, eq, gt, inArray, isNotNull, sql, sum } from "drizzle-orm";
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
 * Sum of cash contributions and trades per `(assetId, currency, kind)`. With `since` set, only rows strictly after that date are included — used to add the post-snapshot deltas onto the wrapper's last recorded net-worth value. With `since` `null`, the full history is summed (legacy behaviour, used when the user has no `NetWorthEntries` yet). Three branches: `PlanningTransactions` flipped to the wrapper's perspective and `InvestmentDeposits` tagged `C` for contributions, non-DRIP `InvestmentTransactions` as `-round(units × price)` tagged `T` for trades.
 */
async function fetchFlows(
  assetIds: string[] | null,
  since: Date | null,
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
        since ? gt(PlanningTransactions.date, since) : undefined,
      ),
    );

  const deposits = db
    .select({
      assetId: InvestmentDeposits.assetId,
      currency: InvestmentDeposits.currency,
      value: sql<number>`${InvestmentDeposits.amount}::bigint`.as("value"),
      kind: sql<"C" | "T">`'C'`.as("kind"),
    })
    .from(InvestmentDeposits)
    .where(since ? gt(InvestmentDeposits.date, since) : undefined);

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
    .where(
      and(
        eq(InvestmentTransactions.drip, false),
        since ? gt(InvestmentTransactions.date, since) : undefined,
      ),
    );

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
 * Per-request DataLoader, vended via `contextAwareDataLoader` so each `Context` gets its own instance (and its own cache) — demo and real sessions never share rows. The batch step pre-resolves the union of every requested asset-id set within the batch (with `null` short-circuiting to "no filter"), then either:
 *
 * 1. Anchors on the latest `NetWorthEntries` date (when entries exist). Per asset, the cash float is `(snapshot value at latest entry) + (net flows since latest entry)`. An asset that has no value at the latest entry is considered defunct and yields zero. This treats the recorded net-worth value as ground truth (which silently absorbs ongoing fees, dividends, and price drift) and only re-applies user-tracked deltas after the snapshot.
 * 2. Falls back to summing the full flow history (legacy behaviour) when no `NetWorthEntries` exist yet. In that mode, an asset with no recorded contributions has its trade rows dropped — without a contribution log, sells exceeding buys would otherwise read as phantom available cash from the realised gain alone.
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
        const byAsset = await (latestEntryDate === null
          ? indexLegacy(requestedIds)
          : indexAnchored(requestedIds, latestEntryDate));

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

/** No-snapshot path: sum the full flow history; an asset with no recorded contribution row has its trade rows dropped (otherwise sells > buys read as phantom cash). */
async function indexLegacy(
  assetIds: string[] | null,
): Promise<Map<string, Map<string, number>>> {
  const rows = await fetchFlows(assetIds, null);
  const trackedAssets = new Set<string>();
  for (const r of rows) {
    if (r.kind === "C") trackedAssets.add(r.assetId);
  }
  const byAsset = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (r.kind === "T" && !trackedAssets.has(r.assetId)) continue;
    let m = byAsset.get(r.assetId);
    if (!m) {
      m = new Map();
      byAsset.set(r.assetId, m);
    }
    m.set(r.currency, (m.get(r.currency) ?? 0) + r.amount);
  }
  return byAsset;
}

/** Snapshot-anchored path: per asset, baseline = recorded value at `latestEntryDate`, plus the sum of every flow strictly after that date. Assets missing from the snapshot don't get an entry and are surfaced as zero. */
async function indexAnchored(
  assetIds: string[] | null,
  latestEntryDate: Date,
): Promise<Map<string, Map<string, number>>> {
  const [snapshots, flows] = await Promise.all([
    fetchSnapshotValues(latestEntryDate, assetIds),
    fetchFlows(assetIds, latestEntryDate),
  ]);
  const byAsset = new Map<string, Map<string, number>>();
  for (const s of snapshots) {
    let m = byAsset.get(s.assetId);
    if (!m) {
      m = new Map();
      byAsset.set(s.assetId, m);
    }
    m.set(s.currency, (m.get(s.currency) ?? 0) + s.amount);
  }
  for (const r of flows) {
    // Drop flows for assets the user has marked defunct by omitting them
    // from the latest snapshot — the snapshot is treated as ground truth,
    // and ungrounded post-snapshot trades shouldn't surface cash on their
    // own.
    if (!byAsset.has(r.assetId)) continue;
    const m = byAsset.get(r.assetId)!;
    m.set(r.currency, (m.get(r.currency) ?? 0) + r.amount);
  }
  return byAsset;
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

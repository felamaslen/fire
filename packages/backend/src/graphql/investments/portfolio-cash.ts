import DataLoader from "dataloader";
import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  type SQL,
  sql,
  sum,
} from "drizzle-orm";
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

/** DataLoader key. `assetIds === null` means "every wrapper" (no asset-id filter). `extraScopes` (when set) folds in additional asset flows up to a per-scope `dateCap` — used by transferred-into wrappers to inherit their source's pre-transfer cash flows. Equivalent (modulo ordering) keys collapse to one cache slot via `cacheKeyFn`. */
type CashKey = {
  assetIds: string[] | null;
  extraScopes?: ReadonlyArray<{ assetId: string; dateCap: string }>;
};

function cacheKeyFn(key: CashKey): string {
  const assets =
    key.assetIds === null ? "*" : [...key.assetIds].sort().join(",");
  const extra = key.extraScopes
    ? [...key.extraScopes]
        .sort((a, b) =>
          a.assetId === b.assetId
            ? a.dateCap.localeCompare(b.dateCap)
            : a.assetId.localeCompare(b.assetId),
        )
        .map((s) => `${s.assetId}@${s.dateCap}`)
        .join(",")
    : "";
  return `${assets}|${extra}`;
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
 * Sum of cash contributions and trades per `(assetId, currency, kind)` over the full history. Three branches: `PlanningTransactions` flipped to the wrapper's perspective and `InvestmentDeposits` tagged `C` for contributions, non-DRIP `InvestmentTransactions` as `-(round(units × price) + taxes + fees)` tagged `T` for trades.
 */
async function fetchFlows(
  assetIds: string[] | null,
  extraScopes: ReadonlyArray<{ assetId: string; dateCap: string }>,
): Promise<CashContributionRow[]> {
  // Build the per-asset where: an asset belongs to either the main scope
  // (uncapped) or one of the `extraScopes` (each capped at its own date).
  // SQL: `assetId IN (mainAssetIds) OR (assetId = e1.assetId AND date <=
  // e1.cap) OR …`. When `assetIds` is null and there are no extra scopes,
  // collapses back to "no filter".
  const buildScopeSql = (assetCol: SQL, dateCol: SQL): SQL | undefined => {
    if (assetIds === null && extraScopes.length === 0) return undefined;
    const branches: SQL[] = [];
    if (assetIds !== null && assetIds.length > 0) {
      branches.push(sql`${assetCol} IN ${assetIds}`);
    }
    for (const s of extraScopes) {
      branches.push(
        sql`(${assetCol} = ${s.assetId} AND ${dateCol} <= ${s.dateCap}::date)`,
      );
    }
    return sql`(${sql.join(branches, sql` OR `)})`;
  };
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
        buildScopeSql(
          sql`${PlanningTransactions.assetId}`,
          sql`${PlanningTransactions.date}`,
        ),
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
    .where(
      buildScopeSql(
        sql`${InvestmentDeposits.assetId}`,
        sql`${InvestmentDeposits.date}`,
      ),
    );

  const trades = db
    .select({
      assetId: InvestmentTransactions.assetId,
      currency: InvestmentTransactions.currency,
      // Cash impact of a non-DRIP trade is `-(round(units*price) + taxes +
      // fees)` — buys leave the wrapper minus the broker's full take, sells
      // credit the wrapper with proceeds net of taxes & fees. Excluding
      // taxes / fees here makes the cash float drift apart from the
      // per-row running balance shown on the cash-contributions ledger.
      value:
        sql<number>`(-(ROUND(${InvestmentTransactions.units} * ${InvestmentTransactions.price})::bigint + ${InvestmentTransactions.taxes} + ${InvestmentTransactions.fees}))::bigint`.as(
          "value",
        ),
      kind: sql<"C" | "T">`'T'`.as("kind"),
    })
    .from(InvestmentTransactions)
    .where(
      and(
        eq(InvestmentTransactions.drip, false),
        buildScopeSql(
          sql`${InvestmentTransactions.assetId}`,
          sql`${InvestmentTransactions.date}`,
        ),
      ),
    );

  const flows = unionAll(planning, deposits, trades).as("flows");

  // Each branch already filtered to the asset+date scope, so the outer
  // filter is just a defensive narrow to the union of `assetIds` ∪
  // `extraScopes.assetId` when one is set.
  const eligibleAssetIds =
    assetIds === null && extraScopes.length === 0
      ? null
      : [
          ...new Set([
            ...(assetIds ?? []),
            ...extraScopes.map((s) => s.assetId),
          ]),
        ];
  const rows = await db
    .select({
      assetId: flows.assetId,
      currency: flows.currency,
      kind: flows.kind,
      amount: sum(flows.value).mapWith(Number).as("amount"),
    })
    .from(flows)
    .where(
      eligibleAssetIds === null
        ? undefined
        : inArray(flows.assetId, eligibleAssetIds),
    )
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
        // Bucket keys by `extraScopes` shape so each batch fires one
        // SQL whose per-branch filter is consistent. Keys without
        // `extraScopes` collapse into a single bucket (the common path).
        const extraId = (k: CashKey) =>
          k.extraScopes
            ? [...k.extraScopes]
                .sort((a, b) =>
                  a.assetId === b.assetId
                    ? a.dateCap.localeCompare(b.dateCap)
                    : a.assetId.localeCompare(b.assetId),
                )
                .map((s) => `${s.assetId}@${s.dateCap}`)
                .join(",")
            : "";
        const buckets = new Map<string, CashKey[]>();
        for (const k of keys) {
          const id = extraId(k);
          const list = buckets.get(id) ?? [];
          list.push(k);
          buckets.set(id, list);
        }
        const totalsByBucket = new Map<
          string,
          Map<string, Map<string, number>>
        >();
        await Promise.all(
          [...buckets.entries()].map(async ([id, group]) => {
            const needAll = group.some((k) => k.assetIds === null);
            const requestedIds = needAll
              ? null
              : [
                  ...new Set(
                    group.flatMap((k) =>
                      k.assetIds === null ? [] : k.assetIds,
                    ),
                  ),
                ];
            const extraScopes = group[0].extraScopes ?? [];
            const latestEntryDate = await fetchLatestEntryDate();
            const flows = await fetchFlows(requestedIds, extraScopes);
            const tracked = await loadTrackedAssetSet(
              latestEntryDate,
              flows,
              new Set(extraScopes.map((s) => s.assetId)),
            );
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
            totalsByBucket.set(id, byAsset);
          }),
        );

        return keys.map((key) => {
          const byAsset =
            totalsByBucket.get(extraId(key)) ??
            new Map<string, Map<string, number>>();
          // The destination's own asset(s) plus every `extraScope` source
          // contribute to the result.
          const ids =
            key.assetIds === null
              ? [...byAsset.keys()]
              : [
                  ...key.assetIds,
                  ...(key.extraScopes?.map((s) => s.assetId) ?? []),
                ];
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

/** Build the per-flow-row "should this asset's flows count?" predicate. With a `latestEntryDate`, an asset is tracked iff it has a positive recorded value in that entry (in any currency). Without one, fall back to the contribution-tracked rule — at least one deposit / planning row must exist for the asset, otherwise its trades alone could surface phantom cash. Asset ids in `forceTracked` (e.g. `extraScopes` sources of an inbound transfer) bypass both checks — their pre-cap flows must always count, even though the source wrapper is post-transfer defunct. */
async function loadTrackedAssetSet(
  latestEntryDate: Date | null,
  flows: CashContributionRow[],
  forceTracked: ReadonlySet<string> = new Set(),
): Promise<(row: CashContributionRow) => boolean> {
  if (latestEntryDate !== null) {
    const snapshots = await fetchSnapshotValues(latestEntryDate, null);
    const tracked = new Set<string>();
    for (const s of snapshots) {
      if (s.amount > 0) tracked.add(s.assetId);
    }
    return (r) => forceTracked.has(r.assetId) || tracked.has(r.assetId);
  }
  const contributionTracked = new Set<string>();
  for (const r of flows) {
    if (r.kind === "C") contributionTracked.add(r.assetId);
  }
  return (r) =>
    forceTracked.has(r.assetId) ||
    r.kind === "C" ||
    contributionTracked.has(r.assetId);
}

/** Per-currency uninvested cash float for one wrapper. */
export async function loadAssetCashFloat(
  ctx: Context,
  assetId: string,
): Promise<AssetCashFloat[]> {
  return cashFloatLoader(ctx).load({ assetIds: [assetId] });
}

/** Aggregate uninvested cash across many wrappers (or every `STOCK` / `PENSION` wrapper when `assetIds` is `null`), scoped to a single currency. Returns the total in fractional units of `currency`, clamped to ≥ 0 — recording cash contributions is optional, and a wrapper with held positions but no contribution log shouldn't surface a negative "available to invest" pulled out of the buy cost. `extraScopes` (when set) folds in additional asset flows up to a per-scope `dateCap` — used by transferred-into wrappers to inherit their source's pre-transfer cash flows. */
export async function loadPortfolioCashMinor(
  ctx: Context,
  assetIds: string[] | null,
  currency: string,
  extraScopes: ReadonlyArray<{ assetId: string; dateCap: string }> = [],
): Promise<number> {
  assertCurrencyCode(currency);
  const floats = await cashFloatLoader(ctx).load({
    assetIds,
    ...(extraScopes.length > 0 ? { extraScopes } : {}),
  });
  const minor = floats.find((f) => f.currency === currency)?.amountMinor ?? 0;
  return Math.max(0, minor);
}

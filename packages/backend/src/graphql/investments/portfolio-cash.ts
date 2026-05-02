import DataLoader from "dataloader";
import {
  and,
  desc,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  not,
  or,
  sql,
} from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";

import { db } from "@/db";
import { CurrencyCode } from "@/db/schema/currency";
import {
  InvestmentDeposits,
  InvestmentTransactions,
  InvestmentTransfers,
} from "@/db/schema/investments";
import {
  NetWorthCategoryAssets,
  NetWorthEntries,
  NetWorthValueAmounts,
  NetWorthValues,
} from "@/db/schema/net-worth";
import { PlanningTransactions } from "@/db/schema/planning";

import { type Context, contextAwareDataLoader } from "../context";
import { assertCurrencyCode } from "../money";

/** DataLoader key. `assetIds === null` means "every `STOCK` / `PENSION` wrapper" (transfer-aware); an explicit array narrows the scope to those wrappers (still transfer-aware — transferred-out filter members are dropped, transferred-into ones inherit each source's pre-transfer flows). Equivalent (modulo ordering) keys collapse to one cache slot via `cacheKeyFn`. */
type CashKey = {
  assetIds: string[] | null;
  currency: CurrencyCode;
};

function cacheKeyFn(key: CashKey): string {
  const ids = key.assetIds === null ? "*" : [...key.assetIds].sort().join(",");
  return `${key.currency}|${ids}`;
}

type WrapperCashRow = {
  wrapperId: string;
  currency: string;
  amount: number;
};

/**
 * One SQL query that resolves the per-wrapper, per-currency clamped cash float over the entire scope a batch of loader keys can collectively reach. Pipeline (six CTEs):
 *
 * - `scope`: every `STOCK` / `PENSION` wrapper (optionally narrowed to the union of `assetIds` across the batch — only tightened when *every* key has an explicit filter, mirroring `portfolio-xirr`'s loader) that hasn't been transferred out. A transferred-out wrapper's cash moved with its holdings to the destination, where it's folded back in via the next CTE.
 * - `flow_sources`: per scoped wrapper, the wrapper itself (uncapped) plus every inbound-transfer source capped at the day before the transfer. Lets a transferred-into wrapper inherit the source's pre-transfer flows in one join.
 * - `all_flows`: union of `PlanningTransactions` (flipped to the wrapper's perspective) + `InvestmentDeposits` (both tagged `C` for contribution) + non-DRIP `InvestmentTransactions` (tagged `T`, valued as `−(round(units × price) + taxes + fees)` so buys debit and sells credit net of taxes/fees), restricted to the batch's currencies.
 * - `per_wrapper`: per scoped wrapper × currency, the SUM of folded flow values plus a `has_own_contrib` flag (was there a wrapper-owned `C` row?) for the no-net-worth-entry fallback.
 * - `latest_entry` / `tracked`: latest `NetWorthEntries.date`, and the asset ids with a positive recorded value at it.
 *
 * The final select gates each wrapper on the tracking rule (positive snapshot at the latest entry, or — when no entries exist yet — at least one own contribution) and clamps each per-wrapper float at zero. Clamping per wrapper, not at the aggregate, stops one wrapper's negative carry-over from cancelling another wrapper's genuinely-positive cash. JS sums clamped per-wrapper floats per `(assetIds, currency)` key.
 */
async function fetchPerWrapperCashFloats(
  assetIds: string[] | null,
  currencies: CurrencyCode[],
): Promise<WrapperCashRow[]> {
  if (currencies.length === 0) return [];
  if (assetIds !== null && assetIds.length === 0) return [];

  const scope = db.$with("scope").as(
    db
      .select({ wrapperId: NetWorthCategoryAssets.id })
      .from(NetWorthCategoryAssets)
      .where(
        and(
          inArray(NetWorthCategoryAssets.type, ["STOCK", "PENSION"]),
          assetIds === null
            ? undefined
            : inArray(NetWorthCategoryAssets.id, assetIds),
          not(
            exists(
              db
                .select({ one: sql`1` })
                .from(InvestmentTransfers)
                .where(
                  eq(
                    InvestmentTransfers.assetIdFrom,
                    NetWorthCategoryAssets.id,
                  ),
                ),
            ),
          ),
        ),
      ),
  );

  const ownSources = db
    .with(scope)
    .select({
      wrapperId: scope.wrapperId,
      flowAssetId: sql<string>`${scope.wrapperId}`.as("flow_asset_id"),
      dateCap: sql<Date | null>`NULL::date`.as("date_cap"),
    })
    .from(scope);

  const incomingSources = db
    .with(scope)
    .select({
      wrapperId: scope.wrapperId,
      flowAssetId: InvestmentTransfers.assetIdFrom,
      dateCap:
        sql<Date>`(${InvestmentTransfers.date} - INTERVAL '1 day')::date`.as(
          "date_cap",
        ),
    })
    .from(scope)
    .innerJoin(
      InvestmentTransfers,
      eq(InvestmentTransfers.assetIdTo, scope.wrapperId),
    );

  const flowSources = db
    .$with("flow_sources")
    .as(unionAll(ownSources, incomingSources));

  const planningFlows = db
    .select({
      assetId: sql<string>`${PlanningTransactions.assetId}`.as("asset_id"),
      currency: PlanningTransactions.currency,
      date: PlanningTransactions.date,
      value: sql<number>`(-${PlanningTransactions.amount})::bigint`.as("value"),
      kind: sql<"C" | "T">`'C'`.as("kind"),
    })
    .from(PlanningTransactions)
    .where(
      and(
        isNotNull(PlanningTransactions.assetId),
        eq(PlanningTransactions.isProvisional, false),
        inArray(PlanningTransactions.currency, currencies),
      ),
    );

  const depositFlows = db
    .select({
      assetId: InvestmentDeposits.assetId,
      currency: InvestmentDeposits.currency,
      date: InvestmentDeposits.date,
      value: sql<number>`${InvestmentDeposits.amount}::bigint`.as("value"),
      kind: sql<"C" | "T">`'C'`.as("kind"),
    })
    .from(InvestmentDeposits)
    .where(inArray(InvestmentDeposits.currency, currencies));

  const tradeFlows = db
    .select({
      assetId: InvestmentTransactions.assetId,
      currency: InvestmentTransactions.currency,
      date: InvestmentTransactions.date,
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
        inArray(InvestmentTransactions.currency, currencies),
      ),
    );

  const allFlows = db
    .$with("all_flows")
    .as(unionAll(planningFlows, depositFlows, tradeFlows));

  const perWrapper = db.$with("per_wrapper").as(
    db
      .with(flowSources, allFlows)
      .select({
        wrapperId: flowSources.wrapperId,
        currency: allFlows.currency,
        amount: sql<string>`SUM(${allFlows.value})::bigint`.as("amount"),
        hasOwnContrib:
          sql<boolean>`BOOL_OR(${flowSources.flowAssetId} = ${flowSources.wrapperId} AND ${allFlows.kind} = 'C')`.as(
            "has_own_contrib",
          ),
      })
      .from(flowSources)
      .innerJoin(
        allFlows,
        and(
          eq(allFlows.assetId, flowSources.flowAssetId),
          or(
            isNull(flowSources.dateCap),
            lte(allFlows.date, flowSources.dateCap),
          ),
        ),
      )
      .groupBy(flowSources.wrapperId, allFlows.currency),
  );

  const latestEntry = db
    .$with("latest_entry")
    .as(
      db
        .select({ date: NetWorthEntries.date })
        .from(NetWorthEntries)
        .orderBy(desc(NetWorthEntries.date))
        .limit(1),
    );

  const tracked = db.$with("tracked").as(
    db
      .with(latestEntry)
      .selectDistinct({
        assetId: sql<string>`${NetWorthValues.categoryAssetId}`.as("asset_id"),
      })
      .from(NetWorthValues)
      .innerJoin(
        NetWorthValueAmounts,
        eq(NetWorthValueAmounts.valueId, NetWorthValues.id),
      )
      .innerJoin(
        NetWorthEntries,
        eq(NetWorthEntries.id, NetWorthValues.entryId),
      )
      .where(
        and(
          eq(
            NetWorthEntries.date,
            db.select({ date: latestEntry.date }).from(latestEntry),
          ),
          isNotNull(NetWorthValues.categoryAssetId),
          gt(NetWorthValueAmounts.amount, 0),
        ),
      ),
  );

  // Tracking gate: when a `NetWorthEntries` row exists, the wrapper must
  // appear in the latest entry with a positive recorded value (`tracked`);
  // when no entries exist yet, fall back to "has at least one own
  // contribution" so a wrapper with only trade rows can't surface phantom
  // cash from sells > buys on its own.
  const latestEntryExists = exists(
    db.select({ one: sql`1` }).from(latestEntry),
  );
  const wrapperIsTracked = exists(
    db
      .select({ one: sql`1` })
      .from(tracked)
      .where(eq(tracked.assetId, perWrapper.wrapperId)),
  );

  const rows = await db
    .with(scope, flowSources, allFlows, perWrapper, latestEntry, tracked)
    .select({
      wrapperId: perWrapper.wrapperId,
      currency: perWrapper.currency,
      amount: sql<string>`GREATEST(${perWrapper.amount}, 0)::bigint`.as(
        "amount",
      ),
    })
    .from(perWrapper)
    .where(
      or(
        and(latestEntryExists, wrapperIsTracked),
        and(not(latestEntryExists), eq(perWrapper.hasOwnContrib, true)),
      ),
    );

  return rows.map((r) => ({
    wrapperId: r.wrapperId,
    currency: r.currency,
    amount: Number(r.amount),
  }));
}

/** Per-request DataLoader, vended via `contextAwareDataLoader` so each `Context` gets its own cache (demo and real sessions never share rows). The batch fn fires *one* SQL covering every key in the tick — tightening the wrapper scope to the union of explicit `assetIds` (only when every key has one, mirroring `portfolio-xirr`'s loader) and to the union of currencies — and partitions per-wrapper rows back to keys in JS. Rare cross-Portfolio request shapes (e.g. a `Query.portfolios` connection where each node selects `cash`) collapse into a single round-trip. */
const cashFloatLoader = contextAwareDataLoader(
  () =>
    new DataLoader<CashKey, number, string>(
      async (keys) => {
        const anyUnscoped = keys.some((k) => k.assetIds === null);
        const assetIds = anyUnscoped
          ? null
          : [
              ...new Set(
                keys.flatMap((k) => (k.assetIds === null ? [] : k.assetIds)),
              ),
            ];
        const currencies = [...new Set(keys.map((k) => k.currency))];
        const rows = await fetchPerWrapperCashFloats(assetIds, currencies);
        return keys.map((k) => {
          const wanted = k.assetIds === null ? null : new Set(k.assetIds);
          let total = 0;
          for (const r of rows) {
            if (r.currency !== k.currency) continue;
            if (wanted !== null && !wanted.has(r.wrapperId)) continue;
            total += r.amount;
          }
          return total;
        });
      },
      { cacheKeyFn },
    ),
);

/** Aggregate uninvested cash across many wrappers (or every `STOCK` / `PENSION` wrapper when `assetIds` is `null`), scoped to a single currency. Returns the total in fractional units of `currency`, with each wrapper's float clamped at zero before the sum — a wrapper with held positions but no contribution log shouldn't surface a negative "available to invest" pulled out of the buy cost, and one wrapper's negative carry-over shouldn't cancel another wrapper's positive cash. Transferred-out wrappers are dropped (their cash is folded into the destination); transferred-into wrappers inherit each source's pre-transfer flows automatically. */
export async function loadPortfolioCashMinor(
  ctx: Context,
  assetIds: string[] | null,
  currency: string,
): Promise<number> {
  assertCurrencyCode(currency);
  return cashFloatLoader(ctx).load({ assetIds, currency });
}

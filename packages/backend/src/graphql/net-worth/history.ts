import { asc, eq, inArray } from "drizzle-orm";

import { HOME_CURRENCY } from "@/config";
import { db } from "@/db";
import {
  NetWorthCategoryAssets,
  NetWorthCategoryLiabilities,
  NetWorthCurrencyRates,
  NetWorthEntries,
  NetWorthValueAmounts,
  NetWorthValues,
} from "@/db/schema/net-worth";

import type { Date as CalendarDate } from "../date";
import { Money } from "../money";
import type { NetWorthAssetType } from "./categories";
import { buildRateToHome, convertToHomeMinor } from "./index";

/** One bucket at a single history point, grouped by asset `type`. @gqlType */
export type NetWorthHistoryAssetBucket = {
  /** Asset category type this bucket aggregates. @gqlField */
  type: NetWorthAssetType;
  /** Aggregated amount for this bucket at this point, converted into the home currency. @gqlField */
  amount: Money;
};

/** A single point on the net-worth history timeline — one entry per recorded month. @gqlType */
export type NetWorthHistoryPoint = {
  /** Any calendar date inside the target month. @gqlField */
  date: CalendarDate;
  /** Gross assets at this point, grouped by asset type. Empty buckets are omitted. @gqlField */
  assetsByType: NetWorthHistoryAssetBucket[];
  /** Gross assets total at this point, in the home currency. @gqlField */
  assets: Money;
  /** Total liabilities at this point (positive magnitude), in the home currency. Liabilities marked `skip` are excluded. @gqlField */
  liabilities: Money;
  /** Net worth at this point: `assets − liabilities`. May be negative when debts exceed assets. @gqlField */
  net: Money;
};

/**
 * Full history of net-worth snapshots, oldest first. Each point exposes gross assets split by type plus the overall assets / liabilities / net totals. All amounts are converted into the home currency via each entry's own captured currency rates.
 *
 * @gqlQueryField
 * @gqlAnnotate semanticNonNull
 */
export async function netWorthHistory(): Promise<
  NetWorthHistoryPoint[] | null
> {
  const entries = await db
    .select()
    .from(NetWorthEntries)
    .orderBy(asc(NetWorthEntries.date), asc(NetWorthEntries.id));
  if (entries.length === 0) return [];

  const entryIds = entries.map((e) => e.id);
  const rateRows = await db
    .select()
    .from(NetWorthCurrencyRates)
    .where(inArray(NetWorthCurrencyRates.entryId, entryIds));

  const valueRows = await db
    .select({
      entryId: NetWorthValues.entryId,
      categoryAssetId: NetWorthValues.categoryAssetId,
      categoryLiabilityId: NetWorthValues.categoryLiabilityId,
      categoryOptionId: NetWorthValues.categoryOptionId,
      assetType: NetWorthCategoryAssets.type,
      liabilitySkip: NetWorthCategoryLiabilities.skip,
      amount: NetWorthValueAmounts.amount,
      currency: NetWorthValueAmounts.currency,
    })
    .from(NetWorthValues)
    .leftJoin(
      NetWorthValueAmounts,
      eq(NetWorthValueAmounts.valueId, NetWorthValues.id),
    )
    .leftJoin(
      NetWorthCategoryAssets,
      eq(NetWorthCategoryAssets.id, NetWorthValues.categoryAssetId),
    )
    .leftJoin(
      NetWorthCategoryLiabilities,
      eq(NetWorthCategoryLiabilities.id, NetWorthValues.categoryLiabilityId),
    )
    .where(inArray(NetWorthValues.entryId, entryIds));

  const ratesByEntry = new Map<
    string,
    (typeof NetWorthCurrencyRates.$inferSelect)[]
  >();
  for (const r of rateRows) {
    const arr = ratesByEntry.get(r.entryId);
    if (arr) arr.push(r);
    else ratesByEntry.set(r.entryId, [r]);
  }

  const valuesByEntry = new Map<string, typeof valueRows>();
  for (const v of valueRows) {
    const arr = valuesByEntry.get(v.entryId);
    if (arr) arr.push(v);
    else valuesByEntry.set(v.entryId, [v]);
  }

  const out: NetWorthHistoryPoint[] = [];
  for (const e of entries) {
    const rateMap = buildRateToHome(ratesByEntry.get(e.id) ?? []);
    const assetsByType = new Map<NetWorthAssetType, number>();
    let assetsTotal = 0;
    let liabTotal = 0;

    for (const row of valuesByEntry.get(e.id) ?? []) {
      if (row.amount == null || row.currency == null) continue;
      const homeMinor = convertToHomeMinor(row.amount, row.currency, rateMap);

      if (row.categoryLiabilityId) {
        if (row.liabilitySkip) continue;
        // Liability amounts are stored signed (typically negative); surface
        // as a positive magnitude so `net = assets - liabilities` is correct.
        liabTotal += Math.abs(homeMinor);
      } else if (row.categoryOptionId) {
        assetsByType.set(
          "OPTION",
          (assetsByType.get("OPTION") ?? 0) + homeMinor,
        );
        assetsTotal += homeMinor;
      } else if (row.categoryAssetId && row.assetType) {
        const t = row.assetType as NetWorthAssetType;
        assetsByType.set(t, (assetsByType.get(t) ?? 0) + homeMinor);
        assetsTotal += homeMinor;
      }
    }

    out.push({
      date: e.date,
      assetsByType: [...assetsByType.entries()]
        .filter(([, amt]) => amt !== 0)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([type, amt]) => ({
          type,
          amount: Money.fromMinorDenomination(amt, HOME_CURRENCY),
        })),
      assets: Money.fromMinorDenomination(assetsTotal, HOME_CURRENCY),
      liabilities: Money.fromMinorDenomination(liabTotal, HOME_CURRENCY),
      net: Money.fromMinorDenomination(assetsTotal - liabTotal, HOME_CURRENCY),
    });
  }

  return out;
}

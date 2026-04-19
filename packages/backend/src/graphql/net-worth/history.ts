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

/** One bucket of assets at a single history point, grouped by asset `type`. @gqlType */
export type NetWorthHistoryAssetBucket = {
  /** Asset category type this bucket aggregates. @gqlField */
  type: NetWorthAssetType;
  /** Total value of all assets of this `type` at this point, converted into the home currency. @gqlField */
  amount: Money;
};

/** A single point on the net-worth history timeline — one entry per recorded month. @gqlType */
export type NetWorthHistoryPoint = {
  /** Any calendar date inside the target month. @gqlField */
  date: CalendarDate;
  /** Assets at this point, grouped by asset type. Empty buckets are omitted. @gqlField */
  assetsByType: NetWorthHistoryAssetBucket[];
  /** Total liabilities at this point (positive magnitude), converted into the home currency. Liabilities marked `skip` are excluded. @gqlField */
  liabilities: Money;
  /** Net worth at this point: sum of `assetsByType` minus `liabilities`. @gqlField */
  net: Money;
};

/**
 * Full history of net-worth snapshots, oldest first, with assets split by category type and liabilities aggregated. All amounts are converted into the home currency via each entry's own captured currency rates.
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
    const byType = new Map<NetWorthAssetType, number>();
    let liabMinor = 0;

    for (const row of valuesByEntry.get(e.id) ?? []) {
      if (row.amount == null || row.currency == null) continue;
      const homeMinor = convertToHomeMinor(row.amount, row.currency, rateMap);
      if (row.categoryLiabilityId) {
        if (row.liabilitySkip) continue;
        liabMinor += homeMinor;
      } else if (row.categoryOptionId) {
        byType.set("OPTION", (byType.get("OPTION") ?? 0) + homeMinor);
      } else if (row.categoryAssetId && row.assetType) {
        const t = row.assetType as NetWorthAssetType;
        byType.set(t, (byType.get(t) ?? 0) + homeMinor);
      }
    }

    const assetsByType: NetWorthHistoryAssetBucket[] = [...byType.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([type, amt]) => ({
        type,
        amount: Money.fromMinorDenomination(amt, HOME_CURRENCY),
      }));
    const assetsTotal = [...byType.values()].reduce((a, b) => a + b, 0);

    out.push({
      date: e.date,
      assetsByType,
      liabilities: Money.fromMinorDenomination(liabMinor, HOME_CURRENCY),
      net: Money.fromMinorDenomination(assetsTotal - liabMinor, HOME_CURRENCY),
    });
  }

  return out;
}

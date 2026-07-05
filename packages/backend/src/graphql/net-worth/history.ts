import { asc, eq } from "drizzle-orm";

import { HOME_CURRENCY } from "@/config";
import { db } from "@/db";
import { NetWorthEntries, NetWorthEntryBuckets } from "@/db/schema/net-worth";

import type { Date as CalendarDate } from "../date";
import { Money } from "../money";
import type { NetWorthAssetType } from "./categories";

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
  /** Assets at this point, grouped by asset type. Empty buckets are omitted. The `CASH` bucket is net of credit-card balances (folded in as negative cash), so it can be lower than raw cash — or negative. @gqlField */
  assetsByType: NetWorthHistoryAssetBucket[];
  /** Assets total at this point, in the home currency — net of credit-card balances folded into cash. @gqlField */
  assets: Money;
  /** Total liabilities at this point (positive magnitude), in the home currency. Excludes liabilities marked `skip` and credit cards (which fold into the cash position instead). @gqlField */
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
  const rows = await db
    .select({
      entryId: NetWorthEntries.id,
      date: NetWorthEntries.date,
      bucket: NetWorthEntryBuckets.bucket,
      amount: NetWorthEntryBuckets.amountHomeMinor,
    })
    .from(NetWorthEntries)
    .leftJoin(
      NetWorthEntryBuckets,
      eq(NetWorthEntryBuckets.entryId, NetWorthEntries.id),
    )
    .orderBy(asc(NetWorthEntries.date), asc(NetWorthEntries.id));

  const out: NetWorthHistoryPoint[] = [];
  let current: {
    entryId: string;
    date: Date;
    assetsByType: Map<NetWorthAssetType, number>;
    assetsTotal: number;
    liabTotal: number;
  } | null = null;

  const flush = (): void => {
    if (!current) return;
    out.push({
      date: current.date,
      assetsByType: [...current.assetsByType.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([type, amt]) => ({
          type,
          amount: Money.fromMinorDenomination(amt, HOME_CURRENCY),
        })),
      assets: Money.fromMinorDenomination(current.assetsTotal, HOME_CURRENCY),
      liabilities: Money.fromMinorDenomination(
        current.liabTotal,
        HOME_CURRENCY,
      ),
      net: Money.fromMinorDenomination(
        current.assetsTotal - current.liabTotal,
        HOME_CURRENCY,
      ),
    });
  };

  for (const row of rows) {
    if (!current || current.entryId !== row.entryId) {
      flush();
      current = {
        entryId: row.entryId,
        date: row.date,
        assetsByType: new Map(),
        assetsTotal: 0,
        liabTotal: 0,
      };
    }
    if (row.bucket == null || row.amount == null) continue;
    if (row.bucket === "LIABILITY") {
      current.liabTotal += row.amount;
    } else {
      current.assetsByType.set(row.bucket, row.amount);
      current.assetsTotal += row.amount;
    }
  }
  flush();

  return out;
}

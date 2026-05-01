import DataLoader from "dataloader";
import { and, eq, inArray, sql } from "drizzle-orm";
import { GraphQLError } from "graphql";
import type { Float, ID } from "grats";

import { currentScope } from "@/auth/session-als";
import { db } from "@/db";
import { model } from "@/db/drizzle-model";
import {
  InvestmentAllocations,
  InvestmentTransactions,
} from "@/db/schema/investments";
import { AppSettings } from "@/db/schema/settings";

import type { Context } from "../context";
import {
  getMoneyInputFractionalAmount,
  Money,
  type MoneyInput,
} from "../money";
import { NetWorthCategoryAsset } from "../net-worth/categories";
import { effectiveAssetFilter } from "./effective-filter";
import { Investment } from "./index";

const ALLOCATION_SUM_EPSILON = 1e-9;

/** Target allocation of one wrapper's value to a specific investment. @gqlType */
export class InvestmentAllocation {
  constructor(
    private readonly assetId: string,
    private readonly investmentId: string,
    /** Target fraction of the wrapper's value allocated to the investment. `0 < allocation <= 1`. @gqlField */
    public readonly allocation: Float,
  ) {}

  static load(
    row: typeof InvestmentAllocations.$inferSelect,
  ): InvestmentAllocation {
    return new InvestmentAllocation(
      row.assetId,
      row.investmentId,
      row.allocation as Float,
    );
  }

  /** @gqlField */
  async asset(): Promise<NetWorthCategoryAsset> {
    const row = await model("NetWorthCategoryAssets").findById(this.assetId);
    return NetWorthCategoryAsset.load(row);
  }

  /** @gqlField */
  async investment(): Promise<Investment> {
    const row = await model("Investments").findById(this.investmentId);
    return Investment.load(row);
  }
}

/** Allocations configured for a single wrapper, plus the portfolio-wide cash reserve that applies across the whole portfolio. @gqlType */
export class InvestmentAllocationsResult {
  constructor(
    /** Per-investment allocations for the wrapper. Sums to 1. @gqlField */
    public readonly investments: InvestmentAllocation[],
    /** Portfolio-wide target cash reserve as an absolute monetary value (applies across all wrappers in aggregate). `null` when no cash target has been configured yet. @gqlField */
    public readonly cash: Money | null,
  ) {}
}

/** @gqlInput */
export type InvestmentAllocationInput = {
  investmentId: ID;
  /** Target fraction of the wrapper's value allocated to this investment. `0 < allocation <= 1`. */
  allocation: Float;
};

async function loadActiveInvestmentIds(
  ctx: Context,
  assetId: string,
): Promise<Set<string>> {
  // Use the wrapper's *effective* scope — the wrapper's own txs plus any
  // inbound-transfer source's pre-cap history — so a transferred-into
  // wrapper sees the merged unit count. Without the fold, an investment
  // that the user transferred in then sold to zero in this wrapper reads
  // as a negative net (the closing sells without their matching inflow)
  // and appears as "active", forcing the user to allocate to it even
  // though they hold zero units. With the fold the net resolves to 0
  // and the investment correctly drops out of the required allocation
  // set.
  const { extraScopes } = await effectiveAssetFilter(ctx, [assetId]);
  const branches = [
    eq(InvestmentTransactions.assetId, assetId),
    ...extraScopes.map((s) =>
      and(
        eq(InvestmentTransactions.assetId, s.assetId),
        sql`${InvestmentTransactions.date} <= ${s.dateCap}::date`,
      ),
    ),
  ];
  const where =
    branches.length === 1 ? branches[0] : sql.join(branches, sql` OR `);
  const rows = await db.execute<{ investmentId: string }>(sql`
    WITH tx_adj AS (
      SELECT
        "InvestmentTransactions"."investmentId",
        "InvestmentTransactions".units * COALESCE(EXP((
          SELECT SUM(LN(s.ratio))
          FROM "InvestmentStockSplits" s
          WHERE s."investmentId" = "InvestmentTransactions"."investmentId"
            AND s.date > "InvestmentTransactions".date
        )), 1) AS adj_units
      FROM "InvestmentTransactions"
      WHERE ${where}
    )
    SELECT "investmentId"
    FROM tx_adj
    GROUP BY "investmentId"
    HAVING ABS(SUM(adj_units)) > 1e-9
  `);
  const list = rows.rows ?? rows;
  return new Set(list.map((r) => r.investmentId));
}

/** Replace the per-investment allocations for a wrapper. Must cover every investment with non-zero holdings in the wrapper, exclude every fully-sold investment, and sum to ~1 (post-rounding). Submitted fractions are rounded to the nearest 1% (2dp) before persisting; any residual rounding drift is absorbed by the largest allocation so the saved set still sums to exactly 1. @gqlMutationField */
export async function investmentAllocationsSet(
  ctx: Context,
  /** Wrapper (`STOCK` or `PENSION` net-worth asset) whose allocations are being set. */
  assetId: ID,
  allocations: InvestmentAllocationInput[],
): Promise<InvestmentAllocationsResult> {
  // Validate raw input + dedupe.
  const submitted = new Map<string, number>();
  for (const entry of allocations) {
    if (submitted.has(entry.investmentId)) {
      throw new GraphQLError(
        `Duplicate allocation for investment ${entry.investmentId}`,
      );
    }
    if (!(entry.allocation > 0 && entry.allocation <= 1)) {
      throw new GraphQLError(
        `Allocation for investment ${entry.investmentId} must be in (0, 1]`,
      );
    }
    submitted.set(entry.investmentId, entry.allocation);
  }

  // Pre-round-sum check: catch genuinely-wrong inputs (e.g. user submits
  // [0.3, 0.3]). 5% tolerance is enough headroom that 2dp-quantised input
  // sums always pass while plainly broken inputs still get rejected.
  const rawTotal = [...submitted.values()].reduce((a, b) => a + b, 0);
  if (Math.abs(rawTotal - 1) > 0.05) {
    throw new GraphQLError(
      `Allocations must sum to 1, got ${rawTotal.toFixed(6)}`,
    );
  }

  // Round each to nearest 1% (2dp). Reject anything that rounds to zero —
  // an "I don't want to hold this" signal should be sent by omitting the
  // entry, not submitting `< 0.005`.
  const rounded = new Map<string, number>();
  for (const [id, v] of submitted) {
    const r = Math.round(v * 100) / 100;
    if (r <= 0) {
      throw new GraphQLError(
        `Allocation for investment ${id} rounds to 0 — minimum is 1%`,
      );
    }
    rounded.set(id, r);
  }
  // Each rounded value is a multiple of 0.01, so `drift` is too — adding
  // it to one entry preserves the 2dp invariant exactly.
  const roundedSum = [...rounded.values()].reduce((a, b) => a + b, 0);
  const drift = 1 - roundedSum;
  if (Math.abs(drift) > ALLOCATION_SUM_EPSILON) {
    let maxId: string | null = null;
    let maxValue = -Infinity;
    for (const [id, v] of rounded) {
      if (v > maxValue) {
        maxId = id;
        maxValue = v;
      }
    }
    if (maxId) rounded.set(maxId, maxValue + drift);
  }

  const active = await loadActiveInvestmentIds(ctx, assetId);
  const submittedIds = new Set(submitted.keys());
  const missing = [...active].filter((id) => !submittedIds.has(id));
  const extra = [...submittedIds].filter((id) => !active.has(id));
  if (missing.length > 0) {
    throw new GraphQLError(
      `Missing allocations for held investments: ${missing.join(", ")}`,
    );
  }
  if (extra.length > 0) {
    throw new GraphQLError(
      `Allocations include investments with no holdings: ${extra.join(", ")}`,
    );
  }

  await db.transaction(async (tx) => {
    await tx
      .delete(InvestmentAllocations)
      .where(eq(InvestmentAllocations.assetId, assetId));
    if (rounded.size > 0) {
      await tx.insert(InvestmentAllocations).values(
        [...rounded.entries()].map(([investmentId, allocation]) => ({
          assetId,
          investmentId,
          allocation,
        })),
      );
    }
  });
  invalidateAllocationsForAsset(assetId);

  return loadAllocationsForAsset(assetId);
}

/** Set the portfolio-wide target cash reserve as an absolute monetary value (applies across every wrapper in aggregate). Amount must be non-negative. @gqlMutationField */
export async function investmentCashAllocationSet(
  amount: MoneyInput,
): Promise<Money> {
  const { amount: amountMinor, currency } =
    getMoneyInputFractionalAmount(amount);
  if (amountMinor < 0) {
    throw new GraphQLError(
      `Cash target must be non-negative, got ${amount.amount}`,
    );
  }
  await model("AppSettings")
    .insert({
      singleton: true,
      cashAllocationAmount: amountMinor,
      cashAllocationCurrency: currency,
    })
    .onConflictDoUpdate({
      target: AppSettings.singleton,
      set: {
        cashAllocationAmount: amountMinor,
        cashAllocationCurrency: currency,
        updatedAt: new Date(),
      },
    });
  model("AppSettings").clearCache(true);
  return Money.fromMinorDenomination(amountMinor, currency);
}

async function loadCashAllocation(): Promise<Money | null> {
  const row = await model("AppSettings").findByIdOrNull(true);
  if (
    !row ||
    row.cashAllocationAmount == null ||
    row.cashAllocationCurrency == null
  ) {
    return null;
  }
  return Money.fromMinorDenomination(
    row.cashAllocationAmount,
    row.cashAllocationCurrency,
  );
}

/**
 * Batches `InvestmentAllocations` lookups across wrappers so a page of N wrappers fires one `WHERE assetId IN (...)` instead of N separate queries. One DataLoader per session data-scope so demo and real sessions don't share cached rows.
 */
const allocationsByAssetLoaders = new Map<
  string,
  DataLoader<string, InvestmentAllocation[]>
>();

function allocationsLoader(): DataLoader<string, InvestmentAllocation[]> {
  const scope = currentScope();
  let loader = allocationsByAssetLoaders.get(scope);
  if (loader) return loader;
  loader = new DataLoader<string, InvestmentAllocation[]>(async (assetIds) => {
    const rows = await db
      .select()
      .from(InvestmentAllocations)
      .where(inArray(InvestmentAllocations.assetId, assetIds as string[]));
    const byAsset = new Map<string, InvestmentAllocation[]>();
    for (const row of rows) {
      const list = byAsset.get(row.assetId) ?? [];
      list.push(InvestmentAllocation.load(row));
      byAsset.set(row.assetId, list);
    }
    return assetIds.map((id) => byAsset.get(id) ?? []);
  });
  allocationsByAssetLoaders.set(scope, loader);
  return loader;
}

export function invalidateAllocationsForAsset(assetId: string): void {
  allocationsLoader().clear(assetId);
}

/** Tests only. */
export function TEST__clearAllocationCaches(): void {
  for (const l of allocationsByAssetLoaders.values()) l.clearAll();
  allocationsByAssetLoaders.clear();
}

/** Per-investment allocations configured for this wrapper plus the portfolio-wide cash target.
 *
 * @gqlField investmentAllocations
 */
export async function investmentAllocationsForAsset(
  asset: NetWorthCategoryAsset,
): Promise<InvestmentAllocationsResult> {
  return loadAllocationsForAsset(asset.id);
}

async function loadAllocationsForAsset(
  assetId: string,
): Promise<InvestmentAllocationsResult> {
  const [allocations, cash] = await Promise.all([
    allocationsLoader().load(assetId),
    loadCashAllocation(),
  ]);
  return new InvestmentAllocationsResult(allocations, cash);
}

/** Allocations configured for one wrapper. When `assetId` is `null`, portfolio-wide allocations (weighted across wrappers) — **not yet implemented**, returns an error.
 *
 * @gqlQueryField
 * @gqlAnnotate semanticNonNull
 */
export async function investmentAllocations(
  /** The wrapper whose allocations to return. Pass `null` to aggregate across the whole portfolio (coming in a later release). */
  assetId?: ID | null,
): Promise<InvestmentAllocationsResult | null> {
  if (assetId == null) {
    throw new GraphQLError(
      "Portfolio-wide investmentAllocations (assetId: null) is not yet implemented",
    );
  }
  return loadAllocationsForAsset(assetId);
}

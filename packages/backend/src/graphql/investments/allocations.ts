import DataLoader from "dataloader";
import { eq, inArray, ne, sql, sum } from "drizzle-orm";
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

import {
  getMoneyInputFractionalAmount,
  Money,
  type MoneyInput,
} from "../money";
import { NetWorthCategoryAsset } from "../net-worth/categories";
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

async function loadActiveInvestmentIds(assetId: string): Promise<Set<string>> {
  const rows = await db
    .select({
      investmentId: InvestmentTransactions.investmentId,
      units: sum(InvestmentTransactions.units).as("units"),
    })
    .from(InvestmentTransactions)
    .where(eq(InvestmentTransactions.assetId, assetId))
    .groupBy(InvestmentTransactions.investmentId)
    .having(ne(sql`SUM(${InvestmentTransactions.units})`, 0));
  return new Set(rows.map((r) => r.investmentId));
}

/** Replace the per-investment allocations for a wrapper. Must cover every investment with non-zero holdings in the wrapper, exclude every fully-sold investment, and sum to exactly 1. @gqlMutationField */
export async function investmentAllocationsSet(
  /** Wrapper (`STOCK` or `PENSION` net-worth asset) whose allocations are being set. */
  assetId: ID,
  allocations: InvestmentAllocationInput[],
): Promise<InvestmentAllocationsResult> {
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
  const total = [...submitted.values()].reduce((a, b) => a + b, 0);
  if (Math.abs(total - 1) > ALLOCATION_SUM_EPSILON) {
    throw new GraphQLError(
      `Allocations must sum to 1, got ${total.toFixed(6)}`,
    );
  }

  const active = await loadActiveInvestmentIds(assetId);
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
    if (submitted.size > 0) {
      await tx.insert(InvestmentAllocations).values(
        [...submitted.entries()].map(([investmentId, allocation]) => ({
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

function invalidateAllocationsForAsset(assetId: string): void {
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

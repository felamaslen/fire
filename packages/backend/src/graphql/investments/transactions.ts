import { strict as assert } from "node:assert";

import { and, asc, desc, eq, lt, or } from "drizzle-orm";
import { GraphQLError } from "graphql";
import type { ID, Int } from "grats";

import { db } from "@/db";
import {
  InvestmentAllocations,
  Investments,
  InvestmentTransactions,
} from "@/db/schema/investments";
import { NetWorthCategoryAssets } from "@/db/schema/net-worth";

import type { Date as CalendarDate } from "../date";
import {
  getMoneyInputFractionalAmount,
  getMoneyInputFractionalAmountDouble,
  Money,
  type MoneyInput,
} from "../money";
import { NetWorthCategoryAsset } from "../net-worth/categories";
import {
  buildConnection,
  type Connection,
  decodeCursor,
  encodeCursor,
} from "../pagination";
import { VOID, type Void } from "../void";
import { invalidateAllocationsForAsset } from "./allocations";

/** One buy, sell, or dividend-reinvestment booked against an `Investment` and a wrapper (a net-worth asset of type `STOCK` or `PENSION`). @gqlType */
export class InvestmentTransaction {
  constructor(
    /** @gqlField */
    public readonly id: ID,
    private readonly investmentId: string,
    private readonly assetId: string,
    /** Signed number of units traded. Positive for buys and dividend reinvestments, negative for sells. @gqlField */
    public readonly units: Int,
    private readonly priceMinor: number,
    private readonly taxesMinor: number,
    private readonly feesMinor: number,
    private readonly currency_: string,
    /** Calendar date the trade was executed. @gqlField */
    public readonly date: CalendarDate,
    /** True when this transaction represents a dividend reinvestment rather than a cash buy. @gqlField */
    public readonly drip: boolean,
  ) {}

  static load(
    row: typeof InvestmentTransactions.$inferSelect,
  ): InvestmentTransaction {
    return new InvestmentTransaction(
      row.id as ID,
      row.investmentId,
      row.assetId,
      row.units as Int,
      row.price,
      row.taxes,
      row.fees,
      row.currency,
      row.date,
      row.drip,
    );
  }

  /** Unit price at execution. @gqlField */
  price(): Money {
    return Money.fromMinorDenomination(this.priceMinor, this.currency_);
  }

  /** Taxes paid on the trade. @gqlField */
  taxes(): Money {
    return Money.fromMinorDenomination(this.taxesMinor, this.currency_);
  }

  /** Broker / platform fees paid on the trade. @gqlField */
  fees(): Money {
    return Money.fromMinorDenomination(this.feesMinor, this.currency_);
  }

  /** Wrapper the transaction books into (a `STOCK` or `PENSION` asset). @gqlField */
  async asset(): Promise<NetWorthCategoryAsset> {
    const [row] = await db
      .select()
      .from(NetWorthCategoryAssets)
      .where(eq(NetWorthCategoryAssets.id, this.assetId));
    assert(
      row,
      `NetWorthCategoryAsset ${this.assetId} referenced by InvestmentTransaction ${this.id} is missing`,
    );
    return NetWorthCategoryAsset.load(row);
  }
}

async function assertAssetIsStockOrPension(assetId: string): Promise<void> {
  const [row] = await db
    .select({ type: NetWorthCategoryAssets.type })
    .from(NetWorthCategoryAssets)
    .where(eq(NetWorthCategoryAssets.id, assetId));
  if (!row) {
    throw new GraphQLError(`Asset ${assetId} not found`);
  }
  if (row.type !== "STOCK" && row.type !== "PENSION") {
    throw new GraphQLError(
      `Asset ${assetId} must be STOCK or PENSION, got ${row.type}`,
    );
  }
}

async function assertInvestmentCurrency(
  investmentId: string,
  currency: string,
): Promise<void> {
  const [row] = await db
    .select({ currency: Investments.currency })
    .from(Investments)
    .where(eq(Investments.id, investmentId));
  if (!row) {
    throw new GraphQLError(`Investment ${investmentId} not found`);
  }
  if (row.currency !== currency) {
    throw new GraphQLError(
      `Transaction currency ${currency} does not match Investment currency ${row.currency}`,
    );
  }
}

/** Book a new buy, sell, or dividend-reinvestment against an investment. @gqlMutationField */
export async function investmentTransactionCreate(
  investmentId: ID,
  /** Wrapper to book the trade into. Must be a `STOCK` or `PENSION` net-worth asset. */
  assetId: ID,
  /** Calendar date the trade was executed. */
  date: CalendarDate,
  /** Signed number of units traded. Positive = buy / DRIP, negative = sell. */
  units: Int,
  /** Unit price at execution. Must match the investment's currency. */
  price: MoneyInput,
  /** Taxes paid on the trade. Must match the investment's currency. Defaults to 0. */
  taxes?: MoneyInput | null,
  /** Broker / platform fees paid. Must match the investment's currency. Defaults to 0. */
  fees?: MoneyInput | null,
  /** Set `true` to mark this as a dividend reinvestment rather than a cash buy. Defaults to `false`. */
  drip?: boolean | null,
): Promise<InvestmentTransaction> {
  await assertAssetIsStockOrPension(assetId);
  const { currency, amount: priceMinor } =
    getMoneyInputFractionalAmountDouble(price);
  await assertInvestmentCurrency(investmentId, currency);
  const taxesMinor = taxes
    ? getMoneyInputFractionalAmount(
        assertSameCurrency(taxes, currency, "taxes"),
      ).amount
    : 0;
  const feesMinor = fees
    ? getMoneyInputFractionalAmount(assertSameCurrency(fees, currency, "fees"))
        .amount
    : 0;
  // Detect whether this is the first transaction booking the investment into
  // the wrapper — in that case any saved allocation targets for the wrapper
  // no longer cover the active set and have to be reset (the UI then falls
  // back to actual value-weighted allocations).
  const [firstInWrapper] = await db
    .select({ id: InvestmentTransactions.id })
    .from(InvestmentTransactions)
    .where(
      and(
        eq(InvestmentTransactions.investmentId, investmentId),
        eq(InvestmentTransactions.assetId, assetId),
      ),
    )
    .limit(1);
  const isFirstInWrapper = !firstInWrapper;

  const [row] = await db
    .insert(InvestmentTransactions)
    .values({
      investmentId,
      assetId,
      date,
      units,
      price: priceMinor,
      taxes: taxesMinor,
      fees: feesMinor,
      currency,
      drip: drip ?? false,
    })
    .returning();
  if (isFirstInWrapper) {
    await db
      .delete(InvestmentAllocations)
      .where(eq(InvestmentAllocations.assetId, assetId));
    invalidateAllocationsForAsset(assetId);
  }
  return InvestmentTransaction.load(row);
}

function assertSameCurrency(
  input: MoneyInput,
  expected: string,
  field: string,
): MoneyInput {
  if (input.currency !== expected) {
    throw new GraphQLError(
      `Transaction ${field} currency ${input.currency} does not match expected ${expected}`,
    );
  }
  return input;
}

/** Partial update to a transaction. Omitted / null fields are left unchanged. @gqlMutationField */
export async function investmentTransactionUpdate(
  id: ID,
  assetId?: ID | null,
  date?: CalendarDate | null,
  units?: Int | null,
  price?: MoneyInput | null,
  taxes?: MoneyInput | null,
  fees?: MoneyInput | null,
  drip?: boolean | null,
): Promise<InvestmentTransaction> {
  const [existing] = await db
    .select()
    .from(InvestmentTransactions)
    .where(eq(InvestmentTransactions.id, id));
  if (!existing) {
    throw new GraphQLError(`InvestmentTransaction ${id} not found`);
  }
  const patch: Partial<typeof InvestmentTransactions.$inferInsert> = {};
  if (assetId != null) {
    await assertAssetIsStockOrPension(assetId);
    patch.assetId = assetId;
  }
  if (date != null) patch.date = date;
  if (units != null) patch.units = units;
  const targetCurrency = existing.currency;
  if (price != null) {
    const { amount } = getMoneyInputFractionalAmountDouble(
      assertSameCurrency(price, targetCurrency, "price"),
    );
    patch.price = amount;
  }
  if (taxes != null) {
    const { amount } = getMoneyInputFractionalAmount(
      assertSameCurrency(taxes, targetCurrency, "taxes"),
    );
    patch.taxes = amount;
  }
  if (fees != null) {
    const { amount } = getMoneyInputFractionalAmount(
      assertSameCurrency(fees, targetCurrency, "fees"),
    );
    patch.fees = amount;
  }
  if (drip != null) patch.drip = drip;
  if (Object.keys(patch).length === 0) {
    return InvestmentTransaction.load(existing);
  }
  const [row] = await db
    .update(InvestmentTransactions)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(InvestmentTransactions.id, id))
    .returning();
  return InvestmentTransaction.load(row);
}

/** Delete a transaction. @gqlMutationField */
export async function investmentTransactionDelete(id: ID): Promise<Void> {
  await db
    .delete(InvestmentTransactions)
    .where(eq(InvestmentTransactions.id, id));
  return VOID;
}

/** Paginated transactions for an investment, newest-first. Defaults to the 15 most recent. */
export async function loadInvestmentTransactionsConnection(
  investmentId: string,
  first?: Int | null,
  after?: ID | null,
  filterAssetId?: string | null,
): Promise<Connection<InvestmentTransaction>> {
  const limit = first ?? 15;
  const cursor = after ? decodeCursor(after) : null;

  const conditions = [eq(InvestmentTransactions.investmentId, investmentId)];
  if (filterAssetId) {
    conditions.push(eq(InvestmentTransactions.assetId, filterAssetId));
  }
  if (cursor) {
    const cursorDate = new Date(cursor.c);
    conditions.push(
      or(
        lt(InvestmentTransactions.date, cursorDate),
        and(
          eq(InvestmentTransactions.date, cursorDate),
          lt(InvestmentTransactions.id, cursor.i),
        ),
      )!,
    );
  }

  const rows = await db
    .select()
    .from(InvestmentTransactions)
    .where(and(...conditions))
    .orderBy(desc(InvestmentTransactions.date), desc(InvestmentTransactions.id))
    .limit(limit + 1);

  const hasNextPage = rows.length > limit;
  const page = hasNextPage ? rows.slice(0, limit) : rows;
  const nodes = page.map(InvestmentTransaction.load);

  return buildConnection<InvestmentTransaction>(
    nodes,
    (node) => {
      const row = page.find((r) => r.id === node.id)!;
      return encodeCursor(row.date.toISOString(), row.id);
    },
    { hasNextPage, hasPreviousPage: cursor != null },
  );
}

/** Load the transactions for an investment, oldest-first. */
export async function loadInvestmentTransactions(
  investmentId: string,
  opts: { direction?: "asc" | "desc" } = {},
): Promise<InvestmentTransaction[]> {
  const order = opts.direction === "desc" ? desc : asc;
  const rows = await db
    .select()
    .from(InvestmentTransactions)
    .where(eq(InvestmentTransactions.investmentId, investmentId))
    .orderBy(
      order(InvestmentTransactions.date),
      order(InvestmentTransactions.id),
    );
  return rows.map(InvestmentTransaction.load);
}

/** Load transactions for an investment scoped to a specific wrapper. */
export async function loadInvestmentTransactionsForAsset(
  investmentId: string,
  assetId: string,
): Promise<InvestmentTransaction[]> {
  const rows = await db
    .select()
    .from(InvestmentTransactions)
    .where(
      and(
        eq(InvestmentTransactions.investmentId, investmentId),
        eq(InvestmentTransactions.assetId, assetId),
      ),
    )
    .orderBy(asc(InvestmentTransactions.date));
  return rows.map(InvestmentTransaction.load);
}

import { strict as assert } from "node:assert";

import { and, asc, desc, eq, lt, or } from "drizzle-orm";
import { GraphQLError } from "graphql";
import type { Float, ID, Int } from "grats";

import { sessionMayReadKey, signFileUrl } from "@/auth/file-url";
import { db } from "@/db";
import {
  InvestmentAllocations,
  Investments,
  InvestmentTransactions,
} from "@/db/schema/investments";
import { NetWorthCategoryAssets } from "@/db/schema/net-worth";
import { storeUpload } from "@/uploads";

import type { Context } from "../context";
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
import type { Upload } from "../upload";
import { VOID, type Void } from "../void";
import { invalidateAllocationsForAsset } from "./allocations";

/** One buy, sell, or dividend-reinvestment booked against an `Investment` and a wrapper (a net-worth asset of type `STOCK` or `PENSION`). @gqlType */
export class InvestmentTransaction {
  constructor(
    /** @gqlField */
    public readonly id: ID,
    private readonly investmentId: string,
    private readonly assetId: string,
    /** Signed number of units traded. Positive for buys and dividend reinvestments, negative for sells. Fractional units are supported. @gqlField */
    public readonly units: Float,
    private readonly priceMinor: number,
    private readonly taxesMinor: number,
    private readonly feesMinor: number,
    private readonly currency_: string,
    /** Calendar date the trade was executed. @gqlField */
    public readonly date: CalendarDate,
    /** True when this transaction represents a dividend reinvestment rather than a cash buy. @gqlField */
    public readonly drip: boolean,
    /** Bare storage key for the uploaded contract-note file, or `null` if none. The `fileUrl` GraphQL field wraps this in a short-lived signed URL per request. */
    private readonly fileKey: string | null,
  ) {}

  static load(
    row: typeof InvestmentTransactions.$inferSelect,
  ): InvestmentTransaction {
    return new InvestmentTransaction(
      row.id as ID,
      row.investmentId,
      row.assetId,
      row.units as Float,
      row.price,
      row.taxes,
      row.fees,
      row.currency,
      row.date,
      row.drip,
      row.fileUrl,
    );
  }

  /** Signed, short-lived URL to the uploaded contract-note file (PDF), or `null` if none was uploaded or the current session isn't allowed to read it. The URL's signature covers the storage key + expiry so the `/files/*` endpoint can serve it without the browser attaching an `Authorization` header. @gqlField */
  fileUrl(ctx: Context): string | null {
    if (!this.fileKey) return null;
    if (!sessionMayReadKey(ctx.session, this.fileKey)) return null;
    return signFileUrl(this.fileKey);
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

function invalidateTransactionReachable(ctx: Context): void {
  ctx.invalidate({ typename: "InvestmentTransaction", id: null });
  ctx.invalidate({ typename: "Investment", id: null });
  ctx.invalidate({ typename: "NetWorthCategoryAsset", id: null });
  ctx.invalidate({ typename: "Portfolio", id: null });
}

/** Book a new buy, sell, or dividend-reinvestment against an investment. @gqlMutationField */
export async function investmentTransactionCreate(
  ctx: Context,
  investmentId: ID,
  /** Wrapper to book the trade into. Must be a `STOCK` or `PENSION` net-worth asset. */
  assetId: ID,
  /** Calendar date the trade was executed. */
  date: CalendarDate,
  /** Signed number of units traded. Positive = buy / DRIP, negative = sell. Fractional units are supported. */
  units: Float,
  /** Unit price at execution. Must match the investment's currency. */
  price: MoneyInput,
  /** Taxes paid on the trade. Must match the investment's currency. Defaults to 0. */
  taxes?: MoneyInput | null,
  /** Broker / platform fees paid. Must match the investment's currency. Defaults to 0. */
  fees?: MoneyInput | null,
  /** Set `true` to mark this as a dividend reinvestment rather than a cash buy. Defaults to `false`. */
  drip?: boolean | null,
  /** Multipart file upload (per graphql-multipart-request-spec). Stored in the uploads bucket, scoped to the caller's session; the resolved key is persisted on the row. Mutually exclusive with `fileKey`. */
  file?: Upload | null,
  /** Already-stored upload key (returned by `investmentContractNoteImport.fileKey`) to attach to the new transaction without re-uploading. Mutually exclusive with `file`. */
  fileKey?: string | null,
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

  if (file && fileKey) {
    throw new GraphQLError(
      "Pass either `file` (new upload) or `fileKey` (already-stored), not both.",
    );
  }
  const resolvedFileKey = file
    ? await storeUpload(await file, ctx.session)
    : (fileKey ?? null);

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
      fileUrl: resolvedFileKey,
    })
    .returning();
  if (isFirstInWrapper) {
    await db
      .delete(InvestmentAllocations)
      .where(eq(InvestmentAllocations.assetId, assetId));
    invalidateAllocationsForAsset(assetId);
  }
  invalidateTransactionReachable(ctx);
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

/** Partial update to a transaction. Omitted / null fields are left unchanged.
 *
 * Pass `file` to attach (or replace) the contract-note PDF; pass `clearFile: true` to remove an existing one. `file` and `clearFile` are mutually exclusive — pass one or the other, not both.
 *
 * @gqlMutationField
 */
export async function investmentTransactionUpdate(
  ctx: Context,
  id: ID,
  assetId?: ID | null,
  date?: CalendarDate | null,
  units?: Float | null,
  price?: MoneyInput | null,
  taxes?: MoneyInput | null,
  fees?: MoneyInput | null,
  drip?: boolean | null,
  /** Replacement contract-note upload. */
  file?: Upload | null,
  /** Clear an existing contract-note attachment. Mutually exclusive with `file`. */
  clearFile?: boolean | null,
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
  if (file && clearFile) {
    throw new GraphQLError(
      "Pass either `file` (replace) or `clearFile: true` (remove), not both.",
    );
  }
  if (file) {
    patch.fileUrl = await storeUpload(await file, ctx.session);
  } else if (clearFile) {
    patch.fileUrl = null;
  }
  if (Object.keys(patch).length === 0) {
    return InvestmentTransaction.load(existing);
  }
  const [row] = await db
    .update(InvestmentTransactions)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(InvestmentTransactions.id, id))
    .returning();
  invalidateTransactionReachable(ctx);
  return InvestmentTransaction.load(row);
}

/** Delete a transaction. @gqlMutationField */
export async function investmentTransactionDelete(
  ctx: Context,
  id: ID,
): Promise<Void> {
  await db
    .delete(InvestmentTransactions)
    .where(eq(InvestmentTransactions.id, id));
  invalidateTransactionReachable(ctx);
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

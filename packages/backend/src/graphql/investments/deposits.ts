import { desc, eq } from "drizzle-orm";
import { GraphQLError } from "graphql";
import type { ID } from "grats";

import { db } from "@/db";
import { InvestmentDeposits } from "@/db/schema/investments";
import { NetWorthCategoryAssets } from "@/db/schema/net-worth";

import type { Date as CalendarDate } from "../date";
import {
  getMoneyInputFractionalAmount,
  Money,
  type MoneyInput,
} from "../money";
import { NetWorthCategoryAsset } from "../net-worth/categories";
import { VOID, type Void } from "../void";

/** A cash inflow into a wrapper that doesn't originate from a planning cash account — e.g. dividend income, broker bonus, or pension tax relief credited by HMRC. Combined with planning cash transactions and non-DRIP unit trades to derive the wrapper's uninvested cash float. @gqlType */
export class InvestmentDeposit {
  constructor(
    /** @gqlField */
    public readonly id: ID,
    private readonly assetId: string,
    /** Calendar date the cash landed in the wrapper. @gqlField */
    public readonly date: CalendarDate,
    private readonly amountMinor: number,
    private readonly currency_: string,
    /** Short label for the deposit (e.g. "Q2 dividend", "Tax relief"). @gqlField */
    public readonly name: string,
  ) {}

  static load(row: typeof InvestmentDeposits.$inferSelect): InvestmentDeposit {
    return new InvestmentDeposit(
      row.id as ID,
      row.assetId,
      row.date,
      row.amount,
      row.currency,
      row.name,
    );
  }

  /** Signed cash amount. Positive = credit to the wrapper (the common case); negative = a withdrawal that isn't paired with a unit trade. @gqlField */
  amount(): Money {
    return Money.fromMinorDenomination(this.amountMinor, this.currency_);
  }

  /** Wrapper this deposit is booked into. @gqlField */
  async asset(): Promise<NetWorthCategoryAsset> {
    return NetWorthCategoryAsset.fromId(this.assetId);
  }
}

async function assertAssetIsStockOrPension(assetId: string): Promise<void> {
  const [row] = await db
    .select({ type: NetWorthCategoryAssets.type })
    .from(NetWorthCategoryAssets)
    .where(eq(NetWorthCategoryAssets.id, assetId));
  if (!row) throw new GraphQLError(`Asset ${assetId} not found`);
  if (row.type !== "STOCK" && row.type !== "PENSION") {
    throw new GraphQLError(
      `Asset ${assetId} must be STOCK or PENSION, got ${row.type}`,
    );
  }
}

/** Record an external cash credit (or, with a negative `amount`, a debit) on a wrapper that doesn't correspond to a planning transfer or a unit trade. @gqlMutationField */
export async function investmentDepositCreate(
  /** Wrapper to credit. Must be a `STOCK` or `PENSION` net-worth asset. */
  assetId: ID,
  date: CalendarDate,
  /** Signed cash amount. Positive = credit to the wrapper; negative = debit. */
  amount: MoneyInput,
  /** Short label for the deposit (e.g. "Q2 dividend"). */
  name: string,
): Promise<InvestmentDeposit> {
  await assertAssetIsStockOrPension(assetId);
  const { currency, amount: amountMinor } =
    getMoneyInputFractionalAmount(amount);
  const [row] = await db
    .insert(InvestmentDeposits)
    .values({ assetId, date, amount: amountMinor, currency, name })
    .returning();
  return InvestmentDeposit.load(row);
}

/** Partial update for an `InvestmentDeposit`. Omitted (or `null`) fields are left unchanged. @gqlMutationField */
export async function investmentDepositUpdate(
  id: ID,
  date?: CalendarDate | null,
  amount?: MoneyInput | null,
  name?: string | null,
): Promise<InvestmentDeposit> {
  const [existing] = await db
    .select()
    .from(InvestmentDeposits)
    .where(eq(InvestmentDeposits.id, id));
  if (!existing) throw new GraphQLError(`InvestmentDeposit ${id} not found`);
  const patch: Partial<typeof InvestmentDeposits.$inferInsert> = {};
  if (date != null) patch.date = date;
  if (name != null) patch.name = name;
  if (amount != null) {
    const { currency, amount: amountMinor } =
      getMoneyInputFractionalAmount(amount);
    patch.amount = amountMinor;
    patch.currency = currency;
  }
  if (Object.keys(patch).length === 0) {
    return InvestmentDeposit.load(existing);
  }
  const [row] = await db
    .update(InvestmentDeposits)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(InvestmentDeposits.id, id))
    .returning();
  return InvestmentDeposit.load(row);
}

/** Delete an `InvestmentDeposit`. @gqlMutationField */
export async function investmentDepositDelete(id: ID): Promise<Void> {
  await db.delete(InvestmentDeposits).where(eq(InvestmentDeposits.id, id));
  return VOID;
}

export async function loadInvestmentDepositsForAsset(
  assetId: string,
): Promise<InvestmentDeposit[]> {
  const rows = await db
    .select()
    .from(InvestmentDeposits)
    .where(eq(InvestmentDeposits.assetId, assetId))
    .orderBy(desc(InvestmentDeposits.date), desc(InvestmentDeposits.id));
  return rows.map(InvestmentDeposit.load);
}

import { asc, eq } from "drizzle-orm";
import { GraphQLError } from "graphql";
import type { Float, ID } from "grats";

import { db } from "@/db";
import { InvestmentStockSplits } from "@/db/schema/investments";

import type { Date as CalendarDate } from "../date";
import { VOID, type Void } from "../void";

/** A stock-split event recorded against an `Investment`. `units_post = units_pre * ratio`, so ratio > 1 is a forward split and 0 < ratio < 1 is a reverse split. @gqlType */
export class InvestmentStockSplit {
  constructor(
    /** @gqlField */
    public readonly id: ID,
    /** Calendar date the split took effect. @gqlField */
    public readonly date: CalendarDate,
    /** Split ratio. `2` = 2-for-1 forward split; `0.1` = 1-for-10 reverse split. @gqlField */
    public readonly ratio: Float,
  ) {}

  static load(
    row: typeof InvestmentStockSplits.$inferSelect,
  ): InvestmentStockSplit {
    return new InvestmentStockSplit(
      row.id as ID,
      row.date,
      Number(row.ratio) as Float,
    );
  }
}

/** Record a stock split on an investment. Historic `unitPriceCached` values are retroactively adjusted. @gqlMutationField */
export async function investmentStockSplitCreate(
  investmentId: ID,
  /** Calendar date the split took effect. */
  date: CalendarDate,
  /** Positive split ratio. `2` = 2-for-1 forward split; `0.1` = 1-for-10 reverse split. */
  ratio: Float,
): Promise<InvestmentStockSplit> {
  if (ratio <= 0) {
    throw new GraphQLError(`ratio must be positive, got ${ratio}`);
  }
  const [row] = await db
    .insert(InvestmentStockSplits)
    .values({ investmentId, date, ratio: ratio.toString() })
    .returning();
  return InvestmentStockSplit.load(row);
}

/** Partial update to a stock split. Omitted / null fields are left unchanged. @gqlMutationField */
export async function investmentStockSplitUpdate(
  id: ID,
  date?: CalendarDate | null,
  ratio?: Float | null,
): Promise<InvestmentStockSplit> {
  const patch: Partial<typeof InvestmentStockSplits.$inferInsert> = {};
  if (date != null) patch.date = date;
  if (ratio != null) {
    if (ratio <= 0) {
      throw new GraphQLError(`ratio must be positive, got ${ratio}`);
    }
    patch.ratio = ratio.toString();
  }
  if (Object.keys(patch).length === 0) {
    const [row] = await db
      .select()
      .from(InvestmentStockSplits)
      .where(eq(InvestmentStockSplits.id, id));
    if (!row) throw new GraphQLError(`InvestmentStockSplit ${id} not found`);
    return InvestmentStockSplit.load(row);
  }
  const [row] = await db
    .update(InvestmentStockSplits)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(InvestmentStockSplits.id, id))
    .returning();
  if (!row) throw new GraphQLError(`InvestmentStockSplit ${id} not found`);
  return InvestmentStockSplit.load(row);
}

/** Delete a stock split. Historic `unitPriceCached` values are recomputed as though the split never happened. @gqlMutationField */
export async function investmentStockSplitDelete(id: ID): Promise<Void> {
  await db
    .delete(InvestmentStockSplits)
    .where(eq(InvestmentStockSplits.id, id));
  return VOID;
}

/** Load the splits for an investment, oldest-first. */
export async function loadInvestmentStockSplits(
  investmentId: string,
): Promise<InvestmentStockSplit[]> {
  const rows = await db
    .select()
    .from(InvestmentStockSplits)
    .where(eq(InvestmentStockSplits.investmentId, investmentId))
    .orderBy(asc(InvestmentStockSplits.date));
  return rows.map(InvestmentStockSplit.load);
}

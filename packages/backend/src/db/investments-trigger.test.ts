import { and, eq } from "drizzle-orm";

import { db } from "@/db";

import {
  InvestmentPrices,
  Investments,
  InvestmentStockSplits,
} from "./schema/investments";

async function createInvestment(): Promise<string> {
  const [row] = await db
    .insert(Investments)
    .values({ name: "Test", stockCode: "TST", currency: "GBP" })
    .returning({ id: Investments.id });
  return row.id;
}

async function insertPrice(
  investmentId: string,
  date: string,
  price: number,
): Promise<void> {
  await db.insert(InvestmentPrices).values({
    investmentId,
    date: new Date(date),
    price,
    currency: "GBP",
  });
}

async function insertSplit(
  investmentId: string,
  date: string,
  ratio: string,
): Promise<string> {
  const [row] = await db
    .insert(InvestmentStockSplits)
    .values({ investmentId, date: new Date(date), ratio })
    .returning({ id: InvestmentStockSplits.id });
  return row.id;
}

async function getAdjusted(
  investmentId: string,
  date: string,
): Promise<number> {
  const [row] = await db
    .select({ priceAdjusted: InvestmentPrices.priceAdjusted })
    .from(InvestmentPrices)
    .where(
      and(
        eq(InvestmentPrices.investmentId, investmentId),
        eq(InvestmentPrices.date, new Date(date)),
      ),
    );
  return row.priceAdjusted;
}

describe("InvestmentPrices.priceAdjusted trigger", () => {
  it("equals price when no splits exist", async () => {
    const investmentId = await createInvestment();
    await insertPrice(investmentId, "2024-01-01", 1000);
    expect(await getAdjusted(investmentId, "2024-01-01")).toBe(1000);
  });

  it("is unaffected by splits dated on or before the price", async () => {
    const investmentId = await createInvestment();
    await insertSplit(investmentId, "2024-01-01", "2");
    await insertPrice(investmentId, "2024-01-01", 500);
    await insertPrice(investmentId, "2024-06-01", 600);
    expect(await getAdjusted(investmentId, "2024-01-01")).toBe(500);
    expect(await getAdjusted(investmentId, "2024-06-01")).toBe(600);
  });

  it("multiplies by later split ratios on INSERT of the price", async () => {
    const investmentId = await createInvestment();
    await insertSplit(investmentId, "2024-06-01", "2");
    await insertPrice(investmentId, "2024-01-01", 500);
    expect(await getAdjusted(investmentId, "2024-01-01")).toBe(1000);
  });

  it("backfills existing prices when a later split is inserted", async () => {
    const investmentId = await createInvestment();
    await insertPrice(investmentId, "2024-01-01", 500);
    await insertPrice(investmentId, "2024-06-01", 600);
    await insertSplit(investmentId, "2024-03-01", "2");
    expect(await getAdjusted(investmentId, "2024-01-01")).toBe(1000);
    expect(await getAdjusted(investmentId, "2024-06-01")).toBe(600);
  });

  it("stacks multiple later splits multiplicatively", async () => {
    const investmentId = await createInvestment();
    await insertPrice(investmentId, "2024-01-01", 500);
    await insertSplit(investmentId, "2024-03-01", "2");
    await insertSplit(investmentId, "2024-09-01", "5");
    expect(await getAdjusted(investmentId, "2024-01-01")).toBe(5000);
  });

  it("handles a reverse split (ratio < 1)", async () => {
    const investmentId = await createInvestment();
    await insertPrice(investmentId, "2024-01-01", 1000);
    await insertSplit(investmentId, "2024-06-01", "0.1");
    expect(await getAdjusted(investmentId, "2024-01-01")).toBe(100);
  });

  it("reverts priceAdjusted when a split is deleted", async () => {
    const investmentId = await createInvestment();
    await insertPrice(investmentId, "2024-01-01", 500);
    const splitId = await insertSplit(investmentId, "2024-06-01", "2");
    expect(await getAdjusted(investmentId, "2024-01-01")).toBe(1000);

    await db
      .delete(InvestmentStockSplits)
      .where(eq(InvestmentStockSplits.id, splitId));
    expect(await getAdjusted(investmentId, "2024-01-01")).toBe(500);
  });

  it("recomputes priceAdjusted when a split's ratio is updated", async () => {
    const investmentId = await createInvestment();
    await insertPrice(investmentId, "2024-01-01", 500);
    const splitId = await insertSplit(investmentId, "2024-06-01", "2");
    expect(await getAdjusted(investmentId, "2024-01-01")).toBe(1000);

    await db
      .update(InvestmentStockSplits)
      .set({ ratio: "3" })
      .where(eq(InvestmentStockSplits.id, splitId));
    expect(await getAdjusted(investmentId, "2024-01-01")).toBe(1500);
  });

  it("recomputes priceAdjusted when a split's date is updated to the other side of a price", async () => {
    const investmentId = await createInvestment();
    await insertPrice(investmentId, "2024-06-01", 500);
    const splitId = await insertSplit(investmentId, "2024-03-01", "2");
    expect(await getAdjusted(investmentId, "2024-06-01")).toBe(500);

    await db
      .update(InvestmentStockSplits)
      .set({ date: new Date("2024-09-01") })
      .where(eq(InvestmentStockSplits.id, splitId));
    expect(await getAdjusted(investmentId, "2024-06-01")).toBe(1000);
  });

  it("does not touch updatedAt when a split change triggers recompute", async () => {
    const investmentId = await createInvestment();
    await insertPrice(investmentId, "2024-01-01", 500);
    const [before] = await db
      .select({ updatedAt: InvestmentPrices.updatedAt })
      .from(InvestmentPrices)
      .where(eq(InvestmentPrices.investmentId, investmentId));

    await insertSplit(investmentId, "2024-06-01", "2");
    expect(await getAdjusted(investmentId, "2024-01-01")).toBe(1000);

    const [after] = await db
      .select({ updatedAt: InvestmentPrices.updatedAt })
      .from(InvestmentPrices)
      .where(eq(InvestmentPrices.investmentId, investmentId));
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });

  it("ignores any priceAdjusted value supplied by the caller", async () => {
    const investmentId = await createInvestment();
    await db.insert(InvestmentPrices).values({
      investmentId,
      date: new Date("2024-01-01"),
      price: 500,
      priceAdjusted: 999_999,
      currency: "GBP",
    });
    expect(await getAdjusted(investmentId, "2024-01-01")).toBe(500);
  });

  it("preserves fractional adjusted prices (no rounding)", async () => {
    const investmentId = await createInvestment();
    await insertPrice(investmentId, "2024-01-01", 10);
    await insertSplit(investmentId, "2024-06-01", "0.5");
    expect(await getAdjusted(investmentId, "2024-01-01")).toBe(5);

    await insertPrice(investmentId, "2024-02-01", 1);
    await insertSplit(investmentId, "2024-07-01", "0.3");
    expect(await getAdjusted(investmentId, "2024-02-01")).toBeCloseTo(0.15, 10);
  });
});

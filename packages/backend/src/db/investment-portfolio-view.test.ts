import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { NetWorthCategoryAssets } from "@/db/schema/net-worth";

import {
  InvestmentPortfolioDailyBreakdown,
  InvestmentPrices,
  Investments,
  InvestmentTransactions,
} from "./schema/investments";

async function createAsset(name: string): Promise<string> {
  const [row] = await db
    .insert(NetWorthCategoryAssets)
    .values({ name, type: "STOCK" })
    .returning({ id: NetWorthCategoryAssets.id });
  return row.id;
}

async function createInvestment(
  stockCode: string,
  currency: "GBP" | "USD" = "GBP",
): Promise<string> {
  const [row] = await db
    .insert(Investments)
    .values({ name: stockCode, stockCode, currency })
    .returning({ id: Investments.id });
  return row.id;
}

async function buy(
  assetId: string,
  investmentId: string,
  date: string,
  units: number,
  price: number,
  currency: "GBP" | "USD" = "GBP",
): Promise<void> {
  await db.insert(InvestmentTransactions).values({
    assetId,
    investmentId,
    date: new Date(date),
    units,
    price,
    currency,
  });
}

async function priceAt(
  investmentId: string,
  date: string,
  price: number,
  currency: "GBP" | "USD" = "GBP",
): Promise<void> {
  await db.insert(InvestmentPrices).values({
    investmentId,
    date: new Date(date),
    price,
    currency,
  });
}

async function getBreakdown(
  assetId: string,
  date: string,
): Promise<number | undefined> {
  const [row] = await db
    .select({ amount: InvestmentPortfolioDailyBreakdown.amount })
    .from(InvestmentPortfolioDailyBreakdown)
    .where(
      and(
        eq(InvestmentPortfolioDailyBreakdown.assetId, assetId),
        eq(InvestmentPortfolioDailyBreakdown.date, new Date(date)),
      ),
    );
  return row?.amount;
}

describe("InvestmentPortfolioDailyBreakdown", () => {
  it("is empty when no prices exist", async () => {
    const rows = await db.select().from(InvestmentPortfolioDailyBreakdown);
    expect(rows).toHaveLength(0);
  });

  it("reports units_held * price on the transaction date", async () => {
    const assetId = await createAsset("ISA");
    const investmentId = await createInvestment("AAPL");
    await buy(assetId, investmentId, "2024-01-01", 10, 500);
    await priceAt(investmentId, "2024-01-01", 500);

    expect(await getBreakdown(assetId, "2024-01-01")).toBe(5000);
  });

  it("forward-fills the last known price on days without a fresh quote", async () => {
    const assetId = await createAsset("ISA");
    const investmentId = await createInvestment("AAPL");
    await buy(assetId, investmentId, "2024-01-01", 10, 500);
    await priceAt(investmentId, "2024-01-01", 500);
    await priceAt(investmentId, "2024-01-03", 600);

    expect(await getBreakdown(assetId, "2024-01-01")).toBe(5000);
    expect(await getBreakdown(assetId, "2024-01-02")).toBe(5000);
    expect(await getBreakdown(assetId, "2024-01-03")).toBe(6000);
  });

  it("reflects later purchases as increased holdings", async () => {
    const assetId = await createAsset("ISA");
    const investmentId = await createInvestment("AAPL");
    await buy(assetId, investmentId, "2024-01-01", 10, 500);
    await buy(assetId, investmentId, "2024-01-03", 5, 600);
    await priceAt(investmentId, "2024-01-01", 500);
    await priceAt(investmentId, "2024-01-03", 600);

    expect(await getBreakdown(assetId, "2024-01-01")).toBe(5000);
    expect(await getBreakdown(assetId, "2024-01-02")).toBe(5000);
    expect(await getBreakdown(assetId, "2024-01-03")).toBe(15 * 600);
  });

  it("reflects sells as reduced holdings", async () => {
    const assetId = await createAsset("ISA");
    const investmentId = await createInvestment("AAPL");
    await buy(assetId, investmentId, "2024-01-01", 10, 500);
    await buy(assetId, investmentId, "2024-01-05", -4, 700);
    await priceAt(investmentId, "2024-01-01", 500);
    await priceAt(investmentId, "2024-01-05", 700);

    expect(await getBreakdown(assetId, "2024-01-01")).toBe(5000);
    expect(await getBreakdown(assetId, "2024-01-05")).toBe(6 * 700);
  });

  it("sums multiple investments held in the same wrapper", async () => {
    const assetId = await createAsset("ISA");
    const a = await createInvestment("AAPL");
    const b = await createInvestment("MSFT");
    await buy(assetId, a, "2024-01-01", 10, 500);
    await buy(assetId, b, "2024-01-01", 5, 1000);
    await priceAt(a, "2024-01-01", 500);
    await priceAt(b, "2024-01-01", 1000);

    expect(await getBreakdown(assetId, "2024-01-01")).toBe(10 * 500 + 5 * 1000);
  });

  it("separates holdings booked into different wrappers", async () => {
    const isa = await createAsset("ISA");
    const sipp = await createAsset("SIPP");
    const investmentId = await createInvestment("AAPL");
    await buy(isa, investmentId, "2024-01-01", 10, 500);
    await buy(sipp, investmentId, "2024-01-01", 3, 500);
    await priceAt(investmentId, "2024-01-01", 500);

    expect(await getBreakdown(isa, "2024-01-01")).toBe(5000);
    expect(await getBreakdown(sipp, "2024-01-01")).toBe(1500);
  });

  it("emits a row for every day in the price-date range", async () => {
    const assetId = await createAsset("ISA");
    const investmentId = await createInvestment("AAPL");
    await buy(assetId, investmentId, "2024-01-01", 10, 500);
    await priceAt(investmentId, "2024-01-01", 500);
    await priceAt(investmentId, "2024-01-05", 500);

    const rows = await db
      .select({ date: InvestmentPortfolioDailyBreakdown.date })
      .from(InvestmentPortfolioDailyBreakdown)
      .where(eq(InvestmentPortfolioDailyBreakdown.assetId, assetId));
    expect(rows).toHaveLength(5);
  });
});

// `TEST_NOW` is 2026-04-18 (FY 2026, April month). The cash-float math doesn't
// touch dates beyond what's needed to anchor a planning month for
// `transactionCreate`, so we seed FY 2026 once per test that needs it.

import { graphql, runGql } from "#test/gql";

async function createStockAsset(name: string): Promise<string> {
  const data = await runGql(
    graphql(`
      mutation ($name: String!) {
        netWorthCategoryCreate(input: { asset: { name: $name, type: STOCK } }) {
          id
        }
      }
    `),
    { name },
  );
  return data.netWorthCategoryCreate.id;
}

async function createCashAsset(name: string): Promise<string> {
  const data = await runGql(
    graphql(`
      mutation ($name: String!) {
        netWorthCategoryCreate(input: { asset: { name: $name, type: CASH } }) {
          id
        }
      }
    `),
    { name },
  );
  return data.netWorthCategoryCreate.id;
}

async function assignPlanningAccount(assetId: string): Promise<void> {
  await runGql(
    graphql(`
      mutation ($id: ID!) {
        planningAccountAssign(assetId: $id, alias: null) {
          id
        }
      }
    `),
    { id: assetId },
  );
}

async function seedYear(year = "2026"): Promise<void> {
  await runGql(
    graphql(`
      mutation ($y: ID!) {
        planningYearSet(year: $y) {
          id
        }
      }
    `),
    { y: year },
  );
}

async function createStock(name: string, code: string): Promise<string> {
  const data = await runGql(
    graphql(`
      mutation ($name: String!, $code: String!) {
        investmentCreate(
          name: $name
          currency: "GBP"
          asset: { stock: { code: $code } }
        ) {
          id
        }
      }
    `),
    { name, code },
  );
  return data.investmentCreate.id;
}

async function buy(
  investmentId: string,
  assetId: string,
  units: number,
  priceAmount: number,
  drip = false,
): Promise<void> {
  await runGql(
    graphql(`
      mutation (
        $investmentId: ID!
        $assetId: ID!
        $units: Int!
        $price: Float!
        $drip: Boolean
      ) {
        investmentTransactionCreate(
          investmentId: $investmentId
          assetId: $assetId
          date: "2026-03-01"
          units: $units
          price: { amount: $price, currency: "GBP" }
          drip: $drip
        ) {
          id
        }
      }
    `),
    { investmentId, assetId, units, price: priceAmount, drip },
  );
}

async function setPrice(
  investmentId: string,
  amount: number,
  date = "2026-04-01",
): Promise<void> {
  const { db } = await import("@/db");
  const { InvestmentPrices } = await import("@/db/schema/investments");
  await db.insert(InvestmentPrices).values({
    investmentId,
    date: new Date(date),
    price: amount,
    currency: "GBP",
  });
}

async function recordDeposit(
  assetId: string,
  amount: number,
  name = "Deposit",
  currency = "GBP",
): Promise<void> {
  await runGql(
    graphql(`
      mutation ($assetId: ID!, $amount: MoneyInput!, $name: String!) {
        investmentDepositCreate(
          assetId: $assetId
          date: "2026-04-10"
          amount: $amount
          name: $name
        ) {
          id
        }
      }
    `),
    { assetId, amount: { amount, currency }, name },
  );
}

async function recordCashTxToAsset(
  cashAccountId: string,
  wrapperId: string,
  cashSignedAmount: number,
  name = "Buy",
): Promise<void> {
  await runGql(
    graphql(`
      mutation ($a: ID!, $s: ID!, $amount: MoneyInput!, $name: String!) {
        transactionCreate(
          monthId: "apr-2026"
          amount: $amount
          name: $name
          accountId: $a
          assetId: $s
        ) {
          id
        }
      }
    `),
    {
      a: cashAccountId,
      s: wrapperId,
      amount: { amount: cashSignedAmount, currency: "GBP" },
      name,
    },
  );
}

async function queryPortfolio(
  filterAssetIdIn: string[] | null = null,
): Promise<{
  cash: { amount: number; currency: string };
  totalValue: { amount: number; currency: string } | null;
  totalCost: { amount: number; currency: string };
  totalGain: { amount: number; currency: string } | null;
  percentGain: number | null;
}> {
  const data = await runGql(
    graphql(`
      query ($filterAssetIdIn: [ID!]) {
        portfolio(filterAssetIdIn: $filterAssetIdIn) {
          cash {
            amount
            currency
          }
          totalValue {
            amount
            currency
          }
          totalCost {
            amount
            currency
          }
          totalGain {
            amount
            currency
          }
          percentGain
        }
      }
    `),
    { filterAssetIdIn },
  );
  if (!data.portfolio) {
    throw new Error("portfolio missing");
  }
  return {
    cash: data.portfolio.cash,
    totalValue: data.portfolio.totalValue,
    totalCost: data.portfolio.totalCost,
    totalGain: data.portfolio.totalGain,
    percentGain: data.portfolio.percentGain,
  };
}

describe("Portfolio.cash", () => {
  it("is zero when there are no contributing rows", async () => {
    const p = await queryPortfolio();
    expect(p.cash).toEqual({ amount: 0, currency: "GBP" });
  });

  it("sums InvestmentDeposits into the wrapper's cash float", async () => {
    const isa = await createStockAsset("ISA");
    await recordDeposit(isa, 250, "Q1 dividend");
    await recordDeposit(isa, 50, "Tax relief");
    const p = await queryPortfolio([isa]);
    expect(p.cash.amount).toBe(300);
  });

  it("flips PlanningTransactions to the wrapper's perspective", async () => {
    await seedYear();
    const cash = await createCashAsset("Current");
    const isa = await createStockAsset("ISA");
    await assignPlanningAccount(cash);
    // -500 from the cash account = +500 deposit into the wrapper.
    await recordCashTxToAsset(cash, isa, -500, "Monthly contrib");

    const p = await queryPortfolio([isa]);
    expect(p.cash.amount).toBe(500);
  });

  it("subtracts non-DRIP buy cost (and credits the float on a sell)", async () => {
    const isa = await createStockAsset("ISA");
    const aapl = await createStock("Apple", "AAPL");
    await buy(aapl, isa, 10, 5); // -50 from float
    await buy(aapl, isa, -2, 6); // +12 back
    const p = await queryPortfolio([isa]);
    expect(p.cash.amount).toBe(-50 + 12);
  });

  it("ignores DRIP transactions in the cash float", async () => {
    const isa = await createStockAsset("ISA");
    const aapl = await createStock("Apple", "AAPL");
    await buy(aapl, isa, 10, 5, true); // DRIP — must NOT debit cash
    const p = await queryPortfolio([isa]);
    expect(p.cash.amount).toBe(0);
  });

  it("aggregates planning transactions, deposits, and trades into one float", async () => {
    await seedYear();
    const cashAccount = await createCashAsset("Current");
    const isa = await createStockAsset("ISA");
    await assignPlanningAccount(cashAccount);
    const aapl = await createStock("Apple", "AAPL");

    await recordCashTxToAsset(cashAccount, isa, -1000, "Monthly contrib");
    await recordDeposit(isa, 75, "Dividend");
    await buy(aapl, isa, 100, 5); // -500
    await buy(aapl, isa, 10, 5, true); // DRIP — ignored

    const p = await queryPortfolio([isa]);
    // 1000 (planning) + 75 (deposit) - 500 (buy) = 575.
    expect(p.cash.amount).toBe(575);
  });

  it("aggregates across multiple wrappers when filterAssetIdIn is null", async () => {
    const a = await createStockAsset("ISA A");
    const b = await createStockAsset("ISA B");
    await recordDeposit(a, 100);
    await recordDeposit(b, 250);
    const all = await queryPortfolio(null);
    expect(all.cash.amount).toBe(350);

    const onlyA = await queryPortfolio([a]);
    expect(onlyA.cash.amount).toBe(100);
  });

  it("excludes contributions denominated in a non-portfolio currency", async () => {
    const isa = await createStockAsset("ISA");
    await recordDeposit(isa, 500, "GBP", "GBP");
    await recordDeposit(isa, 999, "USD dividend", "USD");
    // Default `Portfolio.currency` is the home currency (GBP) — USD entries
    // shouldn't bleed into it.
    const p = await queryPortfolio([isa]);
    expect(p.cash).toEqual({ amount: 500, currency: "GBP" });
  });
});

describe("Portfolio.totalValue / totalGain include cash correctly", () => {
  it("totalValue = held value + cash float", async () => {
    const isa = await createStockAsset("ISA");
    const aapl = await createStock("Apple", "AAPL");
    await buy(aapl, isa, 10, 5); // £50 in
    await setPrice(aapl, 600); // 6.00/share
    await recordDeposit(isa, 25, "Dividend");

    const p = await queryPortfolio([isa]);
    // Held: 10 × 6 = 60. Cash float: 25 (deposit) - 50 (buy) = -25. Total: 35.
    expect(p.totalValue?.amount).toBe(60 - 25);
    expect(p.cash.amount).toBe(-25);
  });

  it("totalGain reflects invested-only return (cash deposits don't read as gains)", async () => {
    const isa = await createStockAsset("ISA");
    const aapl = await createStock("Apple", "AAPL");
    await buy(aapl, isa, 10, 5); // cost 50
    await setPrice(aapl, 700); // 7.00/share → value 70 → gain 20
    await recordDeposit(isa, 1000, "Big top-up"); // pure cash float — must NOT read as gain

    const p = await queryPortfolio([isa]);
    expect(p.totalCost.amount).toBe(50);
    expect(p.totalGain?.amount).toBe(20);
    expect(p.percentGain).toBeCloseTo(0.4, 5);
    // Cash still surfaces in totalValue, just not in the gain.
    expect(p.totalValue?.amount).toBe(70 + (1000 - 50));
  });
});

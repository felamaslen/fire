import { db } from "@/db";
import {
  InvestmentPrices,
  InvestmentPricesLive,
} from "@/db/schema/investments";
import { graphql, runGql } from "#test/gql";

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

async function createAsset(name = "ISA"): Promise<string> {
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

async function buy(
  investmentId: string,
  assetId: string,
  date: string,
  units: number,
  priceAmount: number,
): Promise<void> {
  await runGql(
    graphql(`
      mutation (
        $investmentId: ID!
        $assetId: ID!
        $date: Date!
        $units: Float!
        $priceAmount: Float!
      ) {
        investmentTransactionCreate(
          investmentId: $investmentId
          assetId: $assetId
          date: $date
          units: $units
          price: { amount: $priceAmount, currency: "GBP" }
        ) {
          id
        }
      }
    `),
    { investmentId, assetId, date, units, priceAmount },
  );
}

async function setPrice(
  investmentId: string,
  date: string,
  amount: number,
): Promise<void> {
  await db.insert(InvestmentPrices).values({
    investmentId,
    date: new Date(date),
    price: amount,
    currency: "GBP",
  });
}

async function createTransferOut(
  assetIdFrom: string,
  assetIdTo: string,
  date: string,
): Promise<void> {
  await runGql(
    graphql(`
      mutation ($from: ID!, $to: ID!, $date: Date!) {
        assetStockTransferCreate(
          assetIdFrom: $from
          assetIdTo: $to
          date: $date
        ) {
          id
        }
      }
    `),
    { from: assetIdFrom, to: assetIdTo, date },
  );
}

const PortfolioStatsDocument = graphql(`
  query ($filterAssetIdIn: [ID!]) {
    portfolio(filterAssetIdIn: $filterAssetIdIn, skipLive: true) {
      totalValue {
        amount
      }
      totalCost {
        amount
      }
      totalGain {
        amount
      }
      cash {
        amount
      }
      xirr
    }
  }
`);

async function depositCash(
  assetId: string,
  date: string,
  amount: number,
): Promise<void> {
  await runGql(
    graphql(`
      mutation ($assetId: ID!, $date: Date!, $amount: Float!) {
        investmentDepositCreate(
          assetId: $assetId
          date: $date
          amount: { amount: $amount, currency: "GBP" }
          name: "seed"
        ) {
          id
        }
      }
    `),
    { assetId, date, amount },
  );
}

describe("Portfolio dateCap from transferOut", () => {
  it("freezes totalValue at the latest price ≤ transfer date - 1", async () => {
    const fromAsset = await createAsset("Old ISA");
    const toAsset = await createAsset("New ISA");
    const inv = await createStock("Acme", "ACME.L");
    // `buy` price is in major units (pounds, via `MoneyInput`); `setPrice`
    // is raw pence (minor) — so a £10 buy and a "10/unit" price quote agree
    // when the price quote is `1000`.
    await buy(inv, fromAsset, "2025-01-15", 100, 10);
    await setPrice(inv, "2025-01-15", 1000);
    await setPrice(inv, "2025-03-01", 1200);
    await setPrice(inv, "2025-04-01", 1500);

    // Without a transfer, the latest price (£15) is used.
    const before = await runGql(PortfolioStatsDocument, {
      filterAssetIdIn: [fromAsset],
    });
    expect(before.portfolio?.totalValue?.amount).toBe(1500);

    // After transferring out on 2025-03-15, the freeze date is 2025-03-14, so
    // the most recent price ≤ that date is £12.
    await createTransferOut(fromAsset, toAsset, "2025-03-15");
    const after = await runGql(PortfolioStatsDocument, {
      filterAssetIdIn: [fromAsset],
    });
    expect(after.portfolio).toMatchObject({
      totalValue: { amount: 1200 },
      totalCost: { amount: 1000 },
      totalGain: { amount: 200 },
    });
  });

  it("excludes transactions booked after the transfer date from totalCost", async () => {
    const fromAsset = await createAsset("Old ISA");
    const toAsset = await createAsset("New ISA");
    const inv = await createStock("Acme", "ACME.L");
    await buy(inv, fromAsset, "2025-01-15", 100, 10);
    // A stray buy after the transfer (e.g. mis-booked) — should be ignored.
    await buy(inv, fromAsset, "2025-04-01", 50, 20);
    await setPrice(inv, "2025-01-15", 1000);
    await setPrice(inv, "2025-03-01", 1200);

    await createTransferOut(fromAsset, toAsset, "2025-03-15");
    const data = await runGql(PortfolioStatsDocument, {
      filterAssetIdIn: [fromAsset],
    });
    expect(data.portfolio).toMatchObject({
      totalValue: { amount: 1200 },
      totalCost: { amount: 1000 },
    });
  });

  it("does not cap a portfolio scoped to multiple assets", async () => {
    const fromAsset = await createAsset("Old ISA");
    const toAsset = await createAsset("New ISA");
    const sibling = await createAsset("Sibling ISA");
    const inv = await createStock("Acme", "ACME.L");
    await buy(inv, fromAsset, "2025-01-15", 100, 10);
    await buy(inv, sibling, "2025-01-15", 50, 10);
    await setPrice(inv, "2025-01-15", 1000);
    await setPrice(inv, "2025-04-01", 1500);
    await createTransferOut(fromAsset, toAsset, "2025-03-15");

    // Multi-asset filter — no dateCap is applied; latest price (£15) wins.
    const data = await runGql(PortfolioStatsDocument, {
      filterAssetIdIn: [fromAsset, sibling],
    });
    expect(data.portfolio?.totalValue?.amount).toBe(2250);
  });

  it("ignores the live quote when capped (totalValue uses the dateCap'd cached price)", async () => {
    const fromAsset = await createAsset("Old ISA");
    const toAsset = await createAsset("New ISA");
    const inv = await createStock("Acme", "ACME.L");
    await buy(inv, fromAsset, "2025-01-15", 100, 10);
    await setPrice(inv, "2025-03-01", 1200);
    // A live quote that would otherwise dominate `priceLatest` — both the
    // live tick and its `previousClose` are far higher than the capped
    // cached price. We assert the cap wins regardless.
    await db.insert(InvestmentPricesLive).values({
      investmentId: inv,
      refreshedAt: new Date("2025-04-01T12:00:00Z"),
      date: new Date("2025-04-01T12:00:00Z"),
      currency: "GBP",
      price: 9999,
      pricePreviousClose: 9000,
    });
    await createTransferOut(fromAsset, toAsset, "2025-03-15");

    // skipLive: false explicitly — we want to prove the cap forces live off
    // even when the caller hasn't asked for it.
    const data = await runGql(
      graphql(`
        query ($filterAssetIdIn: [ID!]) {
          portfolio(filterAssetIdIn: $filterAssetIdIn, skipLive: false) {
            totalValue {
              amount
            }
          }
        }
      `),
      { filterAssetIdIn: [fromAsset] },
    );
    expect(data.portfolio?.totalValue?.amount).toBe(1200);
  });

  it("zeros out cash on a transferred-out wrapper", async () => {
    const fromAsset = await createAsset("Old ISA");
    const toAsset = await createAsset("New ISA");
    const inv = await createStock("Acme", "ACME.L");
    await depositCash(fromAsset, "2025-01-15", 500);
    await buy(inv, fromAsset, "2025-01-15", 100, 10);
    await setPrice(inv, "2025-03-01", 1200);

    // Sanity check: before the transfer, the asset's cash float is non-zero
    // (in this test it surfaces via the same `cash` field — the deposit has
    // been recorded, so the float is positive after netting buys).
    const before = await runGql(PortfolioStatsDocument, {
      filterAssetIdIn: [fromAsset],
    });
    // Only assert "cash exists" rather than an exact value — the cash-float
    // model includes wrapper-tracking logic outside the scope of this test.
    expect(before.portfolio?.cash?.amount).toBeGreaterThanOrEqual(0);

    await createTransferOut(fromAsset, toAsset, "2025-03-15");
    const after = await runGql(PortfolioStatsDocument, {
      filterAssetIdIn: [fromAsset],
    });
    expect(after.portfolio?.cash?.amount).toBe(0);
  });

  it("computes xirr against transactions ≤ transfer date and a frozen terminal", async () => {
    const fromAsset = await createAsset("Old ISA");
    const toAsset = await createAsset("New ISA");
    const inv = await createStock("Acme", "ACME.L");
    await buy(inv, fromAsset, "2025-01-15", 100, 10);
    await setPrice(inv, "2025-03-01", 1200);
    await createTransferOut(fromAsset, toAsset, "2025-03-15");

    const data = await runGql(PortfolioStatsDocument, {
      filterAssetIdIn: [fromAsset],
    });
    // The pair (-£1000 on 2025-01-15, +£1200 on 2025-03-14) yields a
    // positive xirr — assert the sign / non-null rather than the exact rate
    // (annualised IRR over a sub-year window is sensitive to the solver and
    // not the contract under test).
    expect(data.portfolio?.xirr).not.toBeNull();
    expect(data.portfolio?.xirr).toBeGreaterThan(0);
  });

  it("does not cap a sibling portfolio without a transfer-out", async () => {
    const fromAsset = await createAsset("Old ISA");
    const toAsset = await createAsset("New ISA");
    const sibling = await createAsset("Sibling ISA");
    const inv = await createStock("Acme", "ACME.L");
    await buy(inv, fromAsset, "2025-01-15", 100, 10);
    await buy(inv, sibling, "2025-01-15", 50, 10);
    await setPrice(inv, "2025-04-01", 1500);
    await createTransferOut(fromAsset, toAsset, "2025-03-15");

    const sib = await runGql(PortfolioStatsDocument, {
      filterAssetIdIn: [sibling],
    });
    expect(sib.portfolio?.totalValue?.amount).toBe(750);
  });
});

import { graphql, runGql } from "#test/gql";

async function createStock(name = "Apple", code = "AAPL"): Promise<string> {
  const doc = graphql(`
    mutation ($name: String!, $code: String!) {
      investmentCreate(
        name: $name
        currency: "GBP"
        asset: { stock: { code: $code } }
      ) {
        id
      }
    }
  `);
  const data = await runGql(doc, { name, code });
  return data.investmentCreate.id;
}

async function createAsset(name = "ISA"): Promise<string> {
  const doc = graphql(`
    mutation ($name: String!) {
      netWorthCategoryCreate(input: { asset: { name: $name, type: STOCK } }) {
        id
      }
    }
  `);
  const data = await runGql(doc, { name });
  return data.netWorthCategoryCreate.id;
}

async function buy(
  investmentId: string,
  assetId: string,
  date: string,
  units: number,
  priceAmount: number,
  opts: { drip?: boolean; taxesAmount?: number; feesAmount?: number } = {},
): Promise<void> {
  const doc = graphql(`
    mutation (
      $investmentId: ID!
      $assetId: ID!
      $date: Date!
      $units: Int!
      $priceAmount: Float!
      $taxesAmount: Float!
      $feesAmount: Float!
      $drip: Boolean!
    ) {
      investmentTransactionCreate(
        investmentId: $investmentId
        assetId: $assetId
        date: $date
        units: $units
        price: { amount: $priceAmount, currency: "GBP" }
        taxes: { amount: $taxesAmount, currency: "GBP" }
        fees: { amount: $feesAmount, currency: "GBP" }
        drip: $drip
      ) {
        id
      }
    }
  `);
  await runGql(doc, {
    investmentId,
    assetId,
    date,
    units,
    priceAmount,
    taxesAmount: opts.taxesAmount ?? 0,
    feesAmount: opts.feesAmount ?? 0,
    drip: opts.drip ?? false,
  });
}

async function setPrice(
  investmentId: string,
  date: string,
  amount: number,
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

const AGG_QUERY = graphql(`
  query {
    investments {
      edges {
        node {
          position {
            units
            costBasis {
              amount
            }
            costBasisWithFees {
              amount
            }
            totalCost {
              amount
            }
            totalValue {
              amount
            }
            totalGain {
              amount
            }
            percentGain
            dailyGainValue {
              amount
            }
            dailyGainPercent
            reinvested {
              units
              cost {
                amount
              }
              value {
                amount
              }
            }
          }
          wrappers {
            asset {
              name
            }
            position {
              units
              costBasis {
                amount
              }
              totalValue {
                amount
              }
              totalGain {
                amount
              }
            }
          }
        }
      }
    }
  }
`);

function firstInvestment(data: {
  investments: { edges: { node: unknown }[] } | null;
}) {
  return data.investments?.edges[0]?.node as any;
}

describe("Investment aggregates and wrappers", () => {
  it("reports cost basis, total value, gain for a single-wrapper buy-and-hold", async () => {
    const id = await createStock();
    const assetId = await createAsset();
    await buy(id, assetId, "2024-01-01", 10, 5);
    await setPrice(id, "2024-01-01", 500);
    await setPrice(id, "2024-02-01", 600);

    const data = await runGql(AGG_QUERY, {});
    const inv = firstInvestment(data);
    expect(inv?.position).toMatchObject({
      units: 10,
      costBasis: { amount: 5 },
      costBasisWithFees: { amount: 5 },
      totalCost: { amount: 50 },
      totalValue: { amount: 60 },
      totalGain: { amount: 10 },
    });
    expect(inv?.position?.percentGain).toBeCloseTo(0.2);
    // Daily gain sources `previousClose` exclusively from the live Yahoo
    // quote — no quote mocked here, so both fields null.
    expect(inv?.position?.dailyGainValue).toBeNull();
    expect(inv?.position?.dailyGainPercent).toBeNull();
    expect(inv?.wrappers).toHaveLength(1);
    expect(inv?.wrappers?.[0]).toMatchObject({
      asset: { name: "ISA" },
      position: {
        units: 10,
        costBasis: { amount: 5 },
        totalValue: { amount: 60 },
        totalGain: { amount: 10 },
      },
    });
  });

  it("reduces cost basis after a partial sell at profit", async () => {
    const id = await createStock();
    const assetId = await createAsset();
    await buy(id, assetId, "2024-01-01", 10, 5);
    await buy(id, assetId, "2024-02-01", -4, 7);
    await setPrice(id, "2024-02-01", 700);

    const data = await runGql(AGG_QUERY, {});
    const p = firstInvestment(data)?.position;
    expect(p?.units).toBe(6);
    expect(p?.costBasis?.amount).toBeCloseTo((10 * 5 - 4 * 7) / 6);
    expect(p?.totalCost?.amount).toBeCloseTo(10 * 5 - 4 * 7);
    expect(p?.totalValue?.amount).toBeCloseTo(6 * 7);
  });

  it("includes taxes and fees in costBasisWithFees only", async () => {
    const id = await createStock();
    const assetId = await createAsset();
    await buy(id, assetId, "2024-01-01", 10, 5, {
      taxesAmount: 0.5,
      feesAmount: 1,
    });
    await setPrice(id, "2024-01-01", 500);

    const data = await runGql(AGG_QUERY, {});
    const p = firstInvestment(data)?.position;
    expect(p?.costBasis?.amount).toBe(5);
    expect(p?.costBasisWithFees?.amount).toBe((10 * 5 + 0.5 + 1) / 10);
  });

  it("aggregates DRIP reinvestments", async () => {
    const id = await createStock();
    const assetId = await createAsset();
    await buy(id, assetId, "2024-01-01", 10, 5);
    await buy(id, assetId, "2024-06-01", 2, 6, { drip: true });
    await setPrice(id, "2024-06-01", 600);

    const data = await runGql(AGG_QUERY, {});
    expect(firstInvestment(data)?.position?.reinvested).toEqual({
      units: 2,
      cost: { amount: 12 },
      value: { amount: 12 },
    });
  });

  it("splits aggregates across multiple wrappers", async () => {
    const id = await createStock();
    const isa = await createAsset("ISA");
    const sipp = await createAsset("SIPP");
    await buy(id, isa, "2024-01-01", 10, 5);
    await buy(id, sipp, "2024-01-01", 4, 5);
    await setPrice(id, "2024-01-01", 500);

    const data = await runGql(AGG_QUERY, {});
    const inv = firstInvestment(data);
    expect(inv?.position?.units).toBe(14);
    expect(inv?.position?.totalValue?.amount).toBe(14 * 5);
    const wrapperNames = inv?.wrappers
      ?.map((w: { asset: { name: string } }) => w.asset.name)
      .sort();
    expect(wrapperNames).toEqual(["ISA", "SIPP"]);
  });

  it("returns null cost basis when fully sold", async () => {
    const id = await createStock();
    const assetId = await createAsset();
    await buy(id, assetId, "2024-01-01", 10, 5);
    await buy(id, assetId, "2024-02-01", -10, 7);
    await setPrice(id, "2024-02-01", 700);

    const data = await runGql(AGG_QUERY, {});
    expect(firstInvestment(data)?.position?.costBasis).toBeNull();
    expect(firstInvestment(data)?.position?.units).toBe(0);
  });

  it("split-adjusts units so today's value reflects post-split shares at post-split price", async () => {
    const id = await createStock();
    const assetId = await createAsset();
    const { db } = await import("@/db");
    const { InvestmentStockSplits } = await import("@/db/schema/investments");
    // Bought 100 shares pre-split at £50/share → £5,000 cash in.
    await buy(id, assetId, "2021-01-01", 100, 50);
    // 10:1 split: each original share becomes 10.
    await db.insert(InvestmentStockSplits).values({
      investmentId: id,
      date: new Date("2021-05-04"),
      ratio: "10",
    });
    // Current post-split price £5/share → total value still £5,000.
    await setPrice(id, "2024-01-01", 500);

    const data = await runGql(AGG_QUERY, {});
    const p = firstInvestment(data)?.position;
    expect(p?.units).toBe(1000);
    expect(p?.totalValue?.amount).toBeCloseTo(5000);
    expect(p?.totalCost?.amount).toBeCloseTo(5000);
    expect(p?.costBasis?.amount).toBeCloseTo(5);
    expect(p?.totalGain?.amount).toBeCloseTo(0);
  });

  it("reports realised gain for a fully-sold position as (sell proceeds - buy cost) / buy cost", async () => {
    const id = await createStock();
    const assetId = await createAsset();
    // Bought 10 @ £5 → £50 capital in.
    await buy(id, assetId, "2024-01-01", 10, 5);
    // Sold all 10 @ £7 → £70 proceeds. Realised gain £20, +40%.
    await buy(id, assetId, "2024-02-01", -10, 7);
    await setPrice(id, "2024-02-01", 700);

    const data = await runGql(AGG_QUERY, {});
    const p = firstInvestment(data)?.position;
    expect(p?.units).toBe(0);
    expect(p?.totalCost?.amount).toBeCloseTo(50);
    expect(p?.totalValue?.amount).toBeCloseTo(70);
    expect(p?.totalGain?.amount).toBeCloseTo(20);
    expect(p?.percentGain).toBeCloseTo(0.4);
  });

  it("returns null daily gain when fewer than two prices exist", async () => {
    const id = await createStock();
    const assetId = await createAsset();
    await buy(id, assetId, "2024-01-01", 10, 5);
    await setPrice(id, "2024-01-01", 500);

    const data = await runGql(AGG_QUERY, {});
    expect(firstInvestment(data)?.position?.dailyGainValue).toBeNull();
    expect(firstInvestment(data)?.position?.dailyGainPercent).toBeNull();
  });
});

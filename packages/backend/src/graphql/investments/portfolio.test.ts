import { graphql, runGql } from "#test/gql";

async function createStock(
  name: string,
  code: string,
  currency = "GBP",
): Promise<string> {
  const doc = graphql(`
    mutation ($name: String!, $code: String!, $currency: String!) {
      investmentCreate(
        name: $name
        currency: $currency
        asset: { stock: { code: $code } }
      ) {
        id
      }
    }
  `);
  const data = await runGql(doc, { name, code, currency });
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
  currency = "GBP",
): Promise<void> {
  const doc = graphql(`
    mutation (
      $investmentId: ID!
      $assetId: ID!
      $date: Date!
      $units: Int!
      $priceAmount: Float!
      $currency: String!
    ) {
      investmentTransactionCreate(
        investmentId: $investmentId
        assetId: $assetId
        date: $date
        units: $units
        price: { amount: $priceAmount, currency: $currency }
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
    currency,
  });
}

async function setPrice(
  investmentId: string,
  date: string,
  amount: number,
  currency: "GBP" | "USD" = "GBP",
): Promise<void> {
  const { db } = await import("@/db");
  const { InvestmentPrices } = await import("@/db/schema/investments");
  await db.insert(InvestmentPrices).values({
    investmentId,
    date: new Date(date),
    price: amount,
    currency,
  });
}

describe("Query.portfolio aggregates", () => {
  it("returns zero when no transactions exist", async () => {
    const doc = graphql(`
      query {
        portfolio {
          currency
          totalValue {
            amount
          }
          totalCost {
            amount
          }
          totalGain {
            amount
          }
          percentGain
        }
      }
    `);
    const data = await runGql(doc, {});
    expect(data.portfolio).toMatchObject({
      currency: "GBP",
      totalCost: { amount: 0 },
    });
  });

  it("aggregates totalValue and gain across investments", async () => {
    const asset = await createAsset();
    const a = await createStock("A", "AAA");
    const b = await createStock("B", "BBB");
    await buy(a, asset, "2024-01-01", 10, 5);
    await buy(b, asset, "2024-01-01", 5, 10);
    await setPrice(a, "2024-01-01", 600);
    await setPrice(b, "2024-01-01", 1200);

    const doc = graphql(`
      query {
        portfolio {
          totalValue {
            amount
          }
          totalCost {
            amount
          }
          totalGain {
            amount
          }
          percentGain
        }
      }
    `);
    const data = await runGql(doc, {});
    expect(data.portfolio?.totalValue?.amount).toBe(10 * 6 + 5 * 12);
    expect(data.portfolio?.totalCost?.amount).toBe(10 * 5 + 5 * 10);
    expect(data.portfolio?.totalGain?.amount).toBe(20);
    expect(data.portfolio?.percentGain).toBeCloseTo(20 / 100);
  });

  it("filters by assetId", async () => {
    const isa = await createAsset("ISA");
    const sipp = await createAsset("SIPP");
    const a = await createStock("A", "AAA");
    await buy(a, isa, "2024-01-01", 10, 5);
    await buy(a, sipp, "2024-01-01", 3, 5);
    await setPrice(a, "2024-01-01", 600);

    const doc = graphql(`
      query ($assetIds: [ID!]) {
        portfolio(filterAssetIdIn: $assetIds) {
          totalValue {
            amount
          }
        }
      }
    `);
    const onlyISA = await runGql(doc, { assetIds: [isa] });
    expect(onlyISA.portfolio?.totalValue?.amount).toBe(10 * 6);
    const onlySIPP = await runGql(doc, { assetIds: [sipp] });
    expect(onlySIPP.portfolio?.totalValue?.amount).toBe(3 * 6);
  });
});

describe("Query.portfolio.timeseries and candlestick", () => {
  it("returns a daily timeseries in major units", async () => {
    const asset = await createAsset();
    const a = await createStock("A", "AAA");
    await buy(a, asset, "2024-01-01", 10, 5);
    await setPrice(a, "2024-01-01", 500);
    await setPrice(a, "2024-01-02", 550);
    await setPrice(a, "2024-01-03", 600);

    const doc = graphql(`
      query {
        portfolio {
          timeseries(period: YEAR, length: 5) {
            currency
            initialDate
            points {
              x
              y
            }
          }
        }
      }
    `);
    const data = await runGql(doc, {});
    const series = data.portfolio?.timeseries;
    expect(series?.currency).toBe("GBP");
    const points = series?.points ?? [];
    expect(points).toHaveLength(3);
    expect(points[0]).toEqual({ x: 0, y: 50 });
    expect(points[1]).toEqual({ x: 1, y: 55 });
    expect(points[2]).toEqual({ x: 2, y: 60 });
  });

  it("returns OHLC candlestick over the same period", async () => {
    const asset = await createAsset();
    const a = await createStock("A", "AAA");
    await buy(a, asset, "2024-01-01", 10, 5);
    await setPrice(a, "2024-01-01", 500);
    await setPrice(a, "2024-01-02", 550);
    await setPrice(a, "2024-01-03", 600);

    const doc = graphql(`
      query {
        portfolio {
          candlestick(period: YEAR, length: 5) {
            points {
              x
              from
              to
              lo
              hi
            }
          }
        }
      }
    `);
    const data = await runGql(doc, {});
    const points = data.portfolio?.candlestick?.points ?? [];
    expect(points.length).toBe(3);
    expect(points[0]).toMatchObject({ x: 0, from: 50, to: 50 });
    expect(points[2]).toMatchObject({ x: 2, from: 60, to: 60 });
  });
});

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

  it("counts net capital-at-stake in totalCost; held investments use held value only", async () => {
    const asset = await createAsset();
    const a = await createStock("A", "AAA");
    // Bought 10 @ £5 = £50 in. Sold 4 @ £7 = £28 out. Still holds 6.
    await buy(a, asset, "2024-01-01", 10, 5);
    await buy(a, asset, "2024-02-01", -4, 7);
    await setPrice(a, "2024-03-01", 800); // £8 per share today.

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
        }
      }
    `);
    const data = await runGql(doc, {});
    // Held value: 6 × £8 = £48. totalCost: net in (50 − 28) = £22.
    expect(data.portfolio?.totalValue?.amount).toBeCloseTo(48);
    expect(data.portfolio?.totalCost?.amount).toBeCloseTo(22);
    expect(data.portfolio?.totalGain?.amount).toBeCloseTo(26);
  });

  it("keeps totalValue = held-only for a fully-sold investment; realised gain surfaces via totalCost going negative", async () => {
    const asset = await createAsset();
    const a = await createStock("A", "AAA");
    // Bought 10 @ £5 = £50 in; sold all 10 @ £7 = £70 out. No held units.
    await buy(a, asset, "2024-01-01", 10, 5);
    await buy(a, asset, "2024-02-01", -10, 7);

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
        }
      }
    `);
    const data = await runGql(doc, {});
    expect(data.portfolio?.totalValue?.amount).toBe(0);
    // Net in: 50 − 70 = −20. totalValue − totalCost = 0 − (−20) = +20 realised.
    expect(data.portfolio?.totalCost?.amount).toBeCloseTo(-20);
    expect(data.portfolio?.totalGain?.amount).toBeCloseTo(20);
  });

  it("split-adjusts held units when computing totalValue", async () => {
    const asset = await createAsset();
    const a = await createStock("A", "AAA");
    // Bought 100 @ £50 = £5,000 before a 10:1 split.
    await buy(a, asset, "2021-01-01", 100, 50);
    const { db } = await import("@/db");
    const { InvestmentStockSplits } = await import("@/db/schema/investments");
    await db.insert(InvestmentStockSplits).values({
      investmentId: a,
      date: new Date("2021-05-04"),
      ratio: "10",
    });
    // Post-split price £5/share → effective holding 1,000 shares worth £5,000.
    await setPrice(a, "2024-01-01", 500);

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
        }
      }
    `);
    const data = await runGql(doc, {});
    expect(data.portfolio?.totalValue?.amount).toBeCloseTo(5000);
    expect(data.portfolio?.totalCost?.amount).toBeCloseTo(5000);
    expect(data.portfolio?.totalGain?.amount).toBeCloseTo(0);
  });

  it("reports xirr for a portfolio that doubled over one year", async () => {
    const asset = await createAsset();
    const a = await createStock("A", "AAA");
    // One year before `TEST_NOW` (2026-04-18). Buy 100 @ £1 = £100 deployed.
    await buy(a, asset, "2025-04-18", 100, 1);
    // Today's held price £2/share → held value £200.
    await setPrice(a, "2026-04-18", 200);

    const doc = graphql(`
      query {
        portfolio {
          xirr
        }
      }
    `);
    const data = await runGql(doc, {});
    expect(data.portfolio?.xirr).toBeCloseTo(1.0, 2);
  });

  it("reports xirr ≈ 0 for a round-trip at the same price", async () => {
    const asset = await createAsset();
    const a = await createStock("A", "AAA");
    await buy(a, asset, "2024-01-01", 100, 5);
    await buy(a, asset, "2025-01-01", -100, 5);

    const doc = graphql(`
      query {
        portfolio {
          xirr
        }
      }
    `);
    const data = await runGql(doc, {});
    expect(data.portfolio?.xirr ?? 0).toBeCloseTo(0, 3);
  });

  it("returns null xirr when there are no transactions", async () => {
    const doc = graphql(`
      query {
        portfolio {
          xirr
        }
      }
    `);
    const data = await runGql(doc, {});
    expect(data.portfolio?.xirr).toBeNull();
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

describe("Query.portfolios", () => {
  it("returns one edge per investment in the matching wrappers", async () => {
    const asset = await createAsset();
    const a = await createStock("A", "AAA");
    const b = await createStock("B", "BBB");
    await buy(a, asset, "2024-01-01", 10, 5);
    await buy(b, asset, "2024-01-01", 5, 10);
    await setPrice(a, "2024-01-01", 600);
    await setPrice(b, "2024-01-01", 1200);

    const doc = graphql(`
      query {
        portfolios {
          edges {
            node {
              investment {
                name
              }
              totalValue {
                amount
              }
            }
          }
        }
      }
    `);
    const data = await runGql(doc, {});
    const byName = new Map(
      (data.portfolios?.edges ?? []).map((e) => [
        e.node.investment?.name,
        e.node.totalValue?.amount,
      ]),
    );
    expect(byName.get("A")).toBe(10 * 6);
    expect(byName.get("B")).toBe(5 * 12);
  });

  it("restricts to investments held in the supplied wrappers", async () => {
    const isa = await createAsset("ISA");
    const sipp = await createAsset("SIPP");
    const a = await createStock("A", "AAA");
    const b = await createStock("B", "BBB");
    await buy(a, isa, "2024-01-01", 10, 5);
    await buy(b, sipp, "2024-01-01", 5, 10);
    await setPrice(a, "2024-01-01", 600);
    await setPrice(b, "2024-01-01", 1200);

    const doc = graphql(`
      query ($assets: [ID!]) {
        portfolios(filterAssetIdIn: $assets) {
          edges {
            node {
              investment {
                name
              }
            }
          }
        }
      }
    `);
    const data = await runGql(doc, { assets: [isa] });
    expect(data.portfolios?.edges.map((e) => e.node.investment?.name)).toEqual([
      "A",
    ]);
  });

  it("excludes investments that don't match the portfolio currency", async () => {
    const asset = await createAsset();
    const gbp = await createStock("GBP-stock", "GBS", "GBP");
    await buy(gbp, asset, "2024-01-01", 10, 5, "GBP");
    await setPrice(gbp, "2024-01-01", 500);

    const doc = graphql(`
      query {
        portfolios(currency: "USD") {
          edges {
            node {
              investment {
                name
              }
            }
          }
        }
      }
    `);
    const data = await runGql(doc, {});
    expect(data.portfolios?.edges).toEqual([]);
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
    // Series now extends from the first cached price to today (frozen at
    // TEST_NOW = 2026-04-18) with forward-filled values after the last
    // recorded price, and downsampled to MAX_LINE_POINTS.
    expect(points[0]).toEqual({ x: 0, y: 50 });
    // Last cached price was £6/share on day 2, forward-filled afterwards.
    expect(points[points.length - 1]).toMatchObject({ y: 60 });
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
          candlestick(unit: WEEK, length: 5) {
            points {
              x0
              x1
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
    expect(points[0]).toMatchObject({ x0: 0, x1: 35, from: 50 });
    // Series forward-fills at £60 once the last cached price is consumed.
    expect(points[points.length - 1]).toMatchObject({ to: 60, hi: 60 });
  });
});

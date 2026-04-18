import { graphql, runGql } from "#test/gql";

async function createStock(currency = "GBP"): Promise<string> {
  const doc = graphql(`
    mutation ($currency: String!) {
      investmentCreate(
        name: "Apple"
        currency: $currency
        asset: { stock: { code: "AAPL" } }
      ) {
        id
      }
    }
  `);
  const data = await runGql(doc, { currency });
  return data.investmentCreate.id;
}

async function createAsset(
  type: "CASH" | "STOCK" | "OPTION" | "PENSION" | "PROPERTY" | "MISC" = "STOCK",
): Promise<string> {
  const doc = graphql(`
    mutation ($type: NetWorthAssetType!) {
      netWorthCategoryCreate(input: { asset: { name: "ISA", type: $type } }) {
        id
      }
    }
  `);
  const data = await runGql(doc, { type });
  return data.netWorthCategoryCreate.id;
}

async function createTransaction(
  investmentId: string,
  assetId: string,
  overrides: Partial<{
    units: number;
    priceAmount: number;
    drip: boolean;
  }> = {},
): Promise<string> {
  const doc = graphql(`
    mutation (
      $investmentId: ID!
      $assetId: ID!
      $units: Int!
      $priceAmount: Float!
      $drip: Boolean
    ) {
      investmentTransactionCreate(
        investmentId: $investmentId
        assetId: $assetId
        date: "2024-03-01"
        units: $units
        price: { amount: $priceAmount, currency: "GBP" }
        drip: $drip
      ) {
        id
      }
    }
  `);
  const data = await runGql(doc, {
    investmentId,
    assetId,
    units: overrides.units ?? 10,
    priceAmount: overrides.priceAmount ?? 5,
    drip: overrides.drip ?? null,
  });
  return data.investmentTransactionCreate.id;
}

describe("investmentTransactionCreate", () => {
  it("books a trade with full payload", async () => {
    const investmentId = await createStock();
    const assetId = await createAsset("STOCK");
    const doc = graphql(`
      mutation ($investmentId: ID!, $assetId: ID!) {
        investmentTransactionCreate(
          investmentId: $investmentId
          assetId: $assetId
          date: "2024-03-01"
          units: 10
          price: { amount: 5.1234, currency: "GBP" }
          taxes: { amount: 1, currency: "GBP" }
          fees: { amount: 0.5, currency: "GBP" }
          drip: false
        ) {
          units
          drip
          date
          price {
            amount
            currency
          }
          taxes {
            amount
            currency
          }
          fees {
            amount
            currency
          }
          asset {
            id
            type
          }
        }
      }
    `);
    const data = await runGql(doc, { investmentId, assetId });
    expect(data.investmentTransactionCreate).toMatchObject({
      units: 10,
      drip: false,
      date: "2024-03-01",
      price: { amount: 5.1234, currency: "GBP" },
      taxes: { amount: 1, currency: "GBP" },
      fees: { amount: 0.5, currency: "GBP" },
      asset: { id: assetId, type: "STOCK" },
    });
  });

  it("defaults taxes, fees, and drip", async () => {
    const investmentId = await createStock();
    const assetId = await createAsset("STOCK");
    const id = await createTransaction(investmentId, assetId);
    const doc = graphql(`
      query {
        investments {
          edges {
            node {
              transactions {
                id
                taxes {
                  amount
                }
                fees {
                  amount
                }
                drip
              }
            }
          }
        }
      }
    `);
    const data = await runGql(doc, {});
    const tx = data.investments?.edges[0]?.node.transactions?.find(
      (t) => t.id === id,
    );
    expect(tx).toMatchObject({
      taxes: { amount: 0 },
      fees: { amount: 0 },
      drip: false,
    });
  });

  it("rejects booking into a non-STOCK / non-PENSION wrapper", async () => {
    const investmentId = await createStock();
    const assetId = await createAsset("CASH");
    const doc = graphql(`
      mutation ($investmentId: ID!, $assetId: ID!) {
        investmentTransactionCreate(
          investmentId: $investmentId
          assetId: $assetId
          date: "2024-03-01"
          units: 10
          price: { amount: 5, currency: "GBP" }
        ) {
          id
        }
      }
    `);
    await expect(
      runGql(doc, { investmentId, assetId }),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Error: GraphQL errors: Asset ${assetId} must be STOCK or PENSION, got CASH]`,
    );
  });

  it("rejects a price currency that doesn't match the investment", async () => {
    const investmentId = await createStock("GBP");
    const assetId = await createAsset("STOCK");
    const doc = graphql(`
      mutation ($investmentId: ID!, $assetId: ID!) {
        investmentTransactionCreate(
          investmentId: $investmentId
          assetId: $assetId
          date: "2024-03-01"
          units: 10
          price: { amount: 5, currency: "USD" }
        ) {
          id
        }
      }
    `);
    await expect(
      runGql(doc, { investmentId, assetId }),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Error: GraphQL errors: Transaction currency USD does not match Investment currency GBP]`,
    );
  });
});

describe("investmentTransactionUpdate / Delete", () => {
  it("updates units and price; leaves other fields unchanged", async () => {
    const investmentId = await createStock();
    const assetId = await createAsset("STOCK");
    const id = await createTransaction(investmentId, assetId, {
      units: 10,
      priceAmount: 5,
    });
    const doc = graphql(`
      mutation ($id: ID!) {
        investmentTransactionUpdate(
          id: $id
          units: 12
          price: { amount: 6.25, currency: "GBP" }
        ) {
          units
          price {
            amount
          }
          date
        }
      }
    `);
    const data = await runGql(doc, { id });
    expect(data.investmentTransactionUpdate).toMatchObject({
      units: 12,
      price: { amount: 6.25 },
      date: "2024-03-01",
    });
  });

  it("deletes a transaction", async () => {
    const investmentId = await createStock();
    const assetId = await createAsset("STOCK");
    const id = await createTransaction(investmentId, assetId);
    const del = graphql(`
      mutation ($id: ID!) {
        investmentTransactionDelete(id: $id) {
          _
        }
      }
    `);
    await runGql(del, { id });
    const list = graphql(`
      query {
        investments {
          edges {
            node {
              transactions {
                id
              }
            }
          }
        }
      }
    `);
    const data = await runGql(list, {});
    expect(data.investments?.edges[0]?.node.transactions ?? []).toEqual([]);
  });
});

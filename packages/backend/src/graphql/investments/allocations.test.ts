import { graphql, runGql } from "#test/gql";

async function createInvestment(name: string, code: string): Promise<string> {
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

async function createAsset(): Promise<string> {
  const doc = graphql(`
    mutation {
      netWorthCategoryCreate(input: { asset: { name: "ISA", type: STOCK } }) {
        id
      }
    }
  `);
  const data = await runGql(doc, {});
  return data.netWorthCategoryCreate.id;
}

async function buy(
  investmentId: string,
  assetId: string,
  units: number,
): Promise<void> {
  const doc = graphql(`
    mutation ($investmentId: ID!, $assetId: ID!, $units: Int!) {
      investmentTransactionCreate(
        investmentId: $investmentId
        assetId: $assetId
        date: "2024-01-01"
        units: $units
        price: { amount: 1, currency: "GBP" }
      ) {
        id
      }
    }
  `);
  await runGql(doc, { investmentId, assetId, units });
}

describe("investmentAllocationsSet", () => {
  it("stores allocations for a wrapper", async () => {
    const assetId = await createAsset();
    const a = await createInvestment("A", "AAA");
    const b = await createInvestment("B", "BBB");
    await buy(a, assetId, 10);
    await buy(b, assetId, 5);

    const doc = graphql(`
      mutation ($assetId: ID!, $a: ID!, $b: ID!) {
        investmentAllocationsSet(
          assetId: $assetId
          allocations: [
            { investmentId: $a, allocation: 0.6 }
            { investmentId: $b, allocation: 0.4 }
          ]
        ) {
          investments {
            allocation
            investment {
              name
            }
          }
          cash {
            amount
          }
        }
      }
    `);
    const data = await runGql(doc, { assetId, a, b });
    expect(
      data.investmentAllocationsSet.investments.map((i) => ({
        name: i.investment.name,
        allocation: i.allocation,
      })),
    ).toEqual(
      expect.arrayContaining([
        { name: "A", allocation: 0.6 },
        { name: "B", allocation: 0.4 },
      ]),
    );
    expect(data.investmentAllocationsSet.cash).toBeNull();
  });

  it("rejects allocations that don't sum to 1", async () => {
    const assetId = await createAsset();
    const a = await createInvestment("A", "AAA");
    await buy(a, assetId, 10);
    const doc = graphql(`
      mutation ($assetId: ID!, $a: ID!) {
        investmentAllocationsSet(
          assetId: $assetId
          allocations: [{ investmentId: $a, allocation: 0.9 }]
        ) {
          investments {
            allocation
          }
        }
      }
    `);
    await expect(
      runGql(doc, { assetId, a }),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Error: GraphQL errors: Allocations must sum to 1, got 0.900000]`,
    );
  });

  it("rejects an allocation for an investment with no holdings", async () => {
    const assetId = await createAsset();
    const a = await createInvestment("A", "AAA");
    const b = await createInvestment("B", "BBB");
    await buy(a, assetId, 10);
    const doc = graphql(`
      mutation ($assetId: ID!, $a: ID!, $b: ID!) {
        investmentAllocationsSet(
          assetId: $assetId
          allocations: [
            { investmentId: $a, allocation: 0.5 }
            { investmentId: $b, allocation: 0.5 }
          ]
        ) {
          investments {
            allocation
          }
        }
      }
    `);
    await expect(runGql(doc, { assetId, a, b })).rejects.toThrowError(
      /no holdings/,
    );
  });

  it("rejects when a held investment is missing from the allocation list", async () => {
    const assetId = await createAsset();
    const a = await createInvestment("A", "AAA");
    const b = await createInvestment("B", "BBB");
    await buy(a, assetId, 10);
    await buy(b, assetId, 5);
    const doc = graphql(`
      mutation ($assetId: ID!, $a: ID!) {
        investmentAllocationsSet(
          assetId: $assetId
          allocations: [{ investmentId: $a, allocation: 1 }]
        ) {
          investments {
            allocation
          }
        }
      }
    `);
    await expect(runGql(doc, { assetId, a })).rejects.toThrowError(
      /Missing allocations/,
    );
  });

  it("excludes fully-sold investments from the required set", async () => {
    const assetId = await createAsset();
    const a = await createInvestment("A", "AAA");
    const b = await createInvestment("B", "BBB");
    await buy(a, assetId, 10);
    await buy(b, assetId, 5);
    await buy(b, assetId, -5);
    const doc = graphql(`
      mutation ($assetId: ID!, $a: ID!) {
        investmentAllocationsSet(
          assetId: $assetId
          allocations: [{ investmentId: $a, allocation: 1 }]
        ) {
          investments {
            allocation
          }
        }
      }
    `);
    const data = await runGql(doc, { assetId, a });
    expect(data.investmentAllocationsSet.investments).toHaveLength(1);
  });
});

describe("investmentCashAllocationSet and query", () => {
  it("stores and upserts the portfolio-wide cash target as an absolute amount", async () => {
    const set = graphql(`
      mutation ($a: MoneyInput!) {
        investmentCashAllocationSet(amount: $a) {
          amount
          currency
        }
      }
    `);
    expect(await runGql(set, { a: { amount: 1000, currency: "GBP" } })).toEqual(
      {
        investmentCashAllocationSet: { amount: 1000, currency: "GBP" },
      },
    );
    expect(
      await runGql(set, { a: { amount: 2500.5, currency: "GBP" } }),
    ).toEqual({
      investmentCashAllocationSet: { amount: 2500.5, currency: "GBP" },
    });
  });

  it("surfaces the cash allocation in the per-wrapper query", async () => {
    const assetId = await createAsset();
    const setCash = graphql(`
      mutation {
        investmentCashAllocationSet(amount: { amount: 500, currency: "GBP" }) {
          amount
        }
      }
    `);
    await runGql(setCash, {});
    const q = graphql(`
      query ($assetId: ID!) {
        investmentAllocations(assetId: $assetId) {
          cash {
            amount
            currency
          }
          investments {
            allocation
          }
        }
      }
    `);
    const data = await runGql(q, { assetId });
    expect(data.investmentAllocations).toEqual({
      cash: { amount: 500, currency: "GBP" },
      investments: [],
    });
  });

  it("errors when asking for the portfolio-wide view", async () => {
    const q = graphql(`
      query {
        investmentAllocations {
          cash {
            amount
          }
        }
      }
    `);
    await expect(runGql(q, {})).rejects.toThrowError(/not yet implemented/);
  });

  it("rejects a negative cash target", async () => {
    const set = graphql(`
      mutation ($a: MoneyInput!) {
        investmentCashAllocationSet(amount: $a) {
          amount
        }
      }
    `);
    await expect(
      runGql(set, { a: { amount: -1, currency: "GBP" } }),
    ).rejects.toThrowError(/non-negative/);
  });
});

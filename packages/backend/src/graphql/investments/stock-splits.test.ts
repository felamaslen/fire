import { graphql, runGql } from "#test/gql";

async function createInvestment(): Promise<string> {
  const doc = graphql(`
    mutation {
      investmentCreate(
        name: "Apple"
        currency: "GBP"
        asset: { stock: { code: "AAPL" } }
      ) {
        id
      }
    }
  `);
  const data = await runGql(doc, {});
  return data.investmentCreate.id;
}

describe("investmentStockSplit mutations", () => {
  it("creates a forward split", async () => {
    const investmentId = await createInvestment();
    const doc = graphql(`
      mutation ($id: ID!) {
        investmentStockSplitCreate(
          investmentId: $id
          date: "2024-06-01"
          ratio: 2
        ) {
          id
          date
          ratio
        }
      }
    `);
    const data = await runGql(doc, { id: investmentId });
    expect(data.investmentStockSplitCreate).toMatchObject({
      date: "2024-06-01",
      ratio: 2,
    });
  });

  it("rejects a non-positive ratio", async () => {
    const investmentId = await createInvestment();
    const doc = graphql(`
      mutation ($id: ID!) {
        investmentStockSplitCreate(
          investmentId: $id
          date: "2024-06-01"
          ratio: 0
        ) {
          id
        }
      }
    `);
    await expect(
      runGql(doc, { id: investmentId }),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Error: GraphQL errors: ratio must be positive, got 0]`,
    );
  });

  it("updates ratio and recomputes via the DB trigger", async () => {
    const investmentId = await createInvestment();
    const create = graphql(`
      mutation ($id: ID!) {
        investmentStockSplitCreate(
          investmentId: $id
          date: "2024-06-01"
          ratio: 2
        ) {
          id
        }
      }
    `);
    const { investmentStockSplitCreate } = await runGql(create, {
      id: investmentId,
    });
    const upd = graphql(`
      mutation ($id: ID!) {
        investmentStockSplitUpdate(id: $id, ratio: 3) {
          ratio
        }
      }
    `);
    const data = await runGql(upd, { id: investmentStockSplitCreate.id });
    expect(data.investmentStockSplitUpdate.ratio).toBe(3);
  });

  it("deletes a split", async () => {
    const investmentId = await createInvestment();
    const create = graphql(`
      mutation ($id: ID!) {
        investmentStockSplitCreate(
          investmentId: $id
          date: "2024-06-01"
          ratio: 2
        ) {
          id
        }
      }
    `);
    const { investmentStockSplitCreate } = await runGql(create, {
      id: investmentId,
    });
    const del = graphql(`
      mutation ($id: ID!) {
        investmentStockSplitDelete(id: $id) {
          _
        }
      }
    `);
    await runGql(del, { id: investmentStockSplitCreate.id });
    const list = graphql(`
      query {
        investments {
          stockSplits {
            id
          }
        }
      }
    `);
    const data = await runGql(list, {});
    expect(data.investments?.[0]?.stockSplits ?? []).toEqual([]);
  });
});

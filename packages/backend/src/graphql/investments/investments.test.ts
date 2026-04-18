import { graphql, runGql } from "#test/gql";

async function createStock(
  name = "Apple",
  code = "AAPL",
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

describe("investment mutations", () => {
  it("creates a stock investment", async () => {
    const doc = graphql(`
      mutation {
        investmentCreate(
          name: "Apple"
          currency: "GBP"
          asset: { stock: { code: "AAPL" } }
        ) {
          id
          name
          currency
          asset {
            ... on InvestmentStock {
              code
            }
            ... on InvestmentFund {
              url
            }
          }
          unitPriceCached {
            amount
          }
        }
      }
    `);
    const data = await runGql(doc, {});
    expect(data.investmentCreate).toMatchObject({
      name: "Apple",
      currency: "GBP",
      asset: { code: "AAPL" },
      unitPriceCached: null,
    });
    expect(data.investmentCreate.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("creates a fund investment", async () => {
    const doc = graphql(`
      mutation {
        investmentCreate(
          name: "Baillie Gifford"
          currency: "GBP"
          asset: { fund: { url: "https://hl.co.uk/foo" } }
        ) {
          id
          asset {
            ... on InvestmentFund {
              url
            }
          }
        }
      }
    `);
    const data = await runGql(doc, {});
    expect(data.investmentCreate.asset).toEqual({
      url: "https://hl.co.uk/foo",
    });
  });

  it("rejects an investment supplied with both stock and fund", async () => {
    const doc = graphql(`
      mutation {
        investmentCreate(
          name: "Ambiguous"
          currency: "GBP"
          asset: {
            stock: { code: "AAPL" }
            fund: { url: "https://hl.co.uk/foo" }
          }
        ) {
          id
        }
      }
    `);
    await expect(runGql(doc, {})).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Error: GraphQL errors: OneOf Input Object "InvestmentAssetInput" must specify exactly one key.]`,
    );
  });

  it("rejects an unsupported currency", async () => {
    const doc = graphql(`
      mutation {
        investmentCreate(
          name: "Bad"
          currency: "XZZ"
          asset: { stock: { code: "AAPL" } }
        ) {
          id
        }
      }
    `);
    await expect(runGql(doc, {})).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Error: GraphQL errors: Unsupported currency: XZZ]`,
    );
  });

  it("updates the name and swaps the asset variant", async () => {
    const id = await createStock();
    const doc = graphql(`
      mutation ($id: ID!) {
        investmentUpdate(
          id: $id
          name: "Apple Inc."
          asset: { fund: { url: "https://hl.co.uk/apple" } }
        ) {
          id
          name
          asset {
            ... on InvestmentFund {
              url
            }
          }
        }
      }
    `);
    const data = await runGql(doc, { id });
    expect(data.investmentUpdate).toMatchObject({
      id,
      name: "Apple Inc.",
      asset: { url: "https://hl.co.uk/apple" },
    });
  });

  it("leaves fields unchanged when the update omits them", async () => {
    const id = await createStock("Microsoft", "MSFT");
    const doc = graphql(`
      mutation ($id: ID!) {
        investmentUpdate(id: $id) {
          name
          asset {
            ... on InvestmentStock {
              code
            }
          }
        }
      }
    `);
    const data = await runGql(doc, { id });
    expect(data.investmentUpdate).toMatchObject({
      name: "Microsoft",
      asset: { code: "MSFT" },
    });
  });

  it("deletes an investment", async () => {
    const id = await createStock();
    const del = graphql(`
      mutation ($id: ID!) {
        investmentDelete(id: $id) {
          _
        }
      }
    `);
    await runGql(del, { id });

    const list = graphql(`
      query {
        investments {
          id
        }
      }
    `);
    const data = await runGql(list, {});
    expect(data.investments).toEqual([]);
  });
});

describe("investments query", () => {
  it("returns created investments newest-first", async () => {
    await createStock("Apple", "AAPL");
    await createStock("Microsoft", "MSFT");
    const doc = graphql(`
      query {
        investments {
          name
        }
      }
    `);
    const data = await runGql(doc, {});
    expect(data.investments.map((i) => i.name)).toEqual(["Microsoft", "Apple"]);
  });
});

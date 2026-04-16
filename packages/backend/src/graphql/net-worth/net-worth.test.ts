import { graphql, runGql } from "#test/gql";

async function createAsset(name = "Savings"): Promise<string> {
  const doc = graphql(`
    mutation ($name: String!) {
      netWorthCategoryCreate(input: { asset: { name: $name, type: CASH } }) {
        id
      }
    }
  `);
  const data = await runGql(doc, { name });
  return data.netWorthCategoryCreate.id;
}

describe("categories", () => {
  it("creates one of each category kind", async () => {
    const doc = graphql(`
      mutation CreateAll {
        asset: netWorthCategoryCreate(
          input: { asset: { name: "Current account", type: CASH } }
        ) {
          id
          name
          ... on NetWorthCategoryAsset {
            type
          }
        }
        liability: netWorthCategoryCreate(
          input: { liability: { name: "Amex", type: CREDIT_CARD } }
        ) {
          id
          name
          ... on NetWorthCategoryLiability {
            liabilityType: type
          }
        }
        option: netWorthCategoryCreate(
          input: { option: { name: "My co shares" } }
        ) {
          id
          name
        }
      }
    `);
    const data = await runGql(doc, {});

    expect(data.asset).toMatchObject({
      name: "Current account",
      type: "CASH",
    });
    expect(data.liability).toMatchObject({
      name: "Amex",
      liabilityType: "CREDIT_CARD",
    });
    expect(data.option).toMatchObject({ name: "My co shares" });
  });

  it("rejects a LOAN liability without an interestRate", async () => {
    const doc = graphql(`
      mutation LoanWithoutRate {
        netWorthCategoryCreate(
          input: { liability: { name: "Mortgage", type: LOAN } }
        ) {
          id
        }
      }
    `);
    await expect(runGql(doc, {})).rejects.toThrow(
      /interestRate is required when type is LOAN/,
    );
  });

  it("returns all three kinds via the unified connection", async () => {
    const seed = graphql(`
      mutation Seed {
        a: netWorthCategoryCreate(input: { asset: { name: "A", type: CASH } }) {
          id
        }
        l: netWorthCategoryCreate(
          input: { liability: { name: "L", type: CREDIT_CARD } }
        ) {
          id
        }
        o: netWorthCategoryCreate(input: { option: { name: "O" } }) {
          id
        }
      }
    `);
    await runGql(seed, {});

    const doc = graphql(`
      query AllCategories {
        netWorthCategories(first: 10) {
          edges {
            cursor
            node {
              __typename
              id
              name
              ... on NetWorthCategoryAsset {
                assetType: type
              }
              ... on NetWorthCategoryLiability {
                liabilityType: type
                interestRate
              }
            }
          }
          pageInfo {
            hasNextPage
            hasPreviousPage
            startCursor
            endCursor
          }
        }
      }
    `);
    const data = await runGql(doc, {});

    expect(data.netWorthCategories.edges).toHaveLength(3);
    const typenames = data.netWorthCategories.edges.map(
      (e) => e.node.__typename,
    );
    expect(typenames).toEqual(
      expect.arrayContaining([
        "NetWorthCategoryAsset",
        "NetWorthCategoryLiability",
        "NetWorthCategoryOption",
      ]),
    );
    expect(data.netWorthCategories.pageInfo.hasNextPage).toBe(false);
  });

  it("updates and deletes a category", async () => {
    const assetId = await createAsset("Current account");
    const optionId = (
      await runGql(
        graphql(`
          mutation {
            netWorthCategoryCreate(
              input: { option: { name: "My co shares" } }
            ) {
              id
            }
          }
        `),
        {},
      )
    ).netWorthCategoryCreate.id;

    const update = graphql(`
      mutation UpdateAsset($id: ID!) {
        netWorthCategoryUpdate(
          id: $id
          patch: { asset: { name: "Main account" } }
        ) {
          id
          name
          ... on NetWorthCategoryAsset {
            type
          }
        }
      }
    `);
    const updated = await runGql(update, { id: assetId });
    expect(updated.netWorthCategoryUpdate).toMatchObject({
      id: assetId,
      name: "Main account",
    });

    const del = graphql(`
      mutation DeleteOption($id: ID!) {
        netWorthCategoryDelete(ref: { option: $id }) {
          _
        }
      }
    `);
    await runGql(del, { id: optionId });
  });
});

describe("entries", () => {
  let assetId: string;

  beforeEach(async () => {
    assetId = await createAsset();
  });

  it("creates an entry with values", async () => {
    const doc = graphql(`
      mutation CreateEntry($assetId: ID!) {
        netWorthCreate(
          date: "2026-04-15"
          values: [
            {
              asset: {
                categoryId: $assetId
                amounts: [
                  { amount: 5000, currency: "GBP" }
                  { amount: 6200, currency: "USD" }
                ]
              }
            }
          ]
        ) {
          id
          date
          values {
            amounts {
              amount
              currency
            }
            asset {
              name
              type
            }
          }
        }
      }
    `);
    const data = await runGql(doc, { assetId });

    expect(data.netWorthCreate.date).toBe("2026-04-15");
    expect(data.netWorthCreate.values).toHaveLength(1);
    expect(data.netWorthCreate.values[0].asset).toMatchObject({
      name: "Savings",
      type: "CASH",
    });
    expect(data.netWorthCreate.values[0].amounts).toEqual(
      expect.arrayContaining([
        { amount: 5000, currency: "GBP" },
        { amount: 6200, currency: "USD" },
      ]),
    );
  });

  it("round-trips JPY (zero-decimal currency) without scaling", async () => {
    const doc = graphql(`
      mutation CreateJpyEntry($a: ID!) {
        netWorthCreate(
          date: "2027-01-15"
          values: [
            {
              asset: {
                categoryId: $a
                amounts: [{ amount: 1000000, currency: "JPY" }]
              }
            }
          ]
        ) {
          values {
            amounts {
              amount
              currency
            }
          }
        }
      }
    `);
    const data = await runGql(doc, { a: assetId });
    expect(data.netWorthCreate.values[0].amounts).toEqual([
      { amount: 1000000, currency: "JPY" },
    ]);
  });

  it("rejects an unsupported currency in MoneyInput", async () => {
    const doc = graphql(`
      mutation BadCurrency($a: ID!) {
        netWorthCreate(
          date: "2028-01-15"
          values: [
            {
              asset: {
                categoryId: $a
                amounts: [{ amount: 10, currency: "ZZZ" }]
              }
            }
          ]
        ) {
          id
        }
      }
    `);
    await expect(runGql(doc, { a: assetId })).rejects.toThrow(
      /Unsupported currency/,
    );
  });

  it("paginates entries forward and backward", async () => {
    const seed = graphql(`
      mutation Seed($a: ID!) {
        a: netWorthCreate(
          date: "2026-04-15"
          values: [
            {
              asset: {
                categoryId: $a
                amounts: [{ amount: 5000, currency: "GBP" }]
              }
            }
          ]
        ) {
          id
        }
        b: netWorthCreate(
          date: "2026-05-15"
          values: [
            {
              asset: {
                categoryId: $a
                amounts: [{ amount: 6000, currency: "GBP" }]
              }
            }
          ]
        ) {
          id
        }
        c: netWorthCreate(
          date: "2026-06-15"
          values: [
            {
              asset: {
                categoryId: $a
                amounts: [{ amount: 7000, currency: "GBP" }]
              }
            }
          ]
        ) {
          id
        }
      }
    `);
    await runGql(seed, { a: assetId });

    const forwardDoc = graphql(`
      query Forward {
        netWorth(first: 2) {
          edges {
            cursor
            node {
              id
              date
            }
          }
          pageInfo {
            hasNextPage
            hasPreviousPage
            startCursor
            endCursor
          }
        }
      }
    `);
    const forward = await runGql(forwardDoc, {});
    expect(forward.netWorth.edges).toHaveLength(2);
    expect(forward.netWorth.pageInfo.hasNextPage).toBe(true);

    const endCursor = forward.netWorth.pageInfo.endCursor;
    if (!endCursor) throw new Error("missing endCursor");

    const backwardDoc = graphql(`
      query Backward($c: ID!) {
        netWorth(last: 2, before: $c) {
          edges {
            cursor
            node {
              id
              date
            }
          }
          pageInfo {
            hasNextPage
            hasPreviousPage
          }
        }
      }
    `);
    const backward = await runGql(backwardDoc, { c: endCursor });
    expect(backward.netWorth.edges.length).toBeGreaterThan(0);
  });

  it("sets and updates currency rates on an entry", async () => {
    const create = graphql(`
      mutation CreateWithRates($a: ID!) {
        netWorthCreate(
          date: "2026-07-15"
          values: [
            {
              asset: {
                categoryId: $a
                amounts: [{ amount: 5000, currency: "GBP" }]
              }
            }
          ]
          currencyRates: [
            { base: "GBP", currency: "USD", rate: 1.35 }
            { base: "GBP", currency: "EUR", rate: 1.17 }
          ]
        ) {
          id
          currencyRates {
            base
            currency
            rate
          }
        }
      }
    `);
    const created = await runGql(create, { a: assetId });
    expect(created.netWorthCreate.currencyRates).toEqual(
      expect.arrayContaining([
        { base: "GBP", currency: "USD", rate: 1.35 },
        { base: "GBP", currency: "EUR", rate: 1.17 },
      ]),
    );

    // Replace: keep USD (updated), drop EUR, add JPY. Covers upsert + orphan delete.
    const update = graphql(`
      mutation UpdateRates($id: ID!) {
        netWorthUpdate(
          id: $id
          currencyRates: [
            { base: "GBP", currency: "USD", rate: 1.4 }
            { base: "GBP", currency: "JPY", rate: 190 }
          ]
        ) {
          currencyRates {
            base
            currency
            rate
          }
        }
      }
    `);
    const updated = await runGql(update, { id: created.netWorthCreate.id });
    expect(updated.netWorthUpdate.currencyRates).toEqual(
      expect.arrayContaining([
        { base: "GBP", currency: "USD", rate: 1.4 },
        { base: "GBP", currency: "JPY", rate: 190 },
      ]),
    );
    expect(updated.netWorthUpdate.currencyRates).toHaveLength(2);
  });

  it("rejects a currency rate where base equals currency", async () => {
    const doc = graphql(`
      mutation BadRate($a: ID!) {
        netWorthCreate(
          date: "2026-08-15"
          values: [
            {
              asset: {
                categoryId: $a
                amounts: [{ amount: 1, currency: "GBP" }]
              }
            }
          ]
          currencyRates: [{ base: "GBP", currency: "GBP", rate: 1 }]
        ) {
          id
        }
      }
    `);
    await expect(runGql(doc, { a: assetId })).rejects.toThrow(
      /base and currency must differ/,
    );
  });

  it("updates and deletes an entry", async () => {
    const create = graphql(`
      mutation ($a: ID!) {
        netWorthCreate(
          date: "2026-04-15"
          values: [
            {
              asset: {
                categoryId: $a
                amounts: [{ amount: 5000, currency: "GBP" }]
              }
            }
          ]
        ) {
          id
        }
      }
    `);
    const entryId = (await runGql(create, { a: assetId })).netWorthCreate.id;

    const update = graphql(`
      mutation UpdateEntry($id: ID!, $a: ID!) {
        netWorthUpdate(
          id: $id
          date: "2026-04-15"
          values: [
            {
              asset: {
                categoryId: $a
                amounts: [{ amount: 9999.99, currency: "GBP" }]
              }
            }
          ]
        ) {
          id
          date
          values {
            amounts {
              amount
              currency
            }
          }
        }
      }
    `);
    const updated = await runGql(update, { id: entryId, a: assetId });
    expect(updated.netWorthUpdate.values[0].amounts).toEqual([
      { amount: 9999.99, currency: "GBP" },
    ]);

    const del = graphql(`
      mutation DeleteEntry($id: ID!) {
        netWorthDelete(id: $id) {
          _
        }
      }
    `);
    await runGql(del, { id: entryId });
  });
});

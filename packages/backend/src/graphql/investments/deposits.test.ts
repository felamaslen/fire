import { graphql, runGql } from "#test/gql";

async function createAsset(
  type: "CASH" | "STOCK" | "PENSION" = "STOCK",
  name = "ISA",
): Promise<string> {
  const data = await runGql(
    graphql(`
      mutation ($name: String!, $type: NetWorthAssetType!) {
        netWorthCategoryCreate(input: { asset: { name: $name, type: $type } }) {
          id
        }
      }
    `),
    { name, type },
  );
  return data.netWorthCategoryCreate.id;
}

async function createDeposit(
  assetId: string,
  overrides: Partial<{
    date: string;
    amount: number;
    currency: string;
    name: string;
  }> = {},
): Promise<string> {
  const data = await runGql(
    graphql(`
      mutation (
        $assetId: ID!
        $date: Date!
        $amount: MoneyInput!
        $name: String!
      ) {
        investmentDepositCreate(
          assetId: $assetId
          date: $date
          amount: $amount
          name: $name
        ) {
          id
        }
      }
    `),
    {
      assetId,
      date: overrides.date ?? "2026-04-15",
      amount: {
        amount: overrides.amount ?? 100,
        currency: overrides.currency ?? "GBP",
      },
      name: overrides.name ?? "Q1 dividend",
    },
  );
  return data.investmentDepositCreate.id;
}

async function listDeposits(assetId: string): Promise<
  Array<{
    id: string;
    date: string;
    name: string;
    amount: { amount: number; currency: string };
  }>
> {
  const data = await runGql(
    graphql(`
      query ($id: ID!) {
        netWorthCategoryAsset(id: $id) {
          cashContributions(first: 100) {
            edges {
              node {
                __typename
                ... on InvestmentDeposit {
                  id
                  date
                  name
                  amount {
                    amount
                    currency
                  }
                }
              }
            }
          }
        }
      }
    `),
    { id: assetId },
  );
  const edges = data.netWorthCategoryAsset?.cashContributions?.edges ?? [];
  // Tests in this file only seed `InvestmentDeposit`s for the asset, so the
  // unioned `cashContributions` is a deposit-only feed here. Pluck the
  // deposit-shaped nodes out for assertion.
  return edges.flatMap((e) =>
    e.node.__typename === "InvestmentDeposit" ? [e.node] : [],
  );
}

describe("investmentDepositCreate", () => {
  it("books a deposit against a STOCK wrapper", async () => {
    const assetId = await createAsset("STOCK");
    const created = await runGql(
      graphql(`
        mutation ($assetId: ID!) {
          investmentDepositCreate(
            assetId: $assetId
            date: "2026-04-12"
            amount: { amount: 250, currency: "GBP" }
            name: "Q1 dividend"
          ) {
            id
            date
            name
            amount {
              amount
              currency
            }
            asset {
              id
            }
          }
        }
      `),
      { assetId },
    );
    expect(created.investmentDepositCreate).toMatchObject({
      date: "2026-04-12",
      name: "Q1 dividend",
      amount: { amount: 250, currency: "GBP" },
      asset: { id: assetId },
    });
  });

  it("accepts a negative amount (withdrawal without a matching trade)", async () => {
    const assetId = await createAsset("PENSION");
    const id = await createDeposit(assetId, {
      amount: -50,
      name: "Platform fee",
    });
    const [row] = await listDeposits(assetId);
    expect(row).toMatchObject({
      id,
      name: "Platform fee",
      amount: { amount: -50, currency: "GBP" },
    });
  });

  it("rejects a non-STOCK / non-PENSION wrapper", async () => {
    const cash = await createAsset("CASH", "Current");
    await expect(
      runGql(
        graphql(`
          mutation ($assetId: ID!) {
            investmentDepositCreate(
              assetId: $assetId
              date: "2026-04-12"
              amount: { amount: 100, currency: "GBP" }
              name: "x"
            ) {
              id
            }
          }
        `),
        { assetId: cash },
      ),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Error: GraphQL errors: Asset ${cash} must be STOCK or PENSION, got CASH]`,
    );
  });

  it("rejects an unknown asset id", async () => {
    await expect(
      runGql(
        graphql(`
          mutation {
            investmentDepositCreate(
              assetId: "00000000-0000-0000-0000-000000000000"
              date: "2026-04-12"
              amount: { amount: 100, currency: "GBP" }
              name: "x"
            ) {
              id
            }
          }
        `),
        {},
      ),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Error: GraphQL errors: Asset 00000000-0000-0000-0000-000000000000 not found]`,
    );
  });
});

describe("investmentDepositUpdate", () => {
  it("patches only the supplied fields", async () => {
    const assetId = await createAsset("STOCK");
    const id = await createDeposit(assetId, {
      date: "2026-03-01",
      amount: 100,
      name: "Initial",
    });

    const after = await runGql(
      graphql(`
        mutation ($id: ID!) {
          investmentDepositUpdate(id: $id, name: "Renamed") {
            id
            date
            name
            amount {
              amount
              currency
            }
          }
        }
      `),
      { id },
    );
    expect(after.investmentDepositUpdate).toMatchObject({
      date: "2026-03-01",
      name: "Renamed",
      amount: { amount: 100, currency: "GBP" },
    });
  });

  it("updates the amount + currency together", async () => {
    const assetId = await createAsset("STOCK");
    const id = await createDeposit(assetId, { amount: 100, currency: "GBP" });
    const after = await runGql(
      graphql(`
        mutation ($id: ID!) {
          investmentDepositUpdate(
            id: $id
            amount: { amount: 75, currency: "USD" }
          ) {
            amount {
              amount
              currency
            }
          }
        }
      `),
      { id },
    );
    expect(after.investmentDepositUpdate.amount).toEqual({
      amount: 75,
      currency: "USD",
    });
  });

  it("returns the existing row unchanged when no fields are supplied", async () => {
    const assetId = await createAsset("STOCK");
    const id = await createDeposit(assetId, { name: "Untouched" });
    const after = await runGql(
      graphql(`
        mutation ($id: ID!) {
          investmentDepositUpdate(id: $id) {
            name
          }
        }
      `),
      { id },
    );
    expect(after.investmentDepositUpdate.name).toBe("Untouched");
  });

  it("rejects an unknown id", async () => {
    await expect(
      runGql(
        graphql(`
          mutation {
            investmentDepositUpdate(
              id: "00000000-0000-0000-0000-000000000000"
              name: "x"
            ) {
              id
            }
          }
        `),
        {},
      ),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Error: GraphQL errors: InvestmentDeposit 00000000-0000-0000-0000-000000000000 not found]`,
    );
  });
});

describe("investmentDepositDelete", () => {
  it("removes the row", async () => {
    const assetId = await createAsset("STOCK");
    const id = await createDeposit(assetId);
    expect(await listDeposits(assetId)).toHaveLength(1);
    await runGql(
      graphql(`
        mutation ($id: ID!) {
          investmentDepositDelete(id: $id) {
            _
          }
        }
      `),
      { id },
    );
    expect(await listDeposits(assetId)).toEqual([]);
  });
});

describe("netWorthCategoryAsset.cashContributions (deposit edges)", () => {
  it("returns rows newest-first", async () => {
    const assetId = await createAsset("STOCK");
    await createDeposit(assetId, { date: "2026-01-15", name: "Jan" });
    await createDeposit(assetId, { date: "2026-04-15", name: "Apr" });
    await createDeposit(assetId, { date: "2026-02-15", name: "Feb" });
    const rows = await listDeposits(assetId);
    expect(rows.map((r) => r.name)).toEqual(["Apr", "Feb", "Jan"]);
  });

  it("scopes to the requested wrapper", async () => {
    const a = await createAsset("STOCK", "ISA A");
    const b = await createAsset("STOCK", "ISA B");
    await createDeposit(a, { name: "On A" });
    await createDeposit(b, { name: "On B" });
    expect((await listDeposits(a)).map((r) => r.name)).toEqual(["On A"]);
    expect((await listDeposits(b)).map((r) => r.name)).toEqual(["On B"]);
  });
});

describe("Query.netWorthCategoryAsset", () => {
  it("returns null for an unknown id", async () => {
    const data = await runGql(
      graphql(`
        query {
          netWorthCategoryAsset(id: "00000000-0000-0000-0000-000000000000") {
            id
          }
        }
      `),
      {},
    );
    expect(data.netWorthCategoryAsset).toBeNull();
  });
});

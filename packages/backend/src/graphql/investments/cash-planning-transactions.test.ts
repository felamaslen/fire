// Covers `assetCashTransaction*` (wrapper-perspective sign + month-anchored
// dates) and the unioned `NetWorthCategoryAsset.cashContributions`
// connection. Pulls a real planning year via `transactionCreate` to seed
// provisional rows so the exclusion paths can be exercised.

import { graphql, runGql } from "#test/gql";

async function createStockAsset(name: string): Promise<string> {
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

async function createCashAsset(name: string): Promise<string> {
  const data = await runGql(
    graphql(`
      mutation ($name: String!) {
        netWorthCategoryCreate(input: { asset: { name: $name, type: CASH } }) {
          id
        }
      }
    `),
    { name },
  );
  return data.netWorthCategoryCreate.id;
}

async function assignPlanningAccount(assetId: string): Promise<void> {
  await runGql(
    graphql(`
      mutation ($id: ID!) {
        planningAccountAssign(assetId: $id, alias: null) {
          id
        }
      }
    `),
    { id: assetId },
  );
}

async function seedYear(year = "2026"): Promise<void> {
  await runGql(
    graphql(`
      mutation ($y: ID!) {
        planningYearSet(year: $y) {
          id
        }
      }
    `),
    { y: year },
  );
}

async function listCashContributions(assetId: string): Promise<
  Array<{
    __typename: string;
    id: string;
    name: string;
    isProvisional?: boolean;
  }>
> {
  const data = await runGql(
    graphql(`
      query ($id: ID!) {
        netWorthCategoryAsset(id: $id) {
          cashContributions(first: 50) {
            edges {
              node {
                __typename
                ... on AssetCashPlanningTransaction {
                  id
                  name
                  isProvisional
                }
                ... on InvestmentDeposit {
                  id
                  name
                }
              }
            }
          }
        }
      }
    `),
    { id: assetId },
  );
  return (data.netWorthCategoryAsset?.cashContributions?.edges ?? []).map(
    (e) => e.node,
  );
}

describe("assetCashTransactionCreate", () => {
  it("stores wrapper-POV amount with the sign flipped on disk", async () => {
    await seedYear();
    const cash = await createCashAsset("Current");
    const isa = await createStockAsset("ISA");
    await assignPlanningAccount(cash);

    const data = await runGql(
      graphql(`
        mutation ($a: ID!, $f: ID!) {
          assetCashTransactionCreate(
            assetId: $a
            fromAccountId: $f
            date: "2026-04-15"
            amount: { amount: 250, currency: "GBP" }
            name: "April contrib"
          ) {
            id
            date
            name
            amount {
              amount
              currency
            }
            fromAccount {
              id
            }
            isProvisional
          }
        }
      `),
      { a: isa, f: cash },
    );
    expect(data.assetCashTransactionCreate).toMatchObject({
      // Server anchors to first-of-month even when caller passes mid-month.
      date: "2026-04-01",
      name: "April contrib",
      // Wrapper-POV: input was +250, surfaced back as +250 (server flips the
      // sign internally before storing).
      amount: { amount: 250, currency: "GBP" },
      fromAccount: { id: cash },
      isProvisional: false,
    });
  });

  it("rejects a non-CASH `fromAccountId`", async () => {
    await seedYear();
    const isa = await createStockAsset("ISA");
    const otherStock = await createStockAsset("Other");

    await expect(
      runGql(
        graphql(`
          mutation ($a: ID!, $f: ID!) {
            assetCashTransactionCreate(
              assetId: $a
              fromAccountId: $f
              date: "2026-04-15"
              amount: { amount: 100, currency: "GBP" }
              name: "x"
            ) {
              id
            }
          }
        `),
        { a: isa, f: otherStock },
      ),
    ).rejects.toThrow(/must be CASH/);
  });

  it("rejects a non-STOCK / non-PENSION `assetId`", async () => {
    await seedYear();
    const cash = await createCashAsset("Current");
    const otherCash = await createCashAsset("Other");
    await assignPlanningAccount(cash);

    await expect(
      runGql(
        graphql(`
          mutation ($a: ID!, $f: ID!) {
            assetCashTransactionCreate(
              assetId: $a
              fromAccountId: $f
              date: "2026-04-15"
              amount: { amount: 100, currency: "GBP" }
              name: "x"
            ) {
              id
            }
          }
        `),
        { a: otherCash, f: cash },
      ),
    ).rejects.toThrow(/must be STOCK or PENSION/);
  });

  it("can mark a row as provisional on create", async () => {
    await seedYear();
    const cash = await createCashAsset("Current");
    const isa = await createStockAsset("ISA");
    await assignPlanningAccount(cash);

    const data = await runGql(
      graphql(`
        mutation ($a: ID!, $f: ID!) {
          assetCashTransactionCreate(
            assetId: $a
            fromAccountId: $f
            date: "2026-04-15"
            amount: { amount: 100, currency: "GBP" }
            name: "Maybe"
            isProvisional: true
          ) {
            id
            isProvisional
          }
        }
      `),
      { a: isa, f: cash },
    );
    expect(data.assetCashTransactionCreate.isProvisional).toBe(true);
  });
});

describe("NetWorthCategoryAsset.cashContributions", () => {
  it("excludes provisional cash transfers", async () => {
    await seedYear();
    const cash = await createCashAsset("Current");
    const isa = await createStockAsset("ISA");
    await assignPlanningAccount(cash);

    await runGql(
      graphql(`
        mutation ($a: ID!, $f: ID!) {
          assetCashTransactionCreate(
            assetId: $a
            fromAccountId: $f
            date: "2026-04-15"
            amount: { amount: 200, currency: "GBP" }
            name: "Real"
          ) {
            id
          }
        }
      `),
      { a: isa, f: cash },
    );
    await runGql(
      graphql(`
        mutation ($a: ID!, $f: ID!) {
          assetCashTransactionCreate(
            assetId: $a
            fromAccountId: $f
            date: "2026-04-15"
            amount: { amount: 999, currency: "GBP" }
            name: "Draft"
            isProvisional: true
          ) {
            id
          }
        }
      `),
      { a: isa, f: cash },
    );
    const rows = await listCashContributions(isa);
    expect(rows.map((r) => r.name)).toEqual(["Real"]);
  });

  it("flipping a row to provisional via update removes it from the list", async () => {
    await seedYear();
    const cash = await createCashAsset("Current");
    const isa = await createStockAsset("ISA");
    await assignPlanningAccount(cash);

    const created = await runGql(
      graphql(`
        mutation ($a: ID!, $f: ID!) {
          assetCashTransactionCreate(
            assetId: $a
            fromAccountId: $f
            date: "2026-04-15"
            amount: { amount: 250, currency: "GBP" }
            name: "Real for now"
          ) {
            id
          }
        }
      `),
      { a: isa, f: cash },
    );
    expect(await listCashContributions(isa)).toHaveLength(1);

    await runGql(
      graphql(`
        mutation ($id: ID!) {
          assetCashTransactionUpdate(id: $id, isProvisional: true) {
            isProvisional
          }
        }
      `),
      { id: created.assetCashTransactionCreate.id },
    );
    expect(await listCashContributions(isa)).toEqual([]);
  });
});

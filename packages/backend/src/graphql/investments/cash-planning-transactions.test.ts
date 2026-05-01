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
  return (data.netWorthCategoryAsset?.cashContributions?.edges ?? [])
    .filter(
      (e) =>
        e.node.__typename === "InvestmentDeposit" ||
        e.node.__typename === "AssetCashPlanningTransaction",
    )
    .map(
      (e) =>
        e.node as {
          __typename: string;
          id: string;
          name: string;
          isProvisional?: boolean;
        },
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

  it("accepts a negative wrapper-POV amount as a withdrawal back to cash", async () => {
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
            amount: { amount: -300, currency: "GBP" }
            name: "Payment to Client"
          ) {
            amount {
              amount
            }
          }
        }
      `),
      { a: isa, f: cash },
    );
    // Surface the wrapper-POV amount unchanged — withdrawals stay negative.
    expect(data.assetCashTransactionCreate.amount.amount).toBe(-300);
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

  it("interleaves AssetValueSnapshot rows for each net-worth entry that records the wrapper", async () => {
    const isa = await createStockAsset("ISA");
    const { db } = await import("@/db");
    const { InvestmentDeposits } = await import("@/db/schema/investments");
    const { NetWorthEntries, NetWorthValues, NetWorthValueAmounts } =
      await import("@/db/schema/net-worth");

    async function recordEntry(date: string, amountMajor: number) {
      const [entry] = await db
        .insert(NetWorthEntries)
        .values({ date: new Date(date) })
        .returning({ id: NetWorthEntries.id });
      const [v] = await db
        .insert(NetWorthValues)
        .values({ entryId: entry.id, categoryAssetId: isa })
        .returning({ id: NetWorthValues.id });
      await db.insert(NetWorthValueAmounts).values({
        valueId: v.id,
        amount: amountMajor * 100,
        currency: "GBP",
      });
    }

    await db.insert(InvestmentDeposits).values({
      assetId: isa,
      date: new Date("2026-02-15"),
      amount: 50_000,
      currency: "GBP",
      name: "Feb deposit",
    });
    await recordEntry("2026-02-28", 600);
    await db.insert(InvestmentDeposits).values({
      assetId: isa,
      date: new Date("2026-03-15"),
      amount: 30_000,
      currency: "GBP",
      name: "Mar deposit",
    });
    await recordEntry("2026-03-31", 950);

    const data = await runGql(
      graphql(`
        query ($id: ID!) {
          netWorthCategoryAsset(id: $id) {
            cashContributions(first: 50) {
              edges {
                node {
                  __typename
                  ... on InvestmentDeposit {
                    name
                  }
                  ... on AssetValueSnapshot {
                    date
                    value {
                      amount
                    }
                  }
                }
              }
            }
          }
        }
      `),
      { id: isa },
    );
    const nodes =
      data.netWorthCategoryAsset?.cashContributions?.edges.map((e) => e.node) ??
      [];
    // Date-desc: snapshot 2026-03-31, deposit 2026-03-15, snapshot 2026-02-28,
    // deposit 2026-02-15. No defunct marker — wrapper is in the latest entry.
    expect(
      nodes.map((n) =>
        n.__typename === "AssetValueSnapshot"
          ? `snapshot ${n.date} £${n.value?.amount}`
          : n.__typename === "InvestmentDeposit"
            ? `deposit ${n.name}`
            : n.__typename,
      ),
    ).toEqual([
      "snapshot 2026-03-31 £950",
      "deposit Mar deposit",
      "snapshot 2026-02-28 £600",
      "deposit Feb deposit",
    ]);
  });

  it("prepends a synthetic defunct marker when the latest entry omits the wrapper", async () => {
    const isa = await createStockAsset("ISA");
    const other = await createStockAsset("Other");
    const { db } = await import("@/db");
    const { NetWorthEntries, NetWorthValues, NetWorthValueAmounts } =
      await import("@/db/schema/net-worth");

    async function recordEntry(
      date: string,
      values: { assetId: string; amountMajor: number }[],
    ) {
      const [entry] = await db
        .insert(NetWorthEntries)
        .values({ date: new Date(date) })
        .returning({ id: NetWorthEntries.id });
      for (const v of values) {
        const [vr] = await db
          .insert(NetWorthValues)
          .values({ entryId: entry.id, categoryAssetId: v.assetId })
          .returning({ id: NetWorthValues.id });
        await db.insert(NetWorthValueAmounts).values({
          valueId: vr.id,
          amount: v.amountMajor * 100,
          currency: "GBP",
        });
      }
    }

    // Wrapper is in the Feb entry but missing from the latest (Apr).
    await recordEntry("2026-02-28", [{ assetId: isa, amountMajor: 1000 }]);
    await recordEntry("2026-03-31", [{ assetId: isa, amountMajor: 1100 }]);
    await recordEntry("2026-04-30", [{ assetId: other, amountMajor: 1 }]);

    const data = await runGql(
      graphql(`
        query ($id: ID!) {
          netWorthCategoryAsset(id: $id) {
            cashContributions(first: 50) {
              edges {
                node {
                  __typename
                  ... on AssetValueSnapshot {
                    date
                    value {
                      amount
                    }
                  }
                }
              }
            }
          }
        }
      `),
      { id: isa },
    );
    const nodes =
      data.netWorthCategoryAsset?.cashContributions?.edges.map((e) => e.node) ??
      [];
    // Defunct marker dated to the first absent entry (2026-04-30, `value`
    // null), then the two real snapshot rows in date-desc order.
    expect(
      nodes.map((n) =>
        n.__typename === "AssetValueSnapshot"
          ? `${n.date} ${n.value === null ? "DEFUNCT" : "£" + n.value.amount}`
          : n.__typename,
      ),
    ).toEqual(["2026-04-30 DEFUNCT", "2026-03-31 £1100", "2026-02-28 £1000"]);
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

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

  it("stores growthRate on VEHICLE / PROPERTY and rejects it for other types", async () => {
    const create = graphql(`
      mutation {
        netWorthCategoryCreate(
          input: { asset: { name: "Tesla", type: VEHICLE, growthRate: -15 } }
        ) {
          id
          ... on NetWorthCategoryAsset {
            type
            growthRate
          }
        }
      }
    `);
    const data = await runGql(create, {});
    expect(data.netWorthCategoryCreate).toMatchObject({
      type: "VEHICLE",
      growthRate: -15,
    });

    const bad = graphql(`
      mutation {
        netWorthCategoryCreate(
          input: { asset: { name: "Savings", type: CASH, growthRate: 2 } }
        ) {
          id
        }
      }
    `);
    await expect(runGql(bad, {})).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Error: GraphQL errors: growthRate is only valid when type is PROPERTY or VEHICLE]`,
    );
  });

  it("associates a LOAN liability with an asset on create and preserves/clears it on update", async () => {
    const seed = graphql(`
      mutation {
        asset: netWorthCategoryCreate(
          input: { asset: { name: "House", type: PROPERTY } }
        ) {
          id
        }
        loan: netWorthCategoryCreate(
          input: {
            liability: { name: "Mortgage", type: LOAN, interestRate: 5.25 }
          }
        ) {
          id
        }
      }
    `);
    const { asset, loan } = await runGql(seed, {});

    const attach = graphql(`
      mutation Attach($id: ID!, $aid: ID!) {
        netWorthCategoryUpdate(
          id: $id
          patch: { liability: { assetId: $aid } }
        ) {
          id
          ... on NetWorthCategoryLiability {
            asset {
              id
              name
            }
          }
        }
      }
    `);
    const attached = await runGql(attach, { id: loan.id, aid: asset.id });
    expect(attached.netWorthCategoryUpdate).toMatchObject({
      id: loan.id,
      asset: { id: asset.id, name: "House" },
    });

    // Verify the link actually persisted — not just echoed in the mutation
    // response. Regression: an earlier implementation returned the updated
    // row from `UPDATE ... RETURNING` before the assetId set was applied,
    // so the mutation response showed the asset but a subsequent read did
    // not.
    const readBack = await runGql(
      graphql(`
        query ReadBack {
          netWorthCategories(first: 100) {
            edges {
              node {
                __typename
                id
                ... on NetWorthCategoryLiability {
                  asset {
                    id
                  }
                }
              }
            }
          }
        }
      `),
      {},
    );
    const loanNode = readBack.netWorthCategories!.edges.find(
      (e) =>
        e.node.__typename === "NetWorthCategoryLiability" &&
        e.node.id === loan.id,
    )?.node as { asset: { id: string } | null } | undefined;
    expect(loanNode?.asset?.id).toBe(asset.id);

    const clear = graphql(`
      mutation Clear($id: ID!) {
        netWorthCategoryUpdate(
          id: $id
          patch: { liability: { assetId: null } }
        ) {
          id
          ... on NetWorthCategoryLiability {
            asset {
              id
            }
          }
        }
      }
    `);
    const cleared = await runGql(clear, { id: loan.id });
    expect(cleared.netWorthCategoryUpdate).toMatchObject({
      id: loan.id,
      asset: null,
    });
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

    expect(data.netWorthCategories!.edges).toHaveLength(3);
    const typenames = data.netWorthCategories!.edges.map(
      (e) => e.node.__typename,
    );
    expect(typenames).toEqual(
      expect.arrayContaining([
        "NetWorthCategoryAsset",
        "NetWorthCategoryLiability",
        "NetWorthCategoryOption",
      ]),
    );
    expect(data.netWorthCategories!.pageInfo.hasNextPage).toBe(false);
  });

  it("filters categories by kind and by type", async () => {
    const seed = graphql(`
      mutation {
        cash: netWorthCategoryCreate(
          input: { asset: { name: "Cash", type: CASH } }
        ) {
          id
        }
        stock: netWorthCategoryCreate(
          input: { asset: { name: "ISA", type: STOCK } }
        ) {
          id
        }
        pension: netWorthCategoryCreate(
          input: { asset: { name: "SIPP", type: PENSION } }
        ) {
          id
        }
        loan: netWorthCategoryCreate(
          input: {
            liability: { name: "Mortgage", type: LOAN, interestRate: 5 }
          }
        ) {
          id
        }
        creditCard: netWorthCategoryCreate(
          input: { liability: { name: "Amex", type: CREDIT_CARD } }
        ) {
          id
        }
        equity: netWorthCategoryCreate(input: { option: { name: "RSU" } }) {
          id
        }
      }
    `);
    await runGql(seed, {});

    const list = graphql(`
      query ($kinds: [NetWorthCategoryKind!], $types: [NetWorthCategoryType!]) {
        netWorthCategories(
          first: 50
          filterKindIn: $kinds
          filterTypeIn: $types
        ) {
          edges {
            node {
              __typename
              name
            }
          }
        }
      }
    `);
    const sortedNames = (
      data: Awaited<ReturnType<typeof runGql<typeof list>>>,
    ): string[] =>
      data
        .netWorthCategories!.edges.map((e) => e.node.name)
        .sort((a, b) => a.localeCompare(b));

    // No filter — every category surfaces.
    const all = await runGql(list, { kinds: null, types: null });
    expect(sortedNames(all)).toEqual([
      "Amex",
      "Cash",
      "ISA",
      "Mortgage",
      "RSU",
      "SIPP",
    ]);

    // Kind filter alone — assets only.
    const onlyAssets = await runGql(list, { kinds: ["ASSET"], types: null });
    expect(sortedNames(onlyAssets)).toEqual(["Cash", "ISA", "SIPP"]);
    expect(
      onlyAssets.netWorthCategories!.edges.every(
        (e) => e.node.__typename === "NetWorthCategoryAsset",
      ),
    ).toBe(true);

    // Equity-option kind filter.
    const onlyOptions = await runGql(list, { kinds: ["OPTION"], types: null });
    expect(sortedNames(onlyOptions)).toEqual(["RSU"]);

    // Type filter alone — STOCK + PENSION matches assets, no liability rows
    // share those names so liabilities drop out, and options have no `type`
    // column so they're excluded too.
    const stockPension = await runGql(list, {
      kinds: null,
      types: ["STOCK", "PENSION"],
    });
    expect(sortedNames(stockPension)).toEqual(["ISA", "SIPP"]);

    // Combined — kind + type filter narrows to the intersection.
    const stockOnly = await runGql(list, {
      kinds: ["ASSET"],
      types: ["STOCK"],
    });
    expect(sortedNames(stockOnly)).toEqual(["ISA"]);

    // Liability type filter — works against the liability `type` column.
    const liabilityCards = await runGql(list, {
      kinds: ["LIABILITY"],
      types: ["CREDIT_CARD"],
    });
    expect(sortedNames(liabilityCards)).toEqual(["Amex"]);

    // A type filter that none of the kept kinds can match returns nothing.
    const empty = await runGql(list, {
      kinds: ["ASSET"],
      types: ["CREDIT_CARD"],
    });
    expect(empty.netWorthCategories!.edges).toEqual([]);
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

  it("deletes an asset category when nothing references it", async () => {
    const id = await createAsset("Disposable");
    const del = graphql(`
      mutation DeleteAsset($id: ID!) {
        netWorthCategoryDelete(ref: { asset: $id }) {
          _
        }
      }
    `);
    await runGql(del, { id });
  });

  it("refuses to delete an asset referenced by a net-worth value", async () => {
    const id = await createAsset("In use");
    await runGql(
      graphql(`
        mutation SeedEntry($assetId: ID!) {
          netWorthCreate(
            date: "2026-04-15"
            values: [
              {
                asset: {
                  categoryId: $assetId
                  amounts: [{ amount: 100, currency: "GBP" }]
                }
              }
            ]
          ) {
            id
          }
        }
      `),
      { assetId: id },
    );

    const del = graphql(`
      mutation DeleteAsset($id: ID!) {
        netWorthCategoryDelete(ref: { asset: $id }) {
          _
        }
      }
    `);
    await expect(
      runGql(del, { id }),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Error: GraphQL errors: Cannot delete asset category: 1 net-worth value still references it. Remove those values first.]`,
    );
  });

  it("deletes a liability category when nothing references it", async () => {
    const id = (
      await runGql(
        graphql(`
          mutation CreateLiability {
            netWorthCategoryCreate(
              input: { liability: { name: "Unused", type: CREDIT_CARD } }
            ) {
              id
            }
          }
        `),
        {},
      )
    ).netWorthCategoryCreate.id;

    const del = graphql(`
      mutation DeleteLiability($id: ID!) {
        netWorthCategoryDelete(ref: { liability: $id }) {
          _
        }
      }
    `);
    await runGql(del, { id });
  });

  it("refuses to delete a liability referenced by a net-worth value", async () => {
    const id = (
      await runGql(
        graphql(`
          mutation CreateLiability {
            netWorthCategoryCreate(
              input: { liability: { name: "Amex", type: CREDIT_CARD } }
            ) {
              id
            }
          }
        `),
        {},
      )
    ).netWorthCategoryCreate.id;

    await runGql(
      graphql(`
        mutation SeedEntry($liabilityId: ID!) {
          netWorthCreate(
            date: "2026-04-15"
            values: [
              {
                liability: {
                  categoryId: $liabilityId
                  amounts: [{ amount: 500, currency: "GBP" }]
                }
              }
            ]
          ) {
            id
          }
        }
      `),
      { liabilityId: id },
    );

    const del = graphql(`
      mutation DeleteLiability($id: ID!) {
        netWorthCategoryDelete(ref: { liability: $id }) {
          _
        }
      }
    `);
    await expect(
      runGql(del, { id }),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Error: GraphQL errors: Cannot delete liability category: 1 net-worth value still references it. Remove those values first.]`,
    );
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

  it("rejects netWorthCreate when the month already has an entry", async () => {
    const create = graphql(`
      mutation ($a: ID!, $date: Date!) {
        netWorthCreate(
          date: $date
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
    await runGql(create, { a: assetId, date: "2029-03-01" });
    await expect(
      runGql(create, { a: assetId, date: "2029-03-28" }),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Error: GraphQL errors: A net-worth entry already exists for 2029-03. Each month can only have one entry.]`,
    );
  });

  it("rejects netWorthUpdate when the new month collides with another entry", async () => {
    const create = graphql(`
      mutation ($a: ID!, $date: Date!) {
        netWorthCreate(
          date: $date
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
    await runGql(create, { a: assetId, date: "2029-04-15" });
    const second = await runGql(create, { a: assetId, date: "2029-05-15" });

    const update = graphql(`
      mutation ($id: ID!) {
        netWorthUpdate(id: $id, date: "2029-04-20") {
          id
        }
      }
    `);
    await expect(
      runGql(update, { id: second.netWorthCreate.id }),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Error: GraphQL errors: A net-worth entry already exists for 2029-04. Each month can only have one entry.]`,
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
    expect(forward.netWorth!.edges).toHaveLength(2);
    expect(forward.netWorth!.pageInfo.hasNextPage).toBe(true);

    const endCursor = forward.netWorth!.pageInfo.endCursor!;

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
    expect(backward.netWorth!.edges.length).toBeGreaterThan(0);
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
            { base: "GBP", currency: "USD", rate: 0.77 }
            { base: "GBP", currency: "EUR", rate: 0.86 }
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
        { base: "GBP", currency: "USD", rate: 0.77 },
        { base: "GBP", currency: "EUR", rate: 0.86 },
      ]),
    );

    // Replace: keep USD (updated), drop EUR, add JPY. Covers upsert + orphan delete.
    const update = graphql(`
      mutation UpdateRates($id: ID!) {
        netWorthUpdate(
          id: $id
          currencyRates: [
            { base: "GBP", currency: "USD", rate: 0.74 }
            { base: "GBP", currency: "JPY", rate: 0.005 }
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
        { base: "GBP", currency: "USD", rate: 0.74 },
        { base: "GBP", currency: "JPY", rate: 0.005 },
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

  it("sums totalAssets, totalLiabilities and totalNet in GBP, converting foreign currencies via the entry's rates", async () => {
    const liabilityId = (
      await runGql(
        graphql(`
          mutation {
            netWorthCategoryCreate(
              input: { liability: { name: "Amex", type: CREDIT_CARD } }
            ) {
              id
            }
          }
        `),
        {},
      )
    ).netWorthCategoryCreate.id;

    const create = graphql(`
      mutation CreateEntry($a: ID!, $l: ID!) {
        netWorthCreate(
          date: "2026-04-15"
          values: [
            {
              asset: {
                categoryId: $a
                amounts: [
                  { amount: 5000, currency: "GBP" }
                  { amount: 1250, currency: "USD" }
                ]
              }
            }
            {
              liability: {
                categoryId: $l
                amounts: [{ amount: 200, currency: "GBP" }]
              }
            }
          ]
          currencyRates: [{ base: "GBP", currency: "USD", rate: 0.8 }]
        ) {
          id
          totalAssets {
            amount
            currency
          }
          totalLiabilities {
            amount
            currency
          }
          totalNet {
            amount
            currency
          }
        }
      }
    `);
    const data = await runGql(create, { a: assetId, l: liabilityId });
    expect(data.netWorthCreate).toMatchObject({
      totalAssets: { amount: 6000, currency: "GBP" },
      totalLiabilities: { amount: 200, currency: "GBP" },
      totalNet: { amount: 5800, currency: "GBP" },
    });
  });

  it("treats signed liability amounts as magnitudes so net worth stays assets − liabilities", async () => {
    // Real data stores liability balances signed (typically negative — "you
    // owe £X" entered as -X). Regardless of sign, the aggregate totals
    // should report a positive liability magnitude and subtract it from
    // assets when computing net worth.
    const liabilityId = (
      await runGql(
        graphql(`
          mutation {
            netWorthCategoryCreate(
              input: {
                liability: { name: "Mortgage", type: LOAN, interestRate: 5 }
              }
            ) {
              id
            }
          }
        `),
        {},
      )
    ).netWorthCategoryCreate.id;

    const create = graphql(`
      mutation ($a: ID!, $l: ID!) {
        netWorthCreate(
          date: "2026-04-15"
          values: [
            {
              asset: {
                categoryId: $a
                amounts: [{ amount: 500000, currency: "GBP" }]
              }
            }
            {
              liability: {
                categoryId: $l
                amounts: [{ amount: -300000, currency: "GBP" }]
              }
            }
          ]
        ) {
          totalAssets {
            amount
          }
          totalLiabilities {
            amount
          }
          totalNet {
            amount
          }
        }
      }
    `);
    const data = await runGql(create, { a: assetId, l: liabilityId });
    expect(data.netWorthCreate).toMatchObject({
      totalAssets: { amount: 500000 },
      totalLiabilities: { amount: 300000 },
      totalNet: { amount: 200000 },
    });
  });
});

describe("netWorthHistory", () => {
  it("folds credit cards into cash, keeps real liabilities, and buckets assets by type", async () => {
    const seed = graphql(`
      mutation Seed {
        cash: netWorthCategoryCreate(
          input: { asset: { name: "Current", type: CASH } }
        ) {
          id
        }
        stock: netWorthCategoryCreate(
          input: { asset: { name: "ISA", type: STOCK } }
        ) {
          id
        }
        cc: netWorthCategoryCreate(
          input: { liability: { name: "Amex", type: CREDIT_CARD } }
        ) {
          id
        }
        loan: netWorthCategoryCreate(
          input: {
            liability: { name: "Mortgage", type: LOAN, interestRate: 5 }
          }
        ) {
          id
        }
        opt: netWorthCategoryCreate(input: { option: { name: "RSUs" } }) {
          id
        }
      }
    `);
    const ids = await runGql(seed, {});
    const cashId: string = ids.cash.id;
    const stockId: string = ids.stock.id;
    const ccId: string = ids.cc.id;
    const loanId: string = ids.loan.id;
    const optId: string = ids.opt.id;

    const createEntry = graphql(`
      mutation Entry(
        $date: Date!
        $cash: ID!
        $stock: ID!
        $cc: ID!
        $loan: ID!
        $opt: ID!
        $cashAmt: Float!
        $stockAmt: Float!
        $ccAmt: Float!
        $loanAmt: Float!
        $optAmt: Float!
      ) {
        netWorthCreate(
          date: $date
          values: [
            {
              asset: {
                categoryId: $cash
                amounts: [{ amount: $cashAmt, currency: "GBP" }]
              }
            }
            {
              asset: {
                categoryId: $stock
                amounts: [{ amount: $stockAmt, currency: "GBP" }]
              }
            }
            {
              liability: {
                categoryId: $cc
                amounts: [{ amount: $ccAmt, currency: "GBP" }]
              }
            }
            {
              liability: {
                categoryId: $loan
                amounts: [{ amount: $loanAmt, currency: "GBP" }]
              }
            }
            {
              option: {
                categoryId: $opt
                amounts: [{ amount: $optAmt, currency: "GBP" }]
              }
            }
          ]
        ) {
          id
        }
      }
    `);

    await runGql(createEntry, {
      date: "2026-02-15",
      cash: cashId,
      stock: stockId,
      cc: ccId,
      loan: loanId,
      opt: optId,
      cashAmt: 1000,
      stockAmt: 2000,
      ccAmt: 100,
      loanAmt: 300,
      optAmt: 500,
    });
    await runGql(createEntry, {
      date: "2026-03-15",
      cash: cashId,
      stock: stockId,
      cc: ccId,
      loan: loanId,
      opt: optId,
      cashAmt: 1500,
      stockAmt: 2500,
      ccAmt: 150,
      loanAmt: 250,
      optAmt: 600,
    });

    const data = await runGql(
      graphql(`
        query {
          netWorthHistory {
            date
            assetsByType {
              type
              amount {
                amount
              }
            }
            assets {
              amount
            }
            liabilities {
              amount
            }
            net {
              amount
            }
          }
        }
      `),
      {},
    );

    // Credit card folds into CASH (1000 − 100 = 900), the loan stays a
    // liability, and net = assets − liabilities is unchanged by the fold.
    expect(data.netWorthHistory).toMatchInlineSnapshot(`
      [
        {
          "assets": {
            "amount": 3400,
          },
          "assetsByType": [
            {
              "amount": {
                "amount": 900,
              },
              "type": "CASH",
            },
            {
              "amount": {
                "amount": 500,
              },
              "type": "OPTION",
            },
            {
              "amount": {
                "amount": 2000,
              },
              "type": "STOCK",
            },
          ],
          "date": "2026-02-15",
          "liabilities": {
            "amount": 300,
          },
          "net": {
            "amount": 3100,
          },
        },
        {
          "assets": {
            "amount": 4450,
          },
          "assetsByType": [
            {
              "amount": {
                "amount": 1350,
              },
              "type": "CASH",
            },
            {
              "amount": {
                "amount": 600,
              },
              "type": "OPTION",
            },
            {
              "amount": {
                "amount": 2500,
              },
              "type": "STOCK",
            },
          ],
          "date": "2026-03-15",
          "liabilities": {
            "amount": 250,
          },
          "net": {
            "amount": 4200,
          },
        },
      ]
    `);
  });
});

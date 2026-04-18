import { graphql, runGql } from "#test/gql";

async function createAsset(name = "Current"): Promise<string> {
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

const ukRates = {
  rateBasic: 0.2,
  rateHigher: 0.4,
  rateAdditional: 0.45,
  thresholdBasic: 1_257_000,
  thresholdHigher: 5_027_000,
  thresholdAdditional: 12_500_000,
  rateNicMain: 0.08,
  rateNicAdditional: 0.02,
  thresholdNicPrimary: 1_257_000,
  thresholdNicUpperEarnings: 5_027_000,
  rateStudentLoanPlan2: 0.09,
  thresholdStudentLoanPlan2: 2_729_500,
  thresholdPersonalAllowanceTaper: 10_000_000,
};

describe("planningYearSet", () => {
  it("creates a year with 12 months (April → March) and attaches UK tax rates", async () => {
    const doc = graphql(`
      mutation ($year: ID!, $rates: PlanningYearTaxRatesUKInput!) {
        planningYearSet(year: $year, taxRates: { uk: $rates }) {
          id
          months {
            id
            date
          }
          taxRates {
            ... on PlanningYearTaxRatesUK {
              rateBasic
              rateHigher
              thresholdBasic
            }
          }
        }
      }
    `);
    const data = await runGql(doc, { year: "2025", rates: ukRates });
    expect(data.planningYearSet.id).toBe("2025");
    expect(data.planningYearSet.months).toHaveLength(12);
    expect(data.planningYearSet.months[0]).toMatchObject({
      id: "apr-2025",
      date: "2025-04-01",
    });
    expect(data.planningYearSet.months[11]).toMatchObject({
      id: "mar-2026",
      date: "2026-03-01",
    });
    expect(data.planningYearSet.taxRates).toMatchObject({
      rateBasic: 0.2,
      rateHigher: 0.4,
      thresholdBasic: 1_257_000,
    });
  });

  it("is idempotent — a second call updates the rates without duplicating months", async () => {
    const doc = graphql(`
      mutation ($year: ID!, $rates: PlanningYearTaxRatesUKInput!) {
        planningYearSet(year: $year, taxRates: { uk: $rates }) {
          months {
            id
          }
          taxRates {
            ... on PlanningYearTaxRatesUK {
              rateBasic
            }
          }
        }
      }
    `);
    await runGql(doc, { year: "2025", rates: ukRates });
    const second = await runGql(doc, {
      year: "2025",
      rates: { ...ukRates, rateBasic: 0.22 },
    });
    expect(second.planningYearSet.months).toHaveLength(12);
    expect(second.planningYearSet.taxRates).toMatchObject({ rateBasic: 0.22 });
  });

  it("works without tax rates", async () => {
    const doc = graphql(`
      mutation ($year: ID!) {
        planningYearSet(year: $year) {
          id
          taxRates {
            __typename
          }
        }
      }
    `);
    const data = await runGql(doc, { year: "2024" });
    expect(data.planningYearSet.id).toBe("2024");
    expect(data.planningYearSet.taxRates).toBeNull();
  });
});

describe("planningYears / planningYear queries", () => {
  // Clock is frozen at 2026-04-18 in test/setup.ts → today's UK FY is 2026.
  const listDoc = graphql(`
    query ($first: Int, $after: ID, $last: Int, $before: ID) {
      planningYears(
        first: $first
        after: $after
        last: $last
        before: $before
      ) {
        edges {
          node {
            id
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

  it("returns today's FY plus the 5-FY future horizon when there are no net-worth entries", async () => {
    const data = await runGql(listDoc, { first: 10 });
    expect(data.planningYears!.edges.map((e) => e.node.id))
      .toMatchInlineSnapshot(`
      [
        "2026",
        "2027",
        "2028",
        "2029",
        "2030",
        "2031",
      ]
    `);
    expect(data.planningYears!.pageInfo).toMatchObject({
      hasNextPage: false,
      hasPreviousPage: false,
    });
  });

  it("spans from the earliest NW entry's FY up to 5 FYs past today, ascending, and paginates forward with first/after", async () => {
    // Seed net-worth entries at 2020-01 (FY19) and 2024-06 (FY24).
    await runGql(
      graphql(`
        mutation {
          a: netWorthCreate(date: "2020-01-15", values: []) {
            id
          }
          b: netWorthCreate(date: "2024-06-15", values: []) {
            id
          }
        }
      `),
      {},
    );
    const page1 = await runGql(listDoc, { first: 3 });
    expect(page1.planningYears!.edges.map((e) => e.node.id))
      .toMatchInlineSnapshot(`
      [
        "2019",
        "2020",
        "2021",
      ]
    `);
    expect(page1.planningYears!.pageInfo).toMatchObject({
      hasNextPage: true,
      hasPreviousPage: false,
    });

    const page2 = await runGql(listDoc, {
      first: 100,
      after: page1.planningYears!.pageInfo.endCursor!,
    });
    expect(page2.planningYears!.edges.map((e) => e.node.id))
      .toMatchInlineSnapshot(`
      [
        "2022",
        "2023",
        "2024",
        "2025",
        "2026",
        "2027",
        "2028",
        "2029",
        "2030",
        "2031",
      ]
    `);
    expect(page2.planningYears!.pageInfo).toMatchObject({
      hasNextPage: false,
      hasPreviousPage: true,
    });
  });

  it("paginates backward with last/before", async () => {
    await runGql(
      graphql(`
        mutation {
          a: netWorthCreate(date: "2020-01-15", values: []) {
            id
          }
        }
      `),
      {},
    );
    // Tail of the range, newest 3 items (still returned ascending).
    const tail = await runGql(listDoc, { last: 3 });
    expect(tail.planningYears!.edges.map((e) => e.node.id))
      .toMatchInlineSnapshot(`
      [
        "2029",
        "2030",
        "2031",
      ]
    `);
    expect(tail.planningYears!.pageInfo).toMatchObject({
      hasNextPage: false,
      hasPreviousPage: true,
    });

    // Step backward before the tail's first item.
    const prev = await runGql(listDoc, {
      last: 3,
      before: tail.planningYears!.pageInfo.startCursor!,
    });
    expect(prev.planningYears!.edges.map((e) => e.node.id))
      .toMatchInlineSnapshot(`
      [
        "2026",
        "2027",
        "2028",
      ]
    `);
    expect(prev.planningYears!.pageInfo).toMatchObject({
      hasNextPage: true,
      hasPreviousPage: true,
    });
  });

  it("synthesises a year with 12 months when no PlanningYears row exists", async () => {
    const data = await runGql(
      graphql(`
        query {
          planningYear(id: "2099") {
            id
            months {
              id
            }
            taxRates {
              __typename
            }
          }
        }
      `),
      {},
    );
    expect(data.planningYear!.id).toBe("2099");
    expect(data.planningYear!.months).toHaveLength(12);
    expect(data.planningYear!.months[0].id).toBe("apr-2099");
    expect(data.planningYear!.months[11].id).toBe("mar-2100");
    expect(data.planningYear!.taxRates).toBeNull();
  });

  it("returns null only for ids that aren't 4-digit years", async () => {
    const data = await runGql(
      graphql(`
        query ($id: ID!) {
          planningYear(id: $id) {
            id
          }
        }
      `),
      { id: "not-a-year" },
    );
    expect(data.planningYear).toBeNull();
  });
});

describe("planningAccountAssign / Unassign", () => {
  it("assigns an asset with an alias and surfaces it via PlanningYear.accounts", async () => {
    const assetId = await createAsset("Savings");
    await runGql(
      graphql(`
        mutation {
          planningYearSet(year: "2025") {
            id
          }
        }
      `),
      {},
    );

    const assigned = await runGql(
      graphql(`
        mutation ($id: ID!, $alias: String) {
          planningAccountAssign(assetId: $id, alias: $alias) {
            id
            name
            asset {
              id
              name
            }
          }
        }
      `),
      { id: assetId, alias: "Main" },
    );
    expect(assigned.planningAccountAssign).toMatchObject({
      id: assetId,
      name: "Main",
      asset: { id: assetId, name: "Savings" },
    });

    const year = await runGql(
      graphql(`
        query {
          planningYear(id: "2025") {
            accounts {
              id
              name
            }
            months {
              accounts {
                id
                name
              }
            }
          }
        }
      `),
      {},
    );
    expect(year.planningYear!.accounts).toEqual([
      { id: assetId, name: "Main" },
    ]);
    // PlanningMonthAccount.id composes as "mon-YYYY::<assetId>"
    expect(year.planningYear!.months[0].accounts[0]).toMatchObject({
      id: `apr-2025::${assetId}`,
      name: "Main",
    });
  });

  it("updating an alias via re-assign, then falling back to the asset name when cleared", async () => {
    const assetId = await createAsset("Broker");
    await runGql(
      graphql(`
        mutation {
          planningYearSet(year: "2025") {
            id
          }
        }
      `),
      {},
    );
    await runGql(
      graphql(`
        mutation ($id: ID!) {
          planningAccountAssign(assetId: $id, alias: "Initial") {
            id
            name
          }
        }
      `),
      { id: assetId },
    );
    const updated = await runGql(
      graphql(`
        mutation ($id: ID!) {
          planningAccountAssign(assetId: $id) {
            name
          }
        }
      `),
      { id: assetId },
    );
    expect(updated.planningAccountAssign.name).toBe("Broker");

    const monthAccount = await runGql(
      graphql(`
        query {
          planningYear(id: "2025") {
            months {
              accounts {
                name
              }
            }
          }
        }
      `),
      {},
    );
    // name coalesces to the asset's name now that the alias is cleared
    expect(monthAccount.planningYear!.months[0].accounts[0].name).toBe(
      "Broker",
    );
  });

  it("unassign removes the account (idempotent)", async () => {
    const assetId = await createAsset("Temp");
    await runGql(
      graphql(`
        mutation {
          planningYearSet(year: "2025") {
            id
          }
        }
      `),
      {},
    );
    await runGql(
      graphql(`
        mutation ($id: ID!) {
          planningAccountAssign(assetId: $id) {
            id
          }
        }
      `),
      { id: assetId },
    );
    await runGql(
      graphql(`
        mutation ($id: ID!) {
          planningAccountUnassign(assetId: $id) {
            _
          }
        }
      `),
      { id: assetId },
    );
    // second call is a no-op
    await runGql(
      graphql(`
        mutation ($id: ID!) {
          planningAccountUnassign(assetId: $id) {
            _
          }
        }
      `),
      { id: assetId },
    );

    const year = await runGql(
      graphql(`
        query {
          planningYear(id: "2025") {
            accounts {
              id
            }
          }
        }
      `),
      {},
    );
    expect(year.planningYear!.accounts).toEqual([]);
  });
});

describe("planningYearCurrent", () => {
  // Clock frozen at 2026-04-18 (post-6-Apr cutover) → today's UK FY is 2026.
  const currentDoc = graphql(`
    query {
      planningYearCurrent {
        id
        months {
          id
        }
        taxRates {
          __typename
        }
      }
    }
  `);

  it("returns today's UK FY synthetically when no data has been stored", async () => {
    const data = await runGql(currentDoc, {});
    expect(data.planningYearCurrent!.id).toMatchInlineSnapshot(`"2026"`);
    expect(data.planningYearCurrent!.months).toHaveLength(12);
    expect(data.planningYearCurrent!.months[0].id).toMatchInlineSnapshot(
      `"apr-2026"`,
    );
    expect(data.planningYearCurrent!.taxRates).toBeNull();
  });

  it("picks up tax rates once a matching PlanningYears row has been written", async () => {
    await runGql(
      graphql(`
        mutation ($rates: PlanningYearTaxRatesUKInput!) {
          planningYearSet(year: "2026", taxRates: { uk: $rates }) {
            id
          }
        }
      `),
      { rates: ukRates },
    );
    const data = await runGql(currentDoc, {});
    expect(data.planningYearCurrent!.id).toBe("2026");
    expect(data.planningYearCurrent!.taxRates).toEqual({
      __typename: "PlanningYearTaxRatesUK",
    });
  });
});

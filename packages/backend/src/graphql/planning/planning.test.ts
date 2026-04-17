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
  it("lists configured years and resolves a single year by id", async () => {
    await runGql(
      graphql(`
        mutation {
          a: planningYearSet(year: "2023") {
            id
          }
          b: planningYearSet(year: "2024") {
            id
          }
        }
      `),
      {},
    );
    const list = await runGql(
      graphql(`
        query {
          planningYears {
            id
          }
        }
      `),
      {},
    );
    expect(list.planningYears!.map((y) => y.id)).toEqual(["2023", "2024"]);

    const single = await runGql(
      graphql(`
        query ($id: ID!) {
          planningYear(id: $id) {
            id
          }
        }
      `),
      { id: "2023" },
    );
    expect(single.planningYear!.id).toBe("2023");

    const missing = await runGql(
      graphql(`
        query ($id: ID!) {
          planningYear(id: $id) {
            id
          }
        }
      `),
      { id: "9999" },
    );
    expect(missing.planningYear).toBeNull();
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

import "@/index";

import { db } from "@/db";
import { PlanningEarnings } from "@/db/schema/planning";
import { formatTable } from "#test/format-table";
import { graphql, runGql } from "#test/gql";

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

async function createAsset(name = "Main"): Promise<string> {
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

async function seedYear(year = "2025"): Promise<void> {
  await runGql(
    graphql(`
      mutation ($y: ID!, $rates: PlanningYearTaxRatesUKInput!) {
        planningYearSet(year: $y, taxRates: { uk: $rates }) {
          id
        }
      }
    `),
    { y: year, rates: ukRates },
  );
}

async function assign(assetId: string, alias = "Main"): Promise<void> {
  await runGql(
    graphql(`
      mutation ($id: ID!, $alias: String) {
        planningAccountAssign(assetId: $id, alias: $alias) {
          id
        }
      }
    `),
    { id: assetId, alias },
  );
}

async function balanceTable(year: string): Promise<string> {
  const data = await runGql(
    graphql(`
      query ($y: ID!) {
        planningYear(id: $y) {
          months {
            id
            accounts {
              name
              valueStart {
                amount
              }
              valueEnd {
                amount
              }
            }
          }
        }
      }
    `),
    { y: year },
  );
  return formatTable(
    ["MONTH", "ACCOUNT", "VALUE START", "VALUE END"],
    data.planningYear!.months.flatMap((m) =>
      m.accounts.map((a) => [
        m.id,
        a.name,
        a.valueStart.amount,
        a.valueEnd.amount,
      ]),
    ),
  );
}

async function recordSnapshot(
  assetId: string,
  date: string,
  minor: number,
): Promise<void> {
  await runGql(
    graphql(`
      mutation ($d: Date!, $a: ID!, $amount: Float!) {
        netWorthCreate(
          date: $d
          values: [
            {
              asset: {
                categoryId: $a
                amounts: [{ amount: $amount, currency: "GBP" }]
              }
            }
          ]
        ) {
          id
        }
      }
    `),
    { d: date, a: assetId, amount: minor / 100 },
  );
}

async function firstEarningId(): Promise<string> {
  const [e] = await db.select().from(PlanningEarnings);
  return e.id;
}

it("earningsCreate projects a monthly take-home into valueEnd from the start month onwards", async () => {
  await seedYear();
  const accountIdTo = await createAsset();
  await assign(accountIdTo);
  await recordSnapshot(accountIdTo, "2025-03-31", 1_000_000);

  await runGql(
    graphql(`
      mutation ($a: ID!) {
        earningsCreate(
          name: "Day job"
          start: "2025-04-01"
          amountGross: { amount: 30000, currency: "GBP" }
          countryCode: "GB"
          pensionReliefAtSource: 0
          pensionNetPay: 0
          toAccountId: $a
        ) {
          id
        }
      }
    `),
    { a: accountIdTo },
  );
  expect(await balanceTable("2025")).toMatchInlineSnapshot(`
    "
    MONTH    ACCOUNT VALUE START VALUE END
    apr-2025 Main    10000       12093.3  
    may-2025 Main    12093.3     14186.6  
    jun-2025 Main    14186.6     16279.9  
    jul-2025 Main    16279.9     18373.2  
    aug-2025 Main    18373.2     20466.5  
    sep-2025 Main    20466.5     22559.8  
    oct-2025 Main    22559.8     24653.1  
    nov-2025 Main    24653.1     26746.4  
    dec-2025 Main    26746.4     28839.7  
    jan-2026 Main    28839.7     30933    
    feb-2026 Main    30933       33026.3  
    mar-2026 Main    33026.3     35119.6  "
  `);
});

it("earningsUpdate reprojects balances when the gross changes", async () => {
  await seedYear();
  const accountIdTo = await createAsset();
  await assign(accountIdTo);
  await recordSnapshot(accountIdTo, "2025-03-31", 1_000_000);

  await runGql(
    graphql(`
      mutation ($a: ID!) {
        earningsCreate(
          name: "Day job"
          start: "2025-04-01"
          amountGross: { amount: 30000, currency: "GBP" }
          countryCode: "GB"
          pensionReliefAtSource: 0
          pensionNetPay: 0
          toAccountId: $a
        ) {
          id
        }
      }
    `),
    { a: accountIdTo },
  );

  const earningId = await firstEarningId();

  await runGql(
    graphql(`
      mutation ($id: ID!) {
        earningsUpdate(
          id: $id
          amountGross: { amount: 60000, currency: "GBP" }
        ) {
          id
        }
      }
    `),
    { id: earningId },
  );
  expect(await balanceTable("2025")).toMatchInlineSnapshot(`
    "
    MONTH    ACCOUNT VALUE START VALUE END
    apr-2025 Main    10000       13779.78 
    may-2025 Main    13779.78    17559.56 
    jun-2025 Main    17559.56    21339.34 
    jul-2025 Main    21339.34    25119.12 
    aug-2025 Main    25119.12    28898.9  
    sep-2025 Main    28898.9     32678.68 
    oct-2025 Main    32678.68    36458.46 
    nov-2025 Main    36458.46    40238.24 
    dec-2025 Main    40238.24    44018.02 
    jan-2026 Main    44018.02    47797.8  
    feb-2026 Main    47797.8     51577.58 
    mar-2026 Main    51577.58    55357.36 "
  `);
});

it("earningsDelete restores balances to the baseline", async () => {
  await seedYear();
  const accountIdTo = await createAsset();
  await assign(accountIdTo);
  await recordSnapshot(accountIdTo, "2025-03-31", 1_000_000);

  await runGql(
    graphql(`
      mutation ($a: ID!) {
        earningsCreate(
          name: "Day job"
          start: "2025-04-01"
          amountGross: { amount: 30000, currency: "GBP" }
          countryCode: "GB"
          pensionReliefAtSource: 0
          pensionNetPay: 0
          toAccountId: $a
        ) {
          id
        }
      }
    `),
    { a: accountIdTo },
  );
  const earningId = await firstEarningId();

  await runGql(
    graphql(`
      mutation ($id: ID!) {
        earningsDelete(id: $id) {
          _
        }
      }
    `),
    { id: earningId },
  );
  expect(await balanceTable("2025")).toMatchInlineSnapshot(`
    "
    MONTH    ACCOUNT VALUE START VALUE END
    apr-2025 Main    10000       10000    
    may-2025 Main    10000       10000    
    jun-2025 Main    10000       10000    
    jul-2025 Main    10000       10000    
    aug-2025 Main    10000       10000    
    sep-2025 Main    10000       10000    
    oct-2025 Main    10000       10000    
    nov-2025 Main    10000       10000    
    dec-2025 Main    10000       10000    
    jan-2026 Main    10000       10000    
    feb-2026 Main    10000       10000    
    mar-2026 Main    10000       10000    "
  `);
});

it("attributes field joins active pension and student-loan flags human-readably", async () => {
  await seedYear();
  const accountIdTo = await createAsset();
  await assign(accountIdTo);

  await runGql(
    graphql(`
      mutation ($a: ID!) {
        earningsCreate(
          name: "With attributes"
          start: "2025-04-01"
          amountGross: { amount: 60000, currency: "GBP" }
          countryCode: "GB"
          pensionReliefAtSource: 0.02
          pensionNetPay: 0.03
          pensionSalarySacrifice: 0.05
          studentLoanPlan2: true
          toAccountId: $a
        ) {
          id
        }
      }
    `),
    { a: accountIdTo },
  );

  const data = await runGql(
    graphql(`
      query {
        earnings {
          edges {
            node {
              name
              attributes
            }
          }
        }
      }
    `),
    {},
  );

  expect(data.earnings!.edges.map((e) => e.node)).toMatchInlineSnapshot(`
    [
      {
        "attributes": "5% salary sacrifice, 3% net pay pension, 2% relief-at-source pension, student loan plan 2",
        "name": "With attributes",
      },
    ]
  `);
});

it("Query.earnings returns rows sorted by start date descending, paginated", async () => {
  await seedYear();
  const accountIdTo = await createAsset();
  await assign(accountIdTo);

  // Insert in arbitrary order so the sort is actually exercised.
  for (const [name, start] of [
    ["second", "2025-07-01"],
    ["oldest", "2025-04-01"],
    ["newest", "2025-10-01"],
    ["third", "2025-06-01"],
  ] as const) {
    await runGql(
      graphql(`
        mutation ($a: ID!, $n: String!, $s: Date!) {
          earningsCreate(
            name: $n
            start: $s
            amountGross: { amount: 10000, currency: "GBP" }
            countryCode: "GB"
            pensionReliefAtSource: 0
            pensionNetPay: 0
            toAccountId: $a
          ) {
            id
          }
        }
      `),
      { a: accountIdTo, n: name, s: start },
    );
  }

  const page1 = await runGql(
    graphql(`
      query {
        earnings(first: 2) {
          edges {
            cursor
            node {
              name
              start
            }
          }
          pageInfo {
            hasNextPage
            hasPreviousPage
          }
        }
      }
    `),
    {},
  );
  expect(page1.earnings!.edges.map((e) => e.node.name)).toEqual([
    "newest",
    "second",
  ]);
  expect(page1.earnings!.pageInfo).toMatchObject({
    hasNextPage: true,
    hasPreviousPage: false,
  });

  const page2 = await runGql(
    graphql(`
      query ($after: ID!) {
        earnings(first: 2, after: $after) {
          edges {
            node {
              name
              start
            }
          }
          pageInfo {
            hasNextPage
            hasPreviousPage
          }
        }
      }
    `),
    { after: page1.earnings!.edges.at(-1)!.cursor },
  );
  expect(page2.earnings!.edges.map((e) => e.node.name)).toEqual([
    "third",
    "oldest",
  ]);
  expect(page2.earnings!.pageInfo).toMatchObject({
    hasNextPage: false,
    hasPreviousPage: true,
  });
});

it("earningsCreate stores studentLoanLiabilityId when plan 2 is true, and rejects it otherwise", async () => {
  await seedYear();
  const accountIdTo = await createAsset();
  await assign(accountIdTo);

  const liability = await runGql(
    graphql(`
      mutation {
        netWorthCategoryCreate(
          input: { liability: { name: "SLC", type: LOAN, interestRate: 0.07 } }
        ) {
          id
        }
      }
    `),
    {},
  );
  const liabilityId = liability.netWorthCategoryCreate.id;

  // Setting the liability without plan 2 enabled is rejected.
  await expect(
    runGql(
      graphql(`
        mutation ($a: ID!, $l: ID!) {
          earningsCreate(
            name: "Day job"
            start: "2025-04-01"
            amountGross: { amount: 30000, currency: "GBP" }
            countryCode: "GB"
            pensionReliefAtSource: 0
            pensionNetPay: 0
            toAccountId: $a
            studentLoanLiabilityId: $l
          ) {
            id
          }
        }
      `),
      { a: accountIdTo, l: liabilityId },
    ),
  ).rejects.toThrowErrorMatchingInlineSnapshot(
    `[Error: GraphQL errors: studentLoanLiabilityId may only be set when studentLoanPlan2 is true]`,
  );

  // With plan 2 enabled the link is persisted and exposed on the type.
  await runGql(
    graphql(`
      mutation ($a: ID!, $l: ID!) {
        earningsCreate(
          name: "Day job"
          start: "2025-04-01"
          amountGross: { amount: 30000, currency: "GBP" }
          countryCode: "GB"
          pensionReliefAtSource: 0
          pensionNetPay: 0
          toAccountId: $a
          studentLoanPlan2: true
          studentLoanLiabilityId: $l
        ) {
          id
        }
      }
    `),
    { a: accountIdTo, l: liabilityId },
  );

  const list = await runGql(
    graphql(`
      query {
        earnings(first: 1) {
          edges {
            node {
              studentLoanPlan2
              studentLoanLiability {
                id
                name
              }
            }
          }
        }
      }
    `),
    {},
  );
  expect(list.earnings!.edges[0].node.studentLoanPlan2).toBe(true);
  expect(list.earnings!.edges[0].node.studentLoanLiability).toEqual({
    id: liabilityId,
    name: "SLC",
  });
});

it("earningsUpdate rejects setting a student-loan liability while plan 2 stays false", async () => {
  await seedYear();
  const accountIdTo = await createAsset();
  await assign(accountIdTo);

  const liability = await runGql(
    graphql(`
      mutation {
        netWorthCategoryCreate(
          input: { liability: { name: "SLC", type: LOAN, interestRate: 0.07 } }
        ) {
          id
        }
      }
    `),
    {},
  );
  const liabilityId = liability.netWorthCategoryCreate.id;

  const earning = await runGql(
    graphql(`
      mutation ($a: ID!) {
        earningsCreate(
          name: "Day job"
          start: "2025-04-01"
          amountGross: { amount: 30000, currency: "GBP" }
          countryCode: "GB"
          pensionReliefAtSource: 0
          pensionNetPay: 0
          toAccountId: $a
        ) {
          id
        }
      }
    `),
    { a: accountIdTo },
  );

  await expect(
    runGql(
      graphql(`
        mutation ($id: ID!, $l: ID!) {
          earningsUpdate(id: $id, studentLoanLiabilityId: $l) {
            id
          }
        }
      `),
      { id: earning.earningsCreate.id, l: liabilityId },
    ),
  ).rejects.toThrowErrorMatchingInlineSnapshot(
    `[Error: GraphQL errors: studentLoanLiabilityId may only be set when studentLoanPlan2 is true]`,
  );
});

it("materialising an earnings deduction copies studentLoanLiabilityId onto the SL payslip adjustment", async () => {
  await seedYear();
  const main = await createAsset();
  await assign(main);
  await recordSnapshot(main, "2025-03-31", 1_000_000);

  const liability = await runGql(
    graphql(`
      mutation {
        netWorthCategoryCreate(
          input: { liability: { name: "SLC", type: LOAN, interestRate: 0.07 } }
        ) {
          id
        }
      }
    `),
    {},
  );
  const liabilityId = liability.netWorthCategoryCreate.id;

  await runGql(
    graphql(`
      mutation ($a: ID!, $l: ID!) {
        earningsCreate(
          name: "Day job"
          start: "2025-04-01"
          amountGross: { amount: 60000, currency: "GBP" }
          countryCode: "GB"
          pensionReliefAtSource: 0
          pensionNetPay: 0
          toAccountId: $a
          studentLoanPlan2: true
          studentLoanLiabilityId: $l
        ) {
          id
        }
      }
    `),
    { a: main, l: liabilityId },
  );

  // Find the predicted student-loan line and trigger materialisation.
  const month = await runGql(
    graphql(`
      query {
        planningYear(id: "2025") {
          months {
            id
            accounts {
              transactions {
                id
                liabilityId
                name
              }
            }
          }
        }
      }
    `),
    {},
  );
  const apr = month.planningYear!.months.find((m) => m.id === "apr-2025")!;
  const sl = apr.accounts[0].transactions.find((t) =>
    t.name.endsWith("student loan"),
  )!;
  expect(sl.liabilityId).toBe(liabilityId);

  await runGql(
    graphql(`
      mutation ($id: ID!) {
        transactionUpdate(
          monthId: "apr-2025"
          id: $id
          amount: { amount: 300, currency: "GBP" }
        ) {
          id
        }
      }
    `),
    { id: sl.id },
  );

  const after = await runGql(
    graphql(`
      query {
        planningYear(id: "2025") {
          months {
            id
            accounts {
              transactions {
                liabilityId
                name
              }
            }
          }
        }
      }
    `),
    {},
  );
  const aprAfter = after.planningYear!.months.find((m) => m.id === "apr-2025")!;
  const slAdj = aprAfter.accounts[0].transactions.find((t) =>
    t.name.endsWith("student loan"),
  )!;
  expect(slAdj.liabilityId).toBe(liabilityId);
});

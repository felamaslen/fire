import "@/index";

import { db } from "@/db";
import { PlanningBills } from "@/db/schema/planning";
import { formatTable } from "#test/format-table";
import { graphql, runGql } from "#test/gql";

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
      mutation ($y: ID!) {
        planningYearSet(year: $y) {
          id
        }
      }
    `),
    { y: year },
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

/** Full 12-month balance table for a year, formatted so mutation diffs read at a glance. */
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

/** Record a NetWorthEntries snapshot for the asset at `date` with `minor` pence. */
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

async function firstBillId(): Promise<string> {
  const [b] = await db.select().from(PlanningBills);
  return b.id;
}

it("billCreate deducts from valueEnd every month the bill collects", async () => {
  await seedYear();
  const accountIdFrom = await createAsset();
  await assign(accountIdFrom);
  await recordSnapshot(accountIdFrom, "2025-03-31", 1_000_000);

  const result = await runGql(
    graphql(`
      mutation ($a: ID!) {
        billCreate(
          start: "2025-06-01"
          frequency: MONTHLY
          collectionDate: ["15"]
          amount: { amount: 100, currency: "GBP" }
          name: "Broadband"
          fromAccountId: $a
        ) {
          id
        }
      }
    `),
    { a: accountIdFrom },
  );
  expect(result.billCreate.map((y) => y.id)).toEqual(["2025"]);

  expect(await balanceTable("2025")).toMatchInlineSnapshot(`
    "
    MONTH    ACCOUNT VALUE START VALUE END
    apr-2025 Main    10000       10000    
    may-2025 Main    10000       10000    
    jun-2025 Main    10000       9900     
    jul-2025 Main    9900        9800     
    aug-2025 Main    9800        9700     
    sep-2025 Main    9700        9600     
    oct-2025 Main    9600        9500     
    nov-2025 Main    9500        9400     
    dec-2025 Main    9400        9300     
    jan-2026 Main    9300        9200     
    feb-2026 Main    9200        9100     
    mar-2026 Main    9100        9000     "
  `);
});

it("billUpdate resizes the deduction for every collecting month", async () => {
  await seedYear();
  const accountIdFrom = await createAsset();
  await assign(accountIdFrom);
  await recordSnapshot(accountIdFrom, "2025-03-31", 1_000_000);

  await runGql(
    graphql(`
      mutation ($a: ID!) {
        billCreate(
          start: "2025-04-01"
          frequency: MONTHLY
          collectionDate: ["15"]
          amount: { amount: 100, currency: "GBP" }
          name: "Broadband"
          fromAccountId: $a
        ) {
          id
        }
      }
    `),
    { a: accountIdFrom },
  );

  const billId = await firstBillId();

  const result = await runGql(
    graphql(`
      mutation ($id: ID!) {
        billUpdate(id: $id, amount: { amount: 250, currency: "GBP" }) {
          id
        }
      }
    `),
    { id: billId },
  );
  expect(result.billUpdate.map((y) => y.id)).toEqual(["2025"]);

  expect(await balanceTable("2025")).toMatchInlineSnapshot(`
    "
    MONTH    ACCOUNT VALUE START VALUE END
    apr-2025 Main    10000       9750     
    may-2025 Main    9750        9500     
    jun-2025 Main    9500        9250     
    jul-2025 Main    9250        9000     
    aug-2025 Main    9000        8750     
    sep-2025 Main    8750        8500     
    oct-2025 Main    8500        8250     
    nov-2025 Main    8250        8000     
    dec-2025 Main    8000        7750     
    jan-2026 Main    7750        7500     
    feb-2026 Main    7500        7250     
    mar-2026 Main    7250        7000     "
  `);
});

it("billDelete restores balances to the baseline", async () => {
  await seedYear();
  const accountIdFrom = await createAsset();
  await assign(accountIdFrom);
  await recordSnapshot(accountIdFrom, "2025-03-31", 1_000_000);

  await runGql(
    graphql(`
      mutation ($a: ID!) {
        billCreate(
          start: "2025-04-01"
          frequency: MONTHLY
          collectionDate: ["15"]
          amount: { amount: 100, currency: "GBP" }
          name: "Broadband"
          fromAccountId: $a
        ) {
          id
        }
      }
    `),
    { a: accountIdFrom },
  );
  const billId = await firstBillId();

  const result = await runGql(
    graphql(`
      mutation ($id: ID!) {
        billDelete(id: $id) {
          id
        }
      }
    `),
    { id: billId },
  );
  expect(result.billDelete.map((y) => y.id)).toEqual(["2025"]);

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

it("QUARTERLY bills only deduct in the configured months", async () => {
  await seedYear();
  const accountIdFrom = await createAsset();
  await assign(accountIdFrom);
  await recordSnapshot(accountIdFrom, "2025-03-31", 1_000_000);

  await runGql(
    graphql(`
      mutation ($a: ID!) {
        billCreate(
          start: "2025-04-01"
          frequency: QUARTERLY
          collectionDate: ["4-01", "7-01", "10-01", "1-01"]
          amount: { amount: 300, currency: "GBP" }
          name: "Water"
          fromAccountId: $a
        ) {
          id
        }
      }
    `),
    { a: accountIdFrom },
  );

  expect(await balanceTable("2025")).toMatchInlineSnapshot(`
    "
    MONTH    ACCOUNT VALUE START VALUE END
    apr-2025 Main    10000       9700     
    may-2025 Main    9700        9700     
    jun-2025 Main    9700        9700     
    jul-2025 Main    9700        9400     
    aug-2025 Main    9400        9400     
    sep-2025 Main    9400        9400     
    oct-2025 Main    9400        9100     
    nov-2025 Main    9100        9100     
    dec-2025 Main    9100        9100     
    jan-2026 Main    9100        8800     
    feb-2026 Main    8800        8800     
    mar-2026 Main    8800        8800     "
  `);
});

it("a bill with end before year end only deducts up to that month", async () => {
  await seedYear();
  const accountIdFrom = await createAsset();
  await assign(accountIdFrom);
  await recordSnapshot(accountIdFrom, "2025-03-31", 1_000_000);

  await runGql(
    graphql(`
      mutation ($a: ID!) {
        billCreate(
          start: "2025-04-01"
          end: "2025-07-31"
          frequency: MONTHLY
          collectionDate: ["15"]
          amount: { amount: 100, currency: "GBP" }
          name: "Short-lived"
          fromAccountId: $a
        ) {
          id
        }
      }
    `),
    { a: accountIdFrom },
  );

  expect(await balanceTable("2025")).toMatchInlineSnapshot(`
    "
    MONTH    ACCOUNT VALUE START VALUE END
    apr-2025 Main    10000       9900     
    may-2025 Main    9900        9800     
    jun-2025 Main    9800        9700     
    jul-2025 Main    9700        9600     
    aug-2025 Main    9600        9600     
    sep-2025 Main    9600        9600     
    oct-2025 Main    9600        9600     
    nov-2025 Main    9600        9600     
    dec-2025 Main    9600        9600     
    jan-2026 Main    9600        9600     
    feb-2026 Main    9600        9600     
    mar-2026 Main    9600        9600     "
  `);
});

it("skips the first month when start falls after the month's collection day", async () => {
  await seedYear();
  const accountIdFrom = await createAsset();
  await assign(accountIdFrom);
  await recordSnapshot(accountIdFrom, "2025-03-31", 1_000_000);

  // Collection day is the 10th but the bill only starts on the 20th — April
  // shouldn't collect, May onwards should.
  await runGql(
    graphql(`
      mutation ($a: ID!) {
        billCreate(
          start: "2025-04-20"
          frequency: MONTHLY
          collectionDate: ["10"]
          amount: { amount: 100, currency: "GBP" }
          name: "Late-start"
          fromAccountId: $a
        ) {
          id
        }
      }
    `),
    { a: accountIdFrom },
  );

  expect(await balanceTable("2025")).toMatchInlineSnapshot(`
    "
    MONTH    ACCOUNT VALUE START VALUE END
    apr-2025 Main    10000       10000    
    may-2025 Main    10000       9900     
    jun-2025 Main    9900        9800     
    jul-2025 Main    9800        9700     
    aug-2025 Main    9700        9600     
    sep-2025 Main    9600        9500     
    oct-2025 Main    9500        9400     
    nov-2025 Main    9400        9300     
    dec-2025 Main    9300        9200     
    jan-2026 Main    9200        9100     
    feb-2026 Main    9100        9000     
    mar-2026 Main    9000        8900     "
  `);
});

it("still collects in the start month when the collection day lands on or after start", async () => {
  await seedYear();
  const accountIdFrom = await createAsset();
  await assign(accountIdFrom);
  await recordSnapshot(accountIdFrom, "2025-03-31", 1_000_000);

  // Collection day is the 25th and the bill starts on the 15th — April should
  // collect on the 25th.
  await runGql(
    graphql(`
      mutation ($a: ID!) {
        billCreate(
          start: "2025-04-15"
          frequency: MONTHLY
          collectionDate: ["25"]
          amount: { amount: 100, currency: "GBP" }
          name: "Mid-start"
          fromAccountId: $a
        ) {
          id
        }
      }
    `),
    { a: accountIdFrom },
  );

  expect(await balanceTable("2025")).toMatchInlineSnapshot(`
    "
    MONTH    ACCOUNT VALUE START VALUE END
    apr-2025 Main    10000       9900     
    may-2025 Main    9900        9800     
    jun-2025 Main    9800        9700     
    jul-2025 Main    9700        9600     
    aug-2025 Main    9600        9500     
    sep-2025 Main    9500        9400     
    oct-2025 Main    9400        9300     
    nov-2025 Main    9300        9200     
    dec-2025 Main    9200        9100     
    jan-2026 Main    9100        9000     
    feb-2026 Main    9000        8900     
    mar-2026 Main    8900        8800     "
  `);
});

it("skips the final month when end falls before the month's collection day", async () => {
  await seedYear();
  const accountIdFrom = await createAsset();
  await assign(accountIdFrom);
  await recordSnapshot(accountIdFrom, "2025-03-31", 1_000_000);

  // Collection day is the 25th but the bill ends on the 10th — July shouldn't
  // collect, June and earlier should.
  await runGql(
    graphql(`
      mutation ($a: ID!) {
        billCreate(
          start: "2025-04-01"
          end: "2025-07-10"
          frequency: MONTHLY
          collectionDate: ["25"]
          amount: { amount: 100, currency: "GBP" }
          name: "Early-end"
          fromAccountId: $a
        ) {
          id
        }
      }
    `),
    { a: accountIdFrom },
  );

  expect(await balanceTable("2025")).toMatchInlineSnapshot(`
    "
    MONTH    ACCOUNT VALUE START VALUE END
    apr-2025 Main    10000       9900     
    may-2025 Main    9900        9800     
    jun-2025 Main    9800        9700     
    jul-2025 Main    9700        9700     
    aug-2025 Main    9700        9700     
    sep-2025 Main    9700        9700     
    oct-2025 Main    9700        9700     
    nov-2025 Main    9700        9700     
    dec-2025 Main    9700        9700     
    jan-2026 Main    9700        9700     
    feb-2026 Main    9700        9700     
    mar-2026 Main    9700        9700     "
  `);
});

it("rejects a collectionDate entry whose shape does not match the constraint regex", async () => {
  await seedYear();
  const accountIdFrom = await createAsset();
  await assign(accountIdFrom);
  await expect(
    runGql(
      graphql(`
        mutation ($a: ID!) {
          billCreate(
            start: "2025-04-01"
            frequency: MONTHLY
            collectionDate: ["not-a-date"]
            amount: { amount: 100, currency: "GBP" }
            name: "Bad"
            fromAccountId: $a
          ) {
            id
          }
        }
      `),
      { a: accountIdFrom },
    ),
  ).rejects.toThrowErrorMatchingInlineSnapshot(
    `[Error: GraphQL errors: Argument "collectionDate" on field "billCreate" at [0] does not match pattern /^(\\d{1,2}-)?\\d{1,2}$/]`,
  );
});

it("rejects an entry with an empty month (dash without a leading number)", async () => {
  await seedYear();
  const accountIdFrom = await createAsset();
  await assign(accountIdFrom);
  await expect(
    runGql(
      graphql(`
        mutation ($a: ID!) {
          billCreate(
            start: "2025-04-01"
            frequency: MONTHLY
            collectionDate: ["-15"]
            amount: { amount: 100, currency: "GBP" }
            name: "Bad"
            fromAccountId: $a
          ) {
            id
          }
        }
      `),
      { a: accountIdFrom },
    ),
  ).rejects.toThrowErrorMatchingInlineSnapshot(
    `[Error: GraphQL errors: Argument "collectionDate" on field "billCreate" at [0] does not match pattern /^(\\d{1,2}-)?\\d{1,2}$/]`,
  );
});

it("rejects a MONTHLY bill whose entry includes a month (must be bare day)", async () => {
  await seedYear();
  const accountIdFrom = await createAsset();
  await assign(accountIdFrom);
  await expect(
    runGql(
      graphql(`
        mutation ($a: ID!) {
          billCreate(
            start: "2025-04-01"
            frequency: MONTHLY
            collectionDate: ["4-15"]
            amount: { amount: 100, currency: "GBP" }
            name: "Bad"
            fromAccountId: $a
          ) {
            id
          }
        }
      `),
      { a: accountIdFrom },
    ),
  ).rejects.toThrowErrorMatchingInlineSnapshot(
    `[Error: GraphQL errors: MONTHLY collectionDate entries must be a bare day with no month, got "4-15".]`,
  );
});

it("rejects a YEARLY bill whose entry lacks a month (must be M-D)", async () => {
  await seedYear();
  const accountIdFrom = await createAsset();
  await assign(accountIdFrom);
  await expect(
    runGql(
      graphql(`
        mutation ($a: ID!) {
          billCreate(
            start: "2025-04-01"
            frequency: YEARLY
            collectionDate: ["15"]
            amount: { amount: 100, currency: "GBP" }
            name: "Bad"
            fromAccountId: $a
          ) {
            id
          }
        }
      `),
      { a: accountIdFrom },
    ),
  ).rejects.toThrowErrorMatchingInlineSnapshot(
    `[Error: GraphQL errors: YEARLY collectionDate entries must be in "M-D" form, got "15".]`,
  );
});

it("Query.bills returns rows sorted by start descending, paginated", async () => {
  await seedYear();
  const accountIdFrom = await createAsset();
  await assign(accountIdFrom);

  for (const [name, start] of [
    ["second", "2025-07-01"],
    ["oldest", "2025-04-01"],
    ["newest", "2025-10-01"],
    ["third", "2025-06-01"],
  ] as const) {
    await runGql(
      graphql(`
        mutation ($a: ID!, $n: String!, $s: Date!) {
          billCreate(
            start: $s
            frequency: MONTHLY
            collectionDate: ["15"]
            amount: { amount: 100, currency: "GBP" }
            name: $n
            fromAccountId: $a
          ) {
            id
          }
        }
      `),
      { a: accountIdFrom, n: name, s: start },
    );
  }

  const page1 = await runGql(
    graphql(`
      query {
        bills(first: 2) {
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
  expect(page1.bills!.edges.map((e) => e.node.name)).toEqual([
    "newest",
    "second",
  ]);
  expect(page1.bills!.pageInfo).toMatchObject({
    hasNextPage: true,
    hasPreviousPage: false,
  });

  const page2 = await runGql(
    graphql(`
      query ($after: ID!) {
        bills(first: 2, after: $after) {
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
    { after: page1.bills!.edges.at(-1)!.cursor },
  );
  expect(page2.bills!.edges.map((e) => e.node.name)).toEqual([
    "third",
    "oldest",
  ]);
  expect(page2.bills!.pageInfo).toMatchObject({
    hasNextPage: false,
    hasPreviousPage: true,
  });
});

// `TEST_NOW` is 2026-04-18 (FY 2026, April month). Every test here exercises
// the live `cashPosition` resolver against freshly-seeded net-worth entries +
// planning accounts / transactions / bills for that month.

import { graphql, runGql } from "#test/gql";

async function createCashAsset(name: string): Promise<string> {
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

async function createStockAsset(name: string): Promise<string> {
  const doc = graphql(`
    mutation ($name: String!) {
      netWorthCategoryCreate(input: { asset: { name: $name, type: STOCK } }) {
        id
      }
    }
  `);
  const data = await runGql(doc, { name });
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

async function recordNetWorth(
  date: string,
  values: Array<{ assetId: string; amount: number }>,
): Promise<void> {
  const doc = graphql(`
    mutation ($d: Date!, $values: [NetWorthValueInput!]!) {
      netWorthCreate(date: $d, values: $values) {
        id
      }
    }
  `);
  await runGql(doc, {
    d: date,
    values: values.map((v) => ({
      asset: {
        categoryId: v.assetId,
        amounts: [{ amount: v.amount, currency: "GBP" }],
      },
    })),
  });
}

async function recordPlanningTx(
  monthId: string,
  accountId: string,
  amount: number,
  name: string,
): Promise<void> {
  await runGql(
    graphql(`
      mutation (
        $monthId: ID!
        $amount: MoneyInput!
        $name: String!
        $accountId: ID!
      ) {
        transactionCreate(
          monthId: $monthId
          amount: $amount
          name: $name
          accountId: $accountId
        ) {
          id
        }
      }
    `),
    {
      monthId,
      amount: { amount, currency: "GBP" },
      name,
      accountId,
    },
  );
}

async function recordBill(
  fromAccountId: string,
  amount: number,
  collectionDay: string,
): Promise<void> {
  await runGql(
    graphql(`
      mutation (
        $start: Date!
        $collectionDate: [String!]!
        $amount: MoneyInput!
        $fromAccountId: ID!
      ) {
        billCreate(
          start: $start
          frequency: MONTHLY
          collectionDate: $collectionDate
          amount: $amount
          name: "Bill"
          fromAccountId: $fromAccountId
        ) {
          id
        }
      }
    `),
    {
      start: "2026-04-01",
      collectionDate: [collectionDay],
      amount: { amount, currency: "GBP" },
      fromAccountId,
    },
  );
}

async function queryCashPosition(): Promise<{
  amount: number;
  currency: string;
}> {
  const doc = graphql(`
    query {
      cashPosition {
        amount
        currency
      }
    }
  `);
  const data = await runGql(doc, {});
  return data.cashPosition;
}

it("returns zero when there are no planning cash accounts", async () => {
  expect(await queryCashPosition()).toEqual({ amount: 0, currency: "GBP" });
});

it("sums cash from the latest net-worth entry across planning cash accounts", async () => {
  const current = await createCashAsset("Current");
  const savings = await createCashAsset("Savings");
  await assignPlanningAccount(current);
  await assignPlanningAccount(savings);

  await recordNetWorth("2026-04-01", [
    { assetId: current, amount: 5000 },
    { assetId: savings, amount: 12_000 },
  ]);

  expect(await queryCashPosition()).toEqual({
    amount: 17_000,
    currency: "GBP",
  });
});

it("ignores cash assets that aren't linked to a planning account", async () => {
  const planned = await createCashAsset("Current");
  const offBooks = await createCashAsset("Shoebox");
  await assignPlanningAccount(planned);
  // `offBooks` is NOT assigned as a planning account → must be excluded.

  await recordNetWorth("2026-04-01", [
    { assetId: planned, amount: 5000 },
    { assetId: offBooks, amount: 999 },
  ]);

  expect(await queryCashPosition()).toEqual({ amount: 5000, currency: "GBP" });
});

it("ignores non-cash planning assets (e.g. stock wrappers)", async () => {
  const current = await createCashAsset("Current");
  const isa = await createStockAsset("ISA");
  await assignPlanningAccount(current);
  await assignPlanningAccount(isa);

  await recordNetWorth("2026-04-01", [
    { assetId: current, amount: 4000 },
    { assetId: isa, amount: 50_000 },
  ]);

  expect(await queryCashPosition()).toEqual({ amount: 4000, currency: "GBP" });
});

it("uses only the latest net-worth entry (not prior months)", async () => {
  const current = await createCashAsset("Current");
  await assignPlanningAccount(current);

  await recordNetWorth("2026-02-01", [{ assetId: current, amount: 9999 }]);
  await recordNetWorth("2026-04-01", [{ assetId: current, amount: 4000 }]);

  expect(await queryCashPosition()).toEqual({ amount: 4000, currency: "GBP" });
});

it("subtracts current-month planning outflows from the cash balance", async () => {
  const current = await createCashAsset("Current");
  await assignPlanningAccount(current);

  await recordNetWorth("2026-04-01", [{ assetId: current, amount: 5000 }]);
  await recordPlanningTx("apr-2026", current, -250, "Groceries");
  await recordPlanningTx("apr-2026", current, -150, "Petrol");

  expect(await queryCashPosition()).toEqual({ amount: 4600, currency: "GBP" });
});

it("ignores planning outflows from other months", async () => {
  const current = await createCashAsset("Current");
  await assignPlanningAccount(current);

  await recordNetWorth("2026-04-01", [{ assetId: current, amount: 5000 }]);
  await recordPlanningTx("mar-2026", current, -500, "Last month");
  await recordPlanningTx("may-2026", current, -500, "Next month");

  expect(await queryCashPosition()).toEqual({ amount: 5000, currency: "GBP" });
});

it("includes ad-hoc planning inflows with their sign", async () => {
  const current = await createCashAsset("Current");
  await assignPlanningAccount(current);

  await recordNetWorth("2026-04-01", [{ assetId: current, amount: 5000 }]);
  await recordPlanningTx("apr-2026", current, 800, "Bonus");
  await recordPlanningTx("apr-2026", current, -200, "Coffee");

  expect(await queryCashPosition()).toEqual({ amount: 5600, currency: "GBP" });
});

it("cancels out internal transfers between two planning cash accounts", async () => {
  const current = await createCashAsset("Current");
  const savings = await createCashAsset("Savings");
  await assignPlanningAccount(current);
  await assignPlanningAccount(savings);

  await recordNetWorth("2026-04-01", [
    { assetId: current, amount: 5000 },
    { assetId: savings, amount: 10_000 },
  ]);
  await runGql(
    graphql(`
      mutation ($from: ID!, $to: ID!) {
        transactionCreate(
          monthId: "apr-2026"
          amount: { amount: -1000, currency: "GBP" }
          name: "Sweep"
          accountId: $from
          toAccountId: $to
        ) {
          id
        }
      }
    `),
    { from: current, to: savings },
  );

  expect(await queryCashPosition()).toEqual({
    amount: 15_000,
    currency: "GBP",
  });
});

it("adds recorded payslips landing in the current month", async () => {
  const current = await createCashAsset("Current");
  await assignPlanningAccount(current);

  await recordNetWorth("2026-04-01", [{ assetId: current, amount: 1000 }]);
  await runGql(
    graphql(`
      mutation ($to: ID!) {
        payslipCreate(
          date: "2026-04-10"
          amountGross: { amount: 3000, currency: "GBP" }
          name: "Salary"
          toAccountId: $to
          adjustments: [
            { name: "Tax", amount: { amount: -500, currency: "GBP" } }
          ]
        ) {
          id
        }
      }
    `),
    { to: current },
  );

  // 1000 (snapshot) + 3000 (gross) - 500 (tax adjustment) = 3500.
  expect(await queryCashPosition()).toEqual({ amount: 3500, currency: "GBP" });
});

it("subtracts bills whose collection day has already fallen this month", async () => {
  // TEST_NOW is the 18th — a day-15 bill has collected, a day-25 one hasn't.
  const current = await createCashAsset("Current");
  await assignPlanningAccount(current);

  await recordNetWorth("2026-04-01", [{ assetId: current, amount: 1000 }]);
  await recordBill(current, 60, "15");
  await recordBill(current, 90, "25");

  expect(await queryCashPosition()).toEqual({ amount: 940, currency: "GBP" });
});

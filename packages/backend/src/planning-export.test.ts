import { sql } from "drizzle-orm";

import { signToken } from "@/auth/token";
import { db } from "@/db";
import { PlanningTransactions } from "@/db/schema/planning";
import { router } from "@/router";
import { graphql, runGql } from "#test/gql";

// The shared template seed (a 2025 year with accounts) would skew the exported
// grid, so start from an empty planner before each test.
beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE "PlanningYears", "PlanningMonths", "PlanningYearUKTaxRates", "PlanningAccounts", "PlanningTransactions", "NetWorthEntries" RESTART IDENTITY CASCADE`,
  );
});

async function createAsset(name: string): Promise<string> {
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

async function seedYear(year: string): Promise<void> {
  await runGql(
    graphql(`
      mutation ($year: ID!) {
        planningYearSet(year: $year) {
          id
        }
      }
    `),
    { year },
  );
}

async function assign(id: string, alias: string): Promise<void> {
  await runGql(
    graphql(`
      mutation ($id: ID!, $alias: String) {
        planningAccountAssign(assetId: $id, alias: $alias) {
          id
        }
      }
    `),
    { id, alias },
  );
}

async function recordSnapshot(
  date: string,
  balances: { assetId: string; minor: number }[],
): Promise<void> {
  await runGql(
    graphql(`
      mutation ($d: Date!, $values: [NetWorthValueInput!]!) {
        netWorthCreate(date: $d, values: $values) {
          id
        }
      }
    `),
    {
      d: date,
      values: balances.map((b) => ({
        asset: {
          categoryId: b.assetId,
          amounts: [{ amount: b.minor / 100, currency: "GBP" }],
        },
      })),
    },
  );
}

const AUTH_HEADER = `Bearer ${signToken({ kind: "real" })}`;

it("exports the planning grid verbatim: each account a (description, amount) column pair, accounts sharing rows within a month", async () => {
  await seedYear("2025");
  const current = await createAsset("Current");
  const savings = await createAsset("Savings");
  await assign(current, "Current");
  await assign(savings, "Savings");
  await recordSnapshot("2025-03-31", [
    { assetId: current, minor: 100_000 }, // £1,000
    { assetId: savings, minor: 500_000 }, // £5,000
  ]);

  await db.insert(PlanningTransactions).values([
    {
      year: 2025,
      date: new Date(Date.UTC(2025, 3, 1)), // April 2025
      amount: -95_000, // -£950 outflow
      currency: "GBP",
      name: "Rent",
      accountId: current,
    },
    {
      year: 2025,
      date: new Date(Date.UTC(2025, 3, 1)), // April 2025
      amount: -20_000, // -£200 transfer Current → Savings
      currency: "GBP",
      name: "Transfer to Savings",
      accountId: current,
      toAccountId: savings,
    },
  ]);

  const res = await router.inject({
    method: "GET",
    url: "/planning/2025/export.csv",
    headers: { authorization: AUTH_HEADER },
  });

  expect(res.statusCode).toBe(200);
  expect(res.headers["content-type"]).toBe("text/csv; charset=utf-8");
  expect(res.headers["content-disposition"]).toBe(
    'attachment; filename="planning-2025.csv"',
  );
  expect(res.body).toMatchInlineSnapshot(`
    "Month,Current,,Savings,
    Apr 2025,Opening balance,1000.00,Opening balance,5000.00
    Apr 2025,Transfer to Savings,-200.00,Transfer from Current,200.00
    Apr 2025,Rent,-950.00,,
    Apr 2025,Closing balance,-150.00,Closing balance,5200.00
    May 2025,Opening balance,-150.00,Opening balance,5200.00
    May 2025,Closing balance,-150.00,Closing balance,5200.00
    Jun 2025,Opening balance,-150.00,Opening balance,5200.00
    Jun 2025,Closing balance,-150.00,Closing balance,5200.00
    Jul 2025,Opening balance,-150.00,Opening balance,5200.00
    Jul 2025,Closing balance,-150.00,Closing balance,5200.00
    Aug 2025,Opening balance,-150.00,Opening balance,5200.00
    Aug 2025,Closing balance,-150.00,Closing balance,5200.00
    Sep 2025,Opening balance,-150.00,Opening balance,5200.00
    Sep 2025,Closing balance,-150.00,Closing balance,5200.00
    Oct 2025,Opening balance,-150.00,Opening balance,5200.00
    Oct 2025,Closing balance,-150.00,Closing balance,5200.00
    Nov 2025,Opening balance,-150.00,Opening balance,5200.00
    Nov 2025,Closing balance,-150.00,Closing balance,5200.00
    Dec 2025,Opening balance,-150.00,Opening balance,5200.00
    Dec 2025,Closing balance,-150.00,Closing balance,5200.00
    Jan 2026,Opening balance,-150.00,Opening balance,5200.00
    Jan 2026,Closing balance,-150.00,Closing balance,5200.00
    Feb 2026,Opening balance,-150.00,Opening balance,5200.00
    Feb 2026,Closing balance,-150.00,Closing balance,5200.00
    Mar 2026,Opening balance,-150.00,Opening balance,5200.00
    Mar 2026,Closing balance,-150.00,Closing balance,5200.00"
  `);
});

it("rejects an unauthenticated request with 401", async () => {
  const res = await router.inject({
    method: "GET",
    url: "/planning/2025/export.csv",
  });
  expect(res.statusCode).toBe(401);
});

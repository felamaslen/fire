import "@/index";

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { db } from "@/db";
import { PlanningPayslips } from "@/db/schema/planning";
import { env } from "@/env";
import { router } from "@/router";
import { formatTable } from "#test/format-table";
import { graphql, runGql } from "#test/gql";
import { TestUpload } from "#test/upload";

const UPLOADS_DIR = path.resolve(env.UPLOADS_DIR);
const PAYSLIP_FIXTURE = path.join(__dirname, "__fixtures__/payslip.pdf");

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

async function firstPayslipId(): Promise<string> {
  const [p] = await db.select().from(PlanningPayslips);
  return p.id;
}

it("payslipCreate lifts valueEnd for the payslip's month and every later month", async () => {
  await seedYear();
  const accountIdTo = await createAsset();
  await assign(accountIdTo);
  await recordSnapshot(accountIdTo, "2025-03-31", 1_000_000);

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

  await runGql(
    graphql(`
      mutation ($a: ID!) {
        payslipCreate(
          date: "2025-06-30"
          amountGross: { amount: 3000, currency: "GBP" }
          name: "June payslip"
          toAccountId: $a
          adjustments: [
            { amount: { amount: -500, currency: "GBP" }, name: "Income Tax" }
            { amount: { amount: -200, currency: "GBP" }, name: "NIC" }
          ]
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
    apr-2025 Main    10000       10000    
    may-2025 Main    10000       10000    
    jun-2025 Main    10000       12300    
    jul-2025 Main    12300       12300    
    aug-2025 Main    12300       12300    
    sep-2025 Main    12300       12300    
    oct-2025 Main    12300       12300    
    nov-2025 Main    12300       12300    
    dec-2025 Main    12300       12300    
    jan-2026 Main    12300       12300    
    feb-2026 Main    12300       12300    
    mar-2026 Main    12300       12300    "
  `);
});

it("payslipUpdate moves the effect to the new month and resizes it", async () => {
  await seedYear();
  const accountIdTo = await createAsset();
  await assign(accountIdTo);
  await recordSnapshot(accountIdTo, "2025-03-31", 1_000_000);

  await runGql(
    graphql(`
      mutation ($a: ID!) {
        payslipCreate(
          date: "2025-04-30"
          amountGross: { amount: 3000, currency: "GBP" }
          name: "April payslip"
          toAccountId: $a
          adjustments: [
            { amount: { amount: -500, currency: "GBP" }, name: "Income Tax" }
          ]
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
    apr-2025 Main    10000       12500    
    may-2025 Main    12500       12500    
    jun-2025 Main    12500       12500    
    jul-2025 Main    12500       12500    
    aug-2025 Main    12500       12500    
    sep-2025 Main    12500       12500    
    oct-2025 Main    12500       12500    
    nov-2025 Main    12500       12500    
    dec-2025 Main    12500       12500    
    jan-2026 Main    12500       12500    
    feb-2026 Main    12500       12500    
    mar-2026 Main    12500       12500    "
  `);

  const payslipId = await firstPayslipId();

  await runGql(
    graphql(`
      mutation ($id: ID!) {
        payslipUpdate(
          id: $id
          date: "2025-05-30"
          amountGross: { amount: 3500, currency: "GBP" }
          name: "May payslip (updated)"
          adjustments: [
            { amount: { amount: -600, currency: "GBP" }, name: "Income Tax" }
            { amount: { amount: -250, currency: "GBP" }, name: "NIC" }
          ]
        ) {
          id
        }
      }
    `),
    { id: payslipId },
  );
  // affected years = old date's year ∪ new date's year. Both are 2025 here.

  expect(await balanceTable("2025")).toMatchInlineSnapshot(`
    "
    MONTH    ACCOUNT VALUE START VALUE END
    apr-2025 Main    10000       10000    
    may-2025 Main    10000       12650    
    jun-2025 Main    12650       12650    
    jul-2025 Main    12650       12650    
    aug-2025 Main    12650       12650    
    sep-2025 Main    12650       12650    
    oct-2025 Main    12650       12650    
    nov-2025 Main    12650       12650    
    dec-2025 Main    12650       12650    
    jan-2026 Main    12650       12650    
    feb-2026 Main    12650       12650    
    mar-2026 Main    12650       12650    "
  `);
});

it("payslipDelete restores balances to the baseline", async () => {
  await seedYear();
  const accountIdTo = await createAsset();
  await assign(accountIdTo);
  await recordSnapshot(accountIdTo, "2025-03-31", 1_000_000);

  await runGql(
    graphql(`
      mutation ($a: ID!) {
        payslipCreate(
          date: "2025-04-30"
          amountGross: { amount: 3000, currency: "GBP" }
          name: "April payslip"
          toAccountId: $a
          adjustments: [
            { amount: { amount: -500, currency: "GBP" }, name: "Income Tax" }
          ]
        ) {
          id
        }
      }
    `),
    { a: accountIdTo },
  );
  const payslipId = await firstPayslipId();

  expect(await balanceTable("2025")).toMatchInlineSnapshot(`
    "
    MONTH    ACCOUNT VALUE START VALUE END
    apr-2025 Main    10000       12500    
    may-2025 Main    12500       12500    
    jun-2025 Main    12500       12500    
    jul-2025 Main    12500       12500    
    aug-2025 Main    12500       12500    
    sep-2025 Main    12500       12500    
    oct-2025 Main    12500       12500    
    nov-2025 Main    12500       12500    
    dec-2025 Main    12500       12500    
    jan-2026 Main    12500       12500    
    feb-2026 Main    12500       12500    
    mar-2026 Main    12500       12500    "
  `);

  await runGql(
    graphql(`
      mutation ($id: ID!) {
        payslipDelete(id: $id) {
          _
        }
      }
    `),
    { id: payslipId },
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

it("rejects an adjustment whose currency differs from the payslip's gross", async () => {
  await seedYear();
  const accountIdTo = await createAsset();
  await assign(accountIdTo);
  await expect(
    runGql(
      graphql(`
        mutation ($a: ID!) {
          payslipCreate(
            date: "2025-04-30"
            amountGross: { amount: 5000, currency: "GBP" }
            name: "Mismatch"
            toAccountId: $a
            adjustments: [
              { amount: { amount: -100, currency: "USD" }, name: "Oops" }
            ]
          ) {
            id
          }
        }
      `),
      { a: accountIdTo },
    ),
  ).rejects.toThrowErrorMatchingInlineSnapshot(
    `[Error: GraphQL errors: Adjustment currency USD must match payslip currency GBP]`,
  );
});

async function createLiability(name = "Student Loan"): Promise<string> {
  const data = await runGql(
    graphql(`
      mutation ($name: String!) {
        netWorthCategoryCreate(
          input: { liability: { name: $name, type: MISC } }
        ) {
          id
        }
      }
    `),
    { name },
  );
  return data.netWorthCategoryCreate.id;
}

/** Returns the April-2025 adjustments (excluding the payslip row itself), as `(name, liabilityId)` pairs, for the sole account in the test setup. */
async function aprilAdjustments(): Promise<
  Array<{ name: string; liabilityId: string | null }>
> {
  const data = await runGql(
    graphql(`
      query {
        planningYear(id: "2025") {
          months {
            id
            accounts {
              name
              transactions {
                name
                liability {
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
  const april = data.planningYear!.months.find((m) => m.id === "apr-2025")!;
  const account = april.accounts[0];
  return account.transactions
    .filter((t) => !t.name.includes("payslip"))
    .map((t) => ({
      name: t.name,
      liabilityId: t.liability?.id ?? null,
    }));
}

it("persists adjustment.liabilityId and returns it on PlanningTransaction", async () => {
  await seedYear();
  const accountIdTo = await createAsset();
  await assign(accountIdTo);
  await recordSnapshot(accountIdTo, "2025-03-31", 1_000_000);
  const liabilityId = await createLiability();

  await runGql(
    graphql(`
      mutation ($a: ID!, $l: ID!) {
        payslipCreate(
          date: "2025-04-30"
          amountGross: { amount: 3000, currency: "GBP" }
          name: "April payslip"
          toAccountId: $a
          adjustments: [
            { amount: { amount: -500, currency: "GBP" }, name: "Income Tax" }
            {
              amount: { amount: -100, currency: "GBP" }
              name: "Student loan"
              liabilityId: $l
            }
          ]
        ) {
          id
        }
      }
    `),
    { a: accountIdTo, l: liabilityId },
  );

  const rows = await aprilAdjustments();
  expect(rows).toEqual(
    expect.arrayContaining([
      { name: "Income Tax", liabilityId: null },
      { name: "Student loan", liabilityId },
    ]),
  );
});

it("clears adjustment.liabilityId on payslipUpdate when omitted", async () => {
  await seedYear();
  const accountIdTo = await createAsset();
  await assign(accountIdTo);
  await recordSnapshot(accountIdTo, "2025-03-31", 1_000_000);
  const liabilityId = await createLiability();

  await runGql(
    graphql(`
      mutation ($a: ID!, $l: ID!) {
        payslipCreate(
          date: "2025-04-30"
          amountGross: { amount: 3000, currency: "GBP" }
          name: "April payslip"
          toAccountId: $a
          adjustments: [
            {
              amount: { amount: -100, currency: "GBP" }
              name: "Student loan"
              liabilityId: $l
            }
          ]
        ) {
          id
        }
      }
    `),
    { a: accountIdTo, l: liabilityId },
  );

  const payslipId = await firstPayslipId();
  await runGql(
    graphql(`
      mutation ($id: ID!) {
        payslipUpdate(
          id: $id
          adjustments: [
            { amount: { amount: -100, currency: "GBP" }, name: "Student loan" }
          ]
        ) {
          id
        }
      }
    `),
    { id: payslipId },
  );

  expect(await aprilAdjustments()).toEqual([
    { name: "Student loan", liabilityId: null },
  ]);
});

it("nulls adjustment.liabilityId when the linked liability is deleted", async () => {
  await seedYear();
  const accountIdTo = await createAsset();
  await assign(accountIdTo);
  await recordSnapshot(accountIdTo, "2025-03-31", 1_000_000);
  const liabilityId = await createLiability();

  await runGql(
    graphql(`
      mutation ($a: ID!, $l: ID!) {
        payslipCreate(
          date: "2025-04-30"
          amountGross: { amount: 3000, currency: "GBP" }
          name: "April payslip"
          toAccountId: $a
          adjustments: [
            {
              amount: { amount: -100, currency: "GBP" }
              name: "Student loan"
              liabilityId: $l
            }
          ]
        ) {
          id
        }
      }
    `),
    { a: accountIdTo, l: liabilityId },
  );

  await runGql(
    graphql(`
      mutation ($l: ID!) {
        netWorthCategoryDelete(ref: { liability: $l }) {
          _
        }
      }
    `),
    { l: liabilityId },
  );

  expect(await aprilAdjustments()).toEqual([
    { name: "Student loan", liabilityId: null },
  ]);
});

it("rejects payslipUpdate when adjustment.liabilityId references a missing liability", async () => {
  await seedYear();
  const accountIdTo = await createAsset();
  await assign(accountIdTo);

  // Seed the payslip directly so its id (which the driver echoes back in the
  // FK-violation error's SQL params) is deterministic.
  const PAYSLIP_ID = "019340b0-5a8e-7f3a-8e9a-1234567890ab";
  await db.insert(PlanningPayslips).values({
    id: PAYSLIP_ID,
    date: new Date("2025-04-30"),
    name: "April payslip",
    amountGross: 300_000,
    currency: "GBP",
    toAccountId: accountIdTo,
  });

  await expect(
    runGql(
      graphql(`
        mutation ($id: ID!) {
          payslipUpdate(
            id: $id
            adjustments: [
              {
                amount: { amount: -100, currency: "GBP" }
                name: "Student loan"
                liabilityId: "00000000-0000-0000-0000-000000000000"
              }
            ]
          ) {
            id
          }
        }
      `),
      { id: PAYSLIP_ID },
    ),
  ).rejects.toThrowErrorMatchingInlineSnapshot(
    `
    [Error: GraphQL errors: Failed query: insert into "PlanningPayslipAdjustments" ("id", "payslipId", "amount", "name", "liabilityId", "createdAt", "updatedAt") values (default, $1, $2, $3, $4, default, default)
    params: 019340b0-5a8e-7f3a-8e9a-1234567890ab,-10000,Student loan,00000000-0000-0000-0000-000000000000]
  `,
  );
});

it("stores the attached PDF fixture in the local bucket and serves it via GET /files/:key", async () => {
  await seedYear();
  const accountIdTo = await createAsset();
  await assign(accountIdTo);

  await runGql(
    graphql(`
      mutation ($a: ID!, $file: Upload) {
        payslipCreate(
          date: "2025-04-30"
          amountGross: { amount: 3000, currency: "GBP" }
          name: "April"
          toAccountId: $a
          file: $file
        ) {
          id
        }
      }
    `),
    { a: accountIdTo, file: new TestUpload(PAYSLIP_FIXTURE) },
  );

  const files = await readdir(UPLOADS_DIR);
  expect(files).toHaveLength(1);
  expect(files[0]).toMatch(/-payslip\.pdf$/);

  const onDisk = await readFile(path.join(UPLOADS_DIR, files[0]));
  const expected = await readFile(PAYSLIP_FIXTURE);
  expect(onDisk.equals(expected)).toBe(true);
  expect(onDisk.length).toMatchInlineSnapshot(`781`);

  const served = await router.inject({
    method: "GET",
    url: `/files/${files[0]}`,
  });
  expect(served.statusCode).toBe(200);
  expect(Buffer.from(served.rawPayload).equals(expected)).toBe(true);
});

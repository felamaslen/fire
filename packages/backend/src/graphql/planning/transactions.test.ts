import "@/index";

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

async function seedYear(year = "2025", withRates = true): Promise<void> {
  if (withRates) {
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
  } else {
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

async function aprilTransactions(year = "2025"): Promise<string> {
  const data = await runGql(
    graphql(`
      query ($y: ID!) {
        planningYear(id: $y) {
          months {
            id
            accounts {
              transactions {
                id
                name
                amount {
                  amount
                }
                isProvisional
                isEditable
              }
            }
          }
        }
      }
    `),
    { y: year },
  );
  const apr = data.planningYear!.months.find((m) => m.id === "apr-2025")!;
  const rows = apr.accounts.flatMap((a) =>
    a.transactions.map((t) => [
      t.name,
      t.amount.amount,
      t.isProvisional ? "predicted" : "actual",
      t.isEditable ? "editable" : "locked",
      shortenId(t.id),
    ]),
  );
  return formatTable(["NAME", "AMOUNT", "SOURCE", "EDIT", "ID"], rows);
}

/** Collapse the uuid inside the opaque hex-encoded JSON payload so snapshots stay deterministic. */
function shortenId(id: string): string {
  return Buffer.from(id, "hex")
    .toString("utf8")
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
      "<uuid>",
    );
}

async function aprilTxId(name: string): Promise<string> {
  const data = await runGql(
    graphql(`
      query ($y: ID!) {
        planningYear(id: $y) {
          months {
            id
            accounts {
              transactions {
                id
                name
              }
            }
          }
        }
      }
    `),
    { y: "2025" },
  );
  const apr = data.planningYear!.months.find((m) => m.id === "apr-2025")!;
  for (const a of apr.accounts) {
    const match = a.transactions.find((t) => t.name === name);
    if (match) return match.id;
  }
  throw new Error(`Transaction "${name}" not found in apr-2025`);
}

it("transactionCreate inserts a manual outgoing transaction on the target month", async () => {
  await seedYear("2025", false);
  const main = await createAsset();
  await assign(main);
  await recordSnapshot(main, "2025-03-31", 1_000_000);

  await runGql(
    graphql(`
      mutation ($a: ID!) {
        transactionCreate(
          monthId: "apr-2025"
          amount: { amount: 500, currency: "GBP" }
          name: "Dentist"
          accountId: $a
        ) {
          id
        }
      }
    `),
    { a: main },
  );

  expect(await aprilTransactions()).toMatchInlineSnapshot(`
    "
    NAME    AMOUNT SOURCE EDIT     ID                         
    Dentist -500   actual editable {"kind":"tx","id":"<uuid>"}"
  `);
});

it("transactionUpdate patches a manual transaction (name + amount)", async () => {
  await seedYear("2025", false);
  const main = await createAsset();
  await assign(main);
  await recordSnapshot(main, "2025-03-31", 1_000_000);

  await runGql(
    graphql(`
      mutation ($a: ID!) {
        transactionCreate(
          monthId: "apr-2025"
          amount: { amount: 500, currency: "GBP" }
          name: "Dentist"
          accountId: $a
        ) {
          id
        }
      }
    `),
    { a: main },
  );
  const txId = await aprilTxId("Dentist");

  await runGql(
    graphql(`
      mutation ($id: ID!) {
        transactionUpdate(
          monthId: "apr-2025"
          id: $id
          amount: { amount: 750, currency: "GBP" }
          name: "Dentist (revised)"
        ) {
          id
        }
      }
    `),
    { id: txId },
  );

  expect(await aprilTransactions()).toMatchInlineSnapshot(`
    "
    NAME              AMOUNT SOURCE EDIT     ID                         
    Dentist (revised) -750   actual editable {"kind":"tx","id":"<uuid>"}"
  `);
});

it("transactionUpdate can move a manual transaction to a different month and asset", async () => {
  await seedYear("2025", false);
  const main = await createAsset("Main");
  const joint = await createAsset("Joint");
  await assign(main, "Main");
  await assign(joint, "Joint");
  await recordSnapshot(main, "2025-03-31", 1_000_000);

  await runGql(
    graphql(`
      mutation ($a: ID!) {
        transactionCreate(
          monthId: "apr-2025"
          amount: { amount: 500, currency: "GBP" }
          name: "Dentist"
          accountId: $a
        ) {
          id
        }
      }
    `),
    { a: main },
  );
  const txId = await aprilTxId("Dentist");

  await runGql(
    graphql(`
      mutation ($id: ID!, $to: ID!) {
        transactionUpdate(monthId: "may-2025", id: $id, accountId: $to) {
          id
        }
      }
    `),
    { id: txId, to: joint },
  );

  // April no longer has the transaction — it now lives on the Joint account in May.
  expect(await aprilTransactions()).toMatchInlineSnapshot(`
    "
    NAME AMOUNT SOURCE EDIT ID"
  `);
});

it("transactionDelete removes a manual transaction", async () => {
  await seedYear("2025", false);
  const main = await createAsset();
  await assign(main);
  await recordSnapshot(main, "2025-03-31", 1_000_000);

  await runGql(
    graphql(`
      mutation ($a: ID!) {
        transactionCreate(
          monthId: "apr-2025"
          amount: { amount: 500, currency: "GBP" }
          name: "Dentist"
          accountId: $a
        ) {
          id
        }
      }
    `),
    { a: main },
  );
  const txId = await aprilTxId("Dentist");

  await runGql(
    graphql(`
      mutation ($id: ID!) {
        transactionDelete(monthId: "apr-2025", id: $id) {
          _
        }
      }
    `),
    { id: txId },
  );

  expect(await aprilTransactions()).toMatchInlineSnapshot(`
    "
    NAME AMOUNT SOURCE EDIT ID"
  `);
});

it("transactionUpdate on a predicted bill writes a per-month override (this month only)", async () => {
  await seedYear("2025", false);
  const main = await createAsset();
  await assign(main);
  await recordSnapshot(main, "2025-03-31", 1_000_000);

  await runGql(
    graphql(`
      mutation ($a: ID!) {
        billCreate(
          start: "2025-04-01"
          frequency: MONTHLY
          collectionDate: ["15"]
          amount: { amount: 100, currency: "GBP" }
          name: "Broadband"
          accountId: $a
        ) {
          id
        }
      }
    `),
    { a: main },
  );
  const overrideId = await aprilTxId("Broadband");

  await runGql(
    graphql(`
      mutation ($id: ID!) {
        transactionUpdate(
          monthId: "apr-2025"
          id: $id
          amount: { amount: 175, currency: "GBP" }
        ) {
          id
        }
      }
    `),
    { id: overrideId },
  );

  // April should now reflect the override; other months keep the predicted amount.
  expect(await aprilTransactions()).toMatchInlineSnapshot(`
    "
    NAME      AMOUNT SOURCE EDIT     ID                                                
    Broadband -175   actual editable {"kind":"bill","id":"<uuid>","monthId":"apr-2025"}"
  `);
});

it("transactionDelete on a predicted bill skips it for this month (null override)", async () => {
  await seedYear("2025", false);
  const main = await createAsset();
  await assign(main);
  await recordSnapshot(main, "2025-03-31", 1_000_000);

  await runGql(
    graphql(`
      mutation ($a: ID!) {
        billCreate(
          start: "2025-04-01"
          frequency: MONTHLY
          collectionDate: ["15"]
          amount: { amount: 100, currency: "GBP" }
          name: "Broadband"
          accountId: $a
        ) {
          id
        }
      }
    `),
    { a: main },
  );
  const overrideId = await aprilTxId("Broadband");

  await runGql(
    graphql(`
      mutation ($id: ID!) {
        transactionDelete(monthId: "apr-2025", id: $id) {
          _
        }
      }
    `),
    { id: overrideId },
  );

  expect(await aprilTransactions()).toMatchInlineSnapshot(`
    "
    NAME AMOUNT SOURCE EDIT ID"
  `);
});

it("transactionUpdate on a predicted earnings transaction materialises a payslip for the month", async () => {
  await seedYear();
  const main = await createAsset();
  await assign(main);
  await recordSnapshot(main, "2025-03-31", 1_000_000);

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
    { a: main },
  );

  const grossId = await aprilTxId("Day job — 04/2025");

  // User edits the predicted gross for April — the planner creates an actual
  // payslip for that month, mirroring the tax/NI deductions, with the new gross.
  await runGql(
    graphql(`
      mutation ($id: ID!) {
        transactionUpdate(
          monthId: "apr-2025"
          id: $id
          amount: { amount: 3500, currency: "GBP" }
          name: "April payslip (revised)"
        ) {
          id
        }
      }
    `),
    { id: grossId },
  );

  // April should now show the actual payslip + its auto-populated deductions;
  // the earnings prediction for April is suppressed because a payslip covers it.
  expect(await aprilTransactions()).toMatchInlineSnapshot(`
    "
    NAME                    AMOUNT SOURCE EDIT     ID                          
    April payslip (revised) 3500   actual editable {"kind":"pay","id":"<uuid>"}
    Day job — income tax    -290.5 actual editable {"kind":"adj","id":"<uuid>"}
    Day job — NIC           -116.2 actual editable {"kind":"adj","id":"<uuid>"}"
  `);
});

it("transactionDelete on a predicted earnings transaction creates a zero-gross payslip that suppresses all earnings lines for the month", async () => {
  await seedYear();
  const main = await createAsset();
  await assign(main);
  await recordSnapshot(main, "2025-03-31", 1_000_000);

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
    { a: main },
  );

  const taxId = await aprilTxId("Day job — income tax");

  await runGql(
    graphql(`
      mutation ($id: ID!) {
        transactionDelete(monthId: "apr-2025", id: $id) {
          _
        }
      }
    `),
    { id: taxId },
  );

  // April should have only the zero-gross payslip now; no predicted gross/tax/NIC rows.
  expect(await aprilTransactions()).toMatchInlineSnapshot(`
    "
    NAME              AMOUNT SOURCE EDIT     ID                          
    Day job — skipped 0      actual editable {"kind":"pay","id":"<uuid>"}"
  `);
});

it("transactionUpdate on a predicted earnings deduction materialises the payslip with the gross + all other deductions, prefixed with the earning name", async () => {
  await seedYear();
  const main = await createAsset();
  await assign(main);
  await recordSnapshot(main, "2025-03-31", 1_000_000);

  await runGql(
    graphql(`
      mutation ($a: ID!) {
        earningsCreate(
          name: "Day job"
          start: "2025-04-01"
          amountGross: { amount: 60000, currency: "GBP" }
          countryCode: "GB"
          pensionReliefAtSource: 0
          pensionNetPay: 0
          studentLoanPlan2: true
          toAccountId: $a
        ) {
          id
        }
      }
    `),
    { a: main },
  );

  // Before the edit, April should show the four predicted lines (gross + tax +
  // NIC + student loan), each prefixed with the earning's name.
  expect(await aprilTransactions()).toMatchInlineSnapshot(`
    "
    NAME                   AMOUNT  SOURCE    EDIT     ID                                                               
    Day job — 04/2025      5000    predicted editable {"kind":"earn","part":"gross","id":"<uuid>","monthId":"apr-2025"}
    Day job — income tax   -952.67 predicted editable {"kind":"earn","part":"tax","id":"<uuid>","monthId":"apr-2025"}  
    Day job — NIC          -267.55 predicted editable {"kind":"earn","part":"nic","id":"<uuid>","monthId":"apr-2025"}  
    Day job — student loan -245.29 predicted editable {"kind":"earn","part":"sl","id":"<uuid>","monthId":"apr-2025"}   "
  `);

  const nicId = await aprilTxId("Day job — NIC");

  // User edits the NIC line, bumping the magnitude AND renaming it. The
  // planner should materialise a payslip that includes:
  //   - the gross line (not missing); the payslip row itself carries the
  //     pay-date as its name, NOT the NIC rename.
  //   - the edited NIC at the new magnitude, wearing the user's name
  //     (not duplicated).
  //   - the other deductions that were present before (tax, student loan),
  //     still carrying the earning's name as a prefix.
  await runGql(
    graphql(`
      mutation ($id: ID!) {
        transactionUpdate(
          monthId: "apr-2025"
          id: $id
          amount: { amount: 400, currency: "GBP" }
          name: "NIC (April adjustment)"
        ) {
          id
        }
      }
    `),
    { id: nicId },
  );

  expect(await aprilTransactions()).toMatchInlineSnapshot(`
    "
    NAME                   AMOUNT  SOURCE EDIT     ID                          
    Day job — 04/2025      5000    actual editable {"kind":"pay","id":"<uuid>"}
    Day job — income tax   -952.67 actual editable {"kind":"adj","id":"<uuid>"}
    NIC (April adjustment) -400    actual editable {"kind":"adj","id":"<uuid>"}
    Day job — student loan -245.29 actual editable {"kind":"adj","id":"<uuid>"}"
  `);
});

it("transactionUpdate on a payslip adjustment keeps every other adjustment in its original position", async () => {
  await seedYear();
  const main = await createAsset();
  await assign(main);
  await recordSnapshot(main, "2025-03-31", 1_000_000);

  // Explicit ids in deliberately non-insertion order so Postgres's physical
  // row order (which historically matched insertion order in tests) differs
  // from the lexicographic id order — the only stable ordering available.
  // Without the fix, the adjustments come back in insertion order on first
  // read and then shuffle again after the UPDATE below.
  await runGql(
    graphql(`
      mutation ($a: ID!) {
        payslipCreate(
          date: "2025-04-30"
          amountGross: { amount: 3000, currency: "GBP" }
          name: "April payslip"
          toAccountId: $a
          adjustments: [
            {
              id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
              amount: { amount: -200, currency: "GBP" }
              name: "NIC"
            }
            {
              id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
              amount: { amount: -400, currency: "GBP" }
              name: "Income tax"
            }
            {
              id: "cccccccc-cccc-cccc-cccc-cccccccccccc"
              amount: { amount: -100, currency: "GBP" }
              name: "Student loan"
            }
          ]
        ) {
          id
        }
      }
    `),
    { a: main },
  );

  const before = await aprilTransactions();

  const nicId = await aprilTxId("NIC");
  await runGql(
    graphql(`
      mutation ($id: ID!) {
        transactionUpdate(
          monthId: "apr-2025"
          id: $id
          amount: { amount: 250, currency: "GBP" }
        ) {
          id
        }
      }
    `),
    { id: nicId },
  );

  // Row order must stay: gross → tax → NIC → student loan. A previous bug
  // shuffled updated rows to the end because Postgres returned adjustments
  // in storage order after an UPDATE.
  expect(await aprilTransactions()).toMatchInlineSnapshot(`
    "
    NAME          AMOUNT SOURCE EDIT     ID                          
    April payslip 3000   actual editable {"kind":"pay","id":"<uuid>"}
    Income tax    -400   actual editable {"kind":"adj","id":"<uuid>"}
    NIC           -250   actual editable {"kind":"adj","id":"<uuid>"}
    Student loan  -100   actual editable {"kind":"adj","id":"<uuid>"}"
  `);

  // Only the NIC amount should have changed vs. the pre-edit snapshot.
  expect(before.replace("-200", "-250")).toBe(await aprilTransactions());
});

describe("asset investment link", () => {
  it("transactionCreate links an outflow to a STOCK asset and exposes assetId", async () => {
    await seedYear("2025", false);
    const main = await createAsset();
    await assign(main);
    const stock = await createStockAsset("VWRL");

    const created = await runGql(
      graphql(`
        mutation ($a: ID!, $s: ID!) {
          transactionCreate(
            monthId: "apr-2025"
            amount: { amount: -500, currency: "GBP" }
            name: "VWRL buy"
            accountId: $a
            assetId: $s
          ) {
            id
            assetId
            liabilityId
          }
        }
      `),
      { a: main, s: stock },
    );
    expect(created.transactionCreate.assetId).toBe(stock);
    expect(created.transactionCreate.liabilityId).toBe(null);
  });

  it("transactionCreate rejects an asset whose type isn't STOCK or PENSION", async () => {
    await seedYear("2025", false);
    const main = await createAsset();
    await assign(main);
    const cash = await createAsset("Other cash");

    await expect(
      runGql(
        graphql(`
          mutation ($a: ID!, $s: ID!) {
            transactionCreate(
              monthId: "apr-2025"
              amount: { amount: -100, currency: "GBP" }
              name: "bad"
              accountId: $a
              assetId: $s
            ) {
              id
            }
          }
        `),
        { a: main, s: cash },
      ),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Error: Only STOCK or PENSION assets can receive investment transactions]`,
    );
  });

  it("transactionCreate rejects combining liabilityId and assetId", async () => {
    await seedYear("2025", false);
    const main = await createAsset();
    await assign(main);
    const stock = await createStockAsset("VWRL");
    const liabilityData = await runGql(
      graphql(`
        mutation ($name: String!) {
          netWorthCategoryCreate(
            input: { liability: { name: $name, type: CREDIT_CARD } }
          ) {
            id
          }
        }
      `),
      { name: "Card" },
    );
    const liability = liabilityData.netWorthCategoryCreate.id;

    await expect(
      runGql(
        graphql(`
          mutation ($a: ID!, $l: ID!, $s: ID!) {
            transactionCreate(
              monthId: "apr-2025"
              amount: { amount: -100, currency: "GBP" }
              name: "conflict"
              accountId: $a
              liabilityId: $l
              assetId: $s
            ) {
              id
            }
          }
        `),
        { a: main, l: liability, s: stock },
      ),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Error: A transaction cannot both pay down a liability and invest into an asset]`,
    );
  });

  it("transactionCreate rejects an inflow with an assetId", async () => {
    await seedYear("2025", false);
    const main = await createAsset();
    await assign(main);
    const stock = await createStockAsset("VWRL");

    await expect(
      runGql(
        graphql(`
          mutation ($a: ID!, $s: ID!) {
            transactionCreate(
              monthId: "apr-2025"
              amount: { amount: 100, currency: "GBP" }
              name: "bad"
              accountId: $a
              assetId: $s
            ) {
              id
            }
          }
        `),
        { a: main, s: stock },
      ),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Error: Inflow transactions must not have a toAccountId, liabilityId, or assetId]`,
    );
  });

  it("transactionUpdate can clear assetId by passing null", async () => {
    await seedYear("2025", false);
    const main = await createAsset();
    await assign(main);
    const stock = await createStockAsset("VWRL");

    await runGql(
      graphql(`
        mutation ($a: ID!, $s: ID!) {
          transactionCreate(
            monthId: "apr-2025"
            amount: { amount: -500, currency: "GBP" }
            name: "VWRL buy"
            accountId: $a
            assetId: $s
          ) {
            id
          }
        }
      `),
      { a: main, s: stock },
    );
    const txId = await aprilTxId("VWRL buy");

    const updated = await runGql(
      graphql(`
        mutation ($id: ID!) {
          transactionUpdate(monthId: "apr-2025", id: $id, assetId: null) {
            id
            assetId
          }
        }
      `),
      { id: txId },
    );
    expect(updated.transactionUpdate.assetId).toBe(null);
  });
});

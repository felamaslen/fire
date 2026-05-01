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
  statutoryParentalPayWeekly: 18_718,
};

async function createAsset(name: string): Promise<string> {
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

async function createLiability(name: string): Promise<string> {
  const data = await runGql(
    graphql(`
      mutation ($name: String!) {
        netWorthCategoryCreate(
          input: { liability: { name: $name, type: CREDIT_CARD } }
        ) {
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
      mutation ($year: ID!, $rates: PlanningYearTaxRatesUKInput!) {
        planningYearSet(year: $year, taxRates: { uk: $rates }) {
          id
        }
      }
    `),
    { year, rates: ukRates },
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

async function monthsFor(year: string) {
  const doc = graphql(`
    query ($y: ID!) {
      planningYear(id: $y) {
        months {
          id
          accounts {
            name
            valueStart {
              amount
              currency
            }
            valueStartProvisional
            valueEnd {
              amount
              currency
            }
            valueEndProvisional
            transactions {
              name
              amount {
                amount
              }
              isProjected
              isEditable
            }
          }
        }
      }
    }
  `);
  const data = await runGql(doc, { y: year });
  return data.planningYear!.months;
}

function balanceTable(months: Awaited<ReturnType<typeof monthsFor>>): string {
  return formatTable(
    ["MONTH", "ACCOUNT", "VALUE START", "VALUE END"],
    months.flatMap((m) =>
      m.accounts.map((a) => [
        m.id,
        a.name,
        a.valueStart.amount,
        a.valueEnd.amount,
      ]),
    ),
  );
}

function balanceProvisionalTable(
  months: Awaited<ReturnType<typeof monthsFor>>,
): string {
  return formatTable(
    ["MONTH", "ACCOUNT", "START", "START PROV.", "END", "END PROV."],
    months.flatMap((m) =>
      m.accounts.map((a) => [
        m.id,
        a.name,
        a.valueStart.amount,
        a.valueStartProvisional,
        a.valueEnd.amount,
        a.valueEndProvisional,
      ]),
    ),
  );
}

function transactionTable(
  months: Awaited<ReturnType<typeof monthsFor>>,
  accountName: string,
): string {
  return formatTable(
    ["MONTH", "TX NAME", "AMOUNT", "PROV.", "EDITABLE"],
    months.flatMap((m) =>
      m.accounts
        .filter((a) => a.name === accountName)
        .flatMap((a) =>
          a.transactions.map((tx) => [
            m.id,
            tx.name,
            tx.amount.amount,
            tx.isProjected,
            tx.isEditable,
          ]),
        ),
    ),
  );
}

it("no snapshots — valueStart chains from predictions", async () => {
  await seedYear("2025");
  const current = await createAsset("Current");
  await assign(current, "Current");

  await runGql(
    graphql(`
      mutation ($from: ID!) {
        billCreate(
          start: "2025-04-01"
          frequency: MONTHLY
          collectionDate: ["15"]
          amount: { amount: 100, currency: "GBP" }
          name: "Internet"
          fromAccountId: $from
        ) {
          id
        }
      }
    `),
    { from: current },
  );

  const balances = balanceTable(await monthsFor("2025"));
  expect(balances).toMatchInlineSnapshot(`
    "
    MONTH    ACCOUNT VALUE START VALUE END
    apr-2025 Current 0           -100     
    may-2025 Current -100        -200     
    jun-2025 Current -200        -300     
    jul-2025 Current -300        -400     
    aug-2025 Current -400        -500     
    sep-2025 Current -500        -600     
    oct-2025 Current -600        -700     
    nov-2025 Current -700        -800     
    dec-2025 Current -800        -900     
    jan-2026 Current -900        -1000    
    feb-2026 Current -1000       -1100    
    mar-2026 Current -1100       -1200    "
  `);
});

it("snapshot in month prior — subsequent months baselined from it", async () => {
  await seedYear("2025");
  const current = await createAsset("Current");
  await assign(current, "Current");

  await recordSnapshot(current, "2025-06-15", 500_000); // £5,000 as of June 2025

  await runGql(
    graphql(`
      mutation ($from: ID!) {
        billCreate(
          start: "2025-04-01"
          frequency: MONTHLY
          collectionDate: ["15"]
          amount: { amount: 100, currency: "GBP" }
          name: "Internet"
          fromAccountId: $from
        ) {
          id
        }
      }
    `),
    { from: current },
  );

  const balances = balanceTable(await monthsFor("2025"));
  expect(balances).toMatchInlineSnapshot(`
    "
    MONTH    ACCOUNT VALUE START VALUE END
    apr-2025 Current 0           -100     
    may-2025 Current -100        -200     
    jun-2025 Current -200        5000     
    jul-2025 Current 5000        4900     
    aug-2025 Current 4900        4800     
    sep-2025 Current 4800        4700     
    oct-2025 Current 4700        4600     
    nov-2025 Current 4600        4500     
    dec-2025 Current 4500        4400     
    jan-2026 Current 4400        4300     
    feb-2026 Current 4300        4200     
    mar-2026 Current 4200        4100     "
  `);
});

it("snapshots with gaps — each snapshot re-anchors, months in between chain forward", async () => {
  await seedYear("2025");
  const current = await createAsset("Current");
  await assign(current, "Current");

  // Snapshot in April (2025-04-15 → £1,000) and then a gap — next snapshot in July (£3,000).
  await recordSnapshot(current, "2025-04-15", 100_000);
  await recordSnapshot(current, "2025-07-15", 300_000);

  await runGql(
    graphql(`
      mutation ($from: ID!) {
        billCreate(
          start: "2025-04-01"
          frequency: MONTHLY
          collectionDate: ["15"]
          amount: { amount: 100, currency: "GBP" }
          name: "Internet"
          fromAccountId: $from
        ) {
          id
        }
      }
    `),
    { from: current },
  );

  const balances = balanceTable(await monthsFor("2025"));
  expect(balances).toMatchInlineSnapshot(`
    "
    MONTH    ACCOUNT VALUE START VALUE END
    apr-2025 Current 0           1000     
    may-2025 Current 1000        900      
    jun-2025 Current 900         800      
    jul-2025 Current 800         3000     
    aug-2025 Current 3000        2900     
    sep-2025 Current 2900        2800     
    oct-2025 Current 2800        2700     
    nov-2025 Current 2700        2600     
    dec-2025 Current 2600        2500     
    jan-2026 Current 2500        2400     
    feb-2026 Current 2400        2300     
    mar-2026 Current 2300        2200     "
  `);
});

it("mixes all sources — payslip + explicit transfer + credit-card payment + bill with override + earnings", async () => {
  const { db } = await import("@/db");
  const { PlanningMonthBills, PlanningTransactions } =
    await import("@/db/schema/planning");

  await seedYear("2025");
  const current = await createAsset("Current");
  const joint = await createAsset("Joint");
  await assign(current, "Current");
  await assign(joint, "Joint");
  const cardLiability = await createLiability("Amex");

  // A recurring £50 internet bill from Current for six months — May's actual amount was £40 (override).
  const billCreated = await runGql(
    graphql(`
      mutation ($from: ID!) {
        billCreate(
          start: "2025-04-01"
          end: "2025-09-30"
          frequency: MONTHLY
          collectionDate: ["15"]
          amount: { amount: 50, currency: "GBP" }
          name: "Internet"
          fromAccountId: $from
        ) {
          id
        }
      }
    `),
    { from: current },
  );
  const { PlanningBills } = await import("@/db/schema/planning");
  const [bill] = await db.select().from(PlanningBills);
  expect(bill).toBeDefined();
  expect(billCreated.billCreate.id).toBeDefined();

  // Override: May's internet bill actually came to £40.
  await db.insert(PlanningMonthBills).values({
    year: 2025,
    date: new Date(Date.UTC(2025, 4, 1)), // May 2025
    billId: bill.id,
    amount: 4000,
    currency: "GBP",
  });

  // A direct transfer £200 from Current → Joint in July.
  await db.insert(PlanningTransactions).values({
    year: 2025,
    date: new Date(Date.UTC(2025, 6, 1)),
    amount: -20_000,
    currency: "GBP",
    name: "Transfer to joint",
    accountId: current,
    toAccountId: joint,
  });

  // A credit-card payment £150 from Current in August.
  await db.insert(PlanningTransactions).values({
    year: 2025,
    date: new Date(Date.UTC(2025, 7, 1)),
    amount: -15_000,
    currency: "GBP",
    name: "Amex payment",
    accountId: current,
    liabilityId: cardLiability,
  });

  // Earnings stream predicts monthly take-home from April onwards.
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
    { a: current },
  );

  // Payslip in May — actual income suppresses the earnings prediction for that month.
  await runGql(
    graphql(`
      mutation ($a: ID!) {
        payslipCreate(
          date: "2025-05-28"
          amountGross: { amount: 3000, currency: "GBP" }
          name: "May payslip"
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
    { a: current },
  );

  // Prior snapshot so balances don't start at 0.
  await recordSnapshot(current, "2025-03-31", 1_000_000); // £10,000

  const balances = balanceTable(await monthsFor("2025"));
  expect(balances).toMatchInlineSnapshot(`
    "
    MONTH    ACCOUNT VALUE START VALUE END
    apr-2025 Current 10000       12043.3  
    apr-2025 Joint   0           0        
    may-2025 Current 12043.3     14303.3  
    may-2025 Joint   0           0        
    jun-2025 Current 14303.3     16346.6  
    jun-2025 Joint   0           0        
    jul-2025 Current 16346.6     18189.9  
    jul-2025 Joint   0           200      
    aug-2025 Current 18189.9     20083.2  
    aug-2025 Joint   200         200      
    sep-2025 Current 20083.2     22126.5  
    sep-2025 Joint   200         200      
    oct-2025 Current 22126.5     24219.8  
    oct-2025 Joint   200         200      
    nov-2025 Current 24219.8     26313.1  
    nov-2025 Joint   200         200      
    dec-2025 Current 26313.1     28406.4  
    dec-2025 Joint   200         200      
    jan-2026 Current 28406.4     30499.7  
    jan-2026 Joint   200         200      
    feb-2026 Current 30499.7     32593    
    feb-2026 Joint   200         200      
    mar-2026 Current 32593       34686.3  
    mar-2026 Joint   200         200      "
  `);
});

it("transactions field surfaces each source with the expected provisional/editable flags", async () => {
  const { db } = await import("@/db");
  const { PlanningMonthBills, PlanningTransactions } =
    await import("@/db/schema/planning");

  await seedYear("2025");
  const current = await createAsset("Current");
  const joint = await createAsset("Joint");
  await assign(current, "Current");
  await assign(joint, "Joint");
  const cardLiability = await createLiability("Amex");

  await runGql(
    graphql(`
      mutation ($from: ID!) {
        billCreate(
          start: "2025-04-01"
          end: "2025-06-30"
          frequency: MONTHLY
          collectionDate: ["15"]
          amount: { amount: 50, currency: "GBP" }
          name: "Internet"
          fromAccountId: $from
        ) {
          id
        }
      }
    `),
    { from: current },
  );
  const { PlanningBills } = await import("@/db/schema/planning");
  const [bill] = await db.select().from(PlanningBills);

  // May: bill overridden to £40.
  await db.insert(PlanningMonthBills).values({
    year: 2025,
    date: new Date(Date.UTC(2025, 4, 1)),
    billId: bill.id,
    amount: 4000,
    currency: "GBP",
  });
  // June: bill skipped entirely (null amount + null currency).
  await db.insert(PlanningMonthBills).values({
    year: 2025,
    date: new Date(Date.UTC(2025, 5, 1)),
    billId: bill.id,
    amount: null,
    currency: null,
  });

  // Transfer Current → Joint in April (visible from Current's side as -200, non-editable credit on Joint's side).
  await db.insert(PlanningTransactions).values({
    year: 2025,
    date: new Date(Date.UTC(2025, 3, 1)),
    amount: -20_000,
    currency: "GBP",
    name: "Transfer to joint",
    accountId: current,
    toAccountId: joint,
  });

  // Credit-card payment in April — debit-only.
  await db.insert(PlanningTransactions).values({
    year: 2025,
    date: new Date(Date.UTC(2025, 3, 1)),
    amount: -15_000,
    currency: "GBP",
    name: "Amex payment",
    accountId: current,
    liabilityId: cardLiability,
  });

  // Earnings predicted from April, suppressed in May by an actual payslip.
  await runGql(
    graphql(`
      mutation ($a: ID!) {
        earningsCreate(
          name: "Day job"
          start: "2025-04-01"
          end: "2025-06-30"
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
    { a: current },
  );
  await runGql(
    graphql(`
      mutation ($a: ID!) {
        payslipCreate(
          date: "2025-05-28"
          amountGross: { amount: 3000, currency: "GBP" }
          name: "May payslip"
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
    { a: current },
  );

  const months = await monthsFor("2025");
  expect(transactionTable(months, "Current")).toMatchInlineSnapshot(`
    "
    MONTH    TX NAME              AMOUNT PROV. EDITABLE
    apr-2025 Amex payment         -150   false true    
    apr-2025 Day job — 04/2025    2500   true  true    
    apr-2025 Day job — income tax -290.5 true  true    
    apr-2025 Day job — NIC        -116.2 true  true    
    apr-2025 Internet             -50    true  true    
    apr-2025 Transfer to joint    -200   false true    
    may-2025 May payslip          3000   false true    
    may-2025 Income Tax           -500   false true    
    may-2025 NIC                  -200   false true    
    may-2025 Internet             -40    false true    
    jun-2025 Day job — 06/2025    2500   true  true    
    jun-2025 Day job — income tax -290.5 true  true    
    jun-2025 Day job — NIC        -116.2 true  true    "
  `);
  expect(transactionTable(months, "Joint")).toMatchInlineSnapshot(`
    "
    MONTH    TX NAME               AMOUNT PROV. EDITABLE
    apr-2025 Transfer from Current 200    false false   "
  `);
});

it("in-month snapshot overrides valueEnd — no discontinuity with next month's opening", async () => {
  await seedYear("2025");
  const joint = await createAsset("Joint");
  await assign(joint, "Joint");

  // Balance recorded at end of March (prior FY month) — becomes April's
  // valueStart via the normal baseline lookup.
  await recordSnapshot(joint, "2025-03-31", 864929); // £8,649.29
  // Balance recorded at end of April — real £2,287.03 drop not modelled as
  // any planner transaction. Before the valueEnd snapshot override, April
  // would close at £8,649.29 (projected) while May would open at £6,362.26
  // (next-month baseline), leaving a £2,287.03 jump nobody can explain.
  await recordSnapshot(joint, "2025-04-30", 636226); // £6,362.26

  const months = await monthsFor("2025");
  expect(balanceProvisionalTable(months)).toMatchInlineSnapshot(`
    "
    MONTH    ACCOUNT START   START PROV. END     END PROV.
    apr-2025 Joint   8649.29 false       6362.26 false    
    may-2025 Joint   6362.26 false       6362.26 true     
    jun-2025 Joint   6362.26 true        6362.26 true     
    jul-2025 Joint   6362.26 true        6362.26 true     
    aug-2025 Joint   6362.26 true        6362.26 true     
    sep-2025 Joint   6362.26 true        6362.26 true     
    oct-2025 Joint   6362.26 true        6362.26 true     
    nov-2025 Joint   6362.26 true        6362.26 true     
    dec-2025 Joint   6362.26 true        6362.26 true     
    jan-2026 Joint   6362.26 true        6362.26 true     
    feb-2026 Joint   6362.26 true        6362.26 true     
    mar-2026 Joint   6362.26 true        6362.26 true     "
  `);
});

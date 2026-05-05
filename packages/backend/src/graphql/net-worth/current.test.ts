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

async function createCash(name: string): Promise<string> {
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

async function createLoan(name: string, rate: number): Promise<string> {
  const data = await runGql(
    graphql(`
      mutation ($name: String!, $rate: Float!) {
        netWorthCategoryCreate(
          input: { liability: { name: $name, type: LOAN, interestRate: $rate } }
        ) {
          id
        }
      }
    `),
    { name, rate },
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
  date: string,
  values: { categoryId: string; amount: number; isLiability?: boolean }[],
): Promise<string> {
  const result = await runGql(
    graphql(`
      mutation ($d: Date!, $vs: [NetWorthValueInput!]!) {
        netWorthCreate(date: $d, values: $vs, currencyRates: null) {
          id
        }
      }
    `),
    {
      d: date,
      vs: values.map((v) =>
        v.isLiability
          ? {
              liability: {
                categoryId: v.categoryId,
                amounts: [{ amount: v.amount / 100, currency: "GBP" }],
              },
            }
          : {
              asset: {
                categoryId: v.categoryId,
                amounts: [{ amount: v.amount / 100, currency: "GBP" }],
              },
            },
      ),
    },
  );
  return result.netWorthCreate.id;
}

const NetWorthCurrentDoc = graphql(`
  query NetWorthCurrent {
    netWorthCurrent {
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
`);

it("returns null when a NetWorthEntry already exists in the current month", async () => {
  const cash = await createCash("Current");
  await recordSnapshot("2026-04-01", [{ categoryId: cash, amount: 1_000_000 }]);
  const data = await runGql(NetWorthCurrentDoc, {});
  expect(data.netWorthCurrent).toBeNull();
});

it("returns null when no prior NetWorthEntry exists", async () => {
  const data = await runGql(NetWorthCurrentDoc, {});
  expect(data.netWorthCurrent).toBeNull();
});

it("rolls the previous month's snapshot forward through bills, payslips, and ad-hoc transactions", async () => {
  // Today (per test/setup): 2026-04-18.
  await seedYear("2026");
  const cash = await createCash("Current");
  await assign(cash, "Current");

  // Previous entry: end of March, £10,000.
  await recordSnapshot("2026-03-31", [{ categoryId: cash, amount: 1_000_000 }]);

  // Internet bill £100 on the 15th of each month — fires Apr 15 (in window).
  await runGql(
    graphql(`
      mutation ($from: ID!) {
        billCreate(
          start: "2026-04-01"
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
    { from: cash },
  );

  // Ad-hoc dentist visit on Apr 5: -£500.
  await runGql(
    graphql(`
      mutation ($a: ID!) {
        transactionCreate(
          monthId: "apr-2026"
          amount: { amount: -500, currency: "GBP" }
          name: "Dentist"
          accountId: $a
        ) {
          id
        }
      }
    `),
    { a: cash },
  );

  // Payslip on Apr 10: £2,000 gross with £500 tax adjustment → £1,500 net.
  await runGql(
    graphql(`
      mutation ($a: ID!) {
        payslipCreate(
          date: "2026-04-10"
          amountGross: { amount: 2000, currency: "GBP" }
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
    { a: cash },
  );

  const data = await runGql(NetWorthCurrentDoc, {});
  // 10,000 starting + 1,500 payslip net − 100 internet bill − 500 dentist = 10,900.
  expect(data.netWorthCurrent).toMatchInlineSnapshot(`
    {
      "assets": {
        "amount": 10900,
      },
      "assetsByType": [
        {
          "amount": {
            "amount": 10900,
          },
          "type": "CASH",
        },
      ],
      "date": "2026-04-18",
      "liabilities": {
        "amount": 0,
      },
      "net": {
        "amount": 10900,
      },
    }
  `);
});

it("accrues daily interest on a loan over the window from the previous entry to today", async () => {
  // Today: 2026-04-18. Prev entry on Mar 31 → 18-day accrual window.
  await seedYear("2026");
  const cash = await createCash("Current");
  await assign(cash, "Current");
  // 12% annual rate, daily compound → (1 + 0.12/365)^18 ≈ 1.005934 → £10,059.34
  // on a £10,000 starting balance.
  const loan = await createLoan("Mortgage", 12);

  await recordSnapshot("2026-03-31", [
    { categoryId: cash, amount: 1_000_000 },
    { categoryId: loan, amount: -1_000_000, isLiability: true },
  ]);

  const data = await runGql(NetWorthCurrentDoc, {});
  expect(data.netWorthCurrent).not.toBeNull();
  expect(data.netWorthCurrent!.liabilities.amount).toBeGreaterThan(10_058);
  expect(data.netWorthCurrent!.liabilities.amount).toBeLessThan(10_061);
  // Net = 10,000 cash − ~10,059 loan ≈ −59.
  expect(data.netWorthCurrent!.net.amount).toBeLessThan(-58);
  expect(data.netWorthCurrent!.net.amount).toBeGreaterThan(-61);
});

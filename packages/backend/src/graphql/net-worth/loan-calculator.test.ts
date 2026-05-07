import { db } from "@/db";
import {
  PlanningMonthBills,
  PlanningPayslipAdjustments,
  PlanningPayslips,
  PlanningTransactions,
} from "@/db/schema/planning";
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

async function assign(assetId: string, alias: string): Promise<void> {
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

const LoanCalcDoc = graphql(`
  query LoanCalc {
    loanCalculator {
      liability {
        id
      }
      paymentHistory {
        month
        amount {
          amount
          currency
        }
      }
    }
  }
`);

it("paymentHistory aggregates PlanningTransactions and payslip adjustments by month, ignoring non-home-currency rows", async () => {
  // FY 2025 = Apr 2025 → Mar 2026; FY 2026 = "today" per the test clock
  // (2026-04-18). Seed both so transactions in either fiscal year can land
  // on a `PlanningMonths` row.
  await seedYear("2025");
  await seedYear("2026");

  const cash = await createCash("Main");
  await assign(cash, "Main");
  const loan = await createLoan("Mortgage", 5);

  // Snapshot the loan as active at -£200k so it shows up in `loanCalculator`.
  await runGql(
    graphql(`
      mutation ($d: Date!, $vs: [NetWorthValueInput!]!) {
        netWorthCreate(date: $d, values: $vs, currencyRates: null) {
          id
        }
      }
    `),
    {
      d: "2026-03-31",
      vs: [
        {
          asset: {
            categoryId: cash,
            amounts: [{ amount: 50_000, currency: "GBP" }],
          },
        },
        {
          liability: {
            categoryId: loan,
            amounts: [{ amount: -200_000, currency: "GBP" }],
          },
        },
      ],
    },
  );

  // Two GBP outflows in May 2025 → should sum to £1500 in that month.
  await db.insert(PlanningTransactions).values([
    {
      year: 2025,
      date: new Date(Date.UTC(2025, 4, 5)),
      amount: -100_000,
      currency: "GBP",
      name: "Mortgage May",
      accountId: cash,
      liabilityId: loan,
    },
    {
      year: 2025,
      date: new Date(Date.UTC(2025, 4, 20)),
      amount: -50_000,
      currency: "GBP",
      name: "Mortgage May overpayment",
      accountId: cash,
      liabilityId: loan,
    },
  ]);

  // Non-home currency in July 2025 → must be excluded.
  await db.insert(PlanningTransactions).values({
    year: 2025,
    date: new Date(Date.UTC(2025, 6, 1)),
    amount: -100_000,
    currency: "USD",
    name: "USD payment",
    accountId: cash,
    liabilityId: loan,
  });

  // Payslip deduction in Aug 2025 — also tagged to the loan, separate source.
  const [payslip] = await db
    .insert(PlanningPayslips)
    .values({
      date: new Date(Date.UTC(2025, 7, 28)),
      amountGross: 300_000,
      currency: "GBP",
      name: "Aug payslip",
      toAccountId: cash,
    })
    .returning({ id: PlanningPayslips.id });
  await db.insert(PlanningPayslipAdjustments).values({
    payslipId: payslip.id,
    amount: -7_500,
    name: "Mortgage deduction",
    liabilityId: loan,
  });

  const data = await runGql(LoanCalcDoc, {});
  const row = data.loanCalculator?.find((r) => r.liability.id === loan);
  expect(row?.paymentHistory).toMatchInlineSnapshot(`
    [
      {
        "amount": {
          "amount": 1500,
          "currency": "GBP",
        },
        "month": "2025-05-01",
      },
      {
        "amount": {
          "amount": 75,
          "currency": "GBP",
        },
        "month": "2025-08-01",
      },
    ]
  `);
});

it("paymentHistory expands recurring PlanningBills against past months and respects PlanningMonthBills overrides", async () => {
  // FY 2025 = Apr 2025 → Mar 2026; "today" per the test clock is 2026-04-18,
  // so 12 monthly firings of an Apr-2025-onwards bill (Apr 25 → Mar 26) sit
  // in the past plus April 2026 if its collection day has passed.
  await seedYear("2025");
  await seedYear("2026");

  const cash = await createCash("Main");
  await assign(cash, "Main");
  const loan = await createLoan("Mortgage", 4);

  // Mark the loan active so it appears in `loanCalculator`.
  await runGql(
    graphql(`
      mutation ($d: Date!, $vs: [NetWorthValueInput!]!) {
        netWorthCreate(date: $d, values: $vs, currencyRates: null) {
          id
        }
      }
    `),
    {
      d: "2026-03-31",
      vs: [
        {
          asset: {
            categoryId: cash,
            amounts: [{ amount: 50_000, currency: "GBP" }],
          },
        },
        {
          liability: {
            categoryId: loan,
            amounts: [{ amount: -300_000, currency: "GBP" }],
          },
        },
      ],
    },
  );

  // Recurring £1000/month direct debit on the 1st, no end date.
  const billCreated = await runGql(
    graphql(`
      mutation ($from: ID!, $loan: ID!) {
        billCreate(
          start: "2025-04-01"
          frequency: MONTHLY
          collectionDate: ["1"]
          amount: { amount: 1000, currency: "GBP" }
          name: "Mortgage"
          fromAccountId: $from
          liabilityId: $loan
        ) {
          id
        }
      }
    `),
    { from: cash, loan },
  );
  const billId = billCreated.billCreate.id;

  // Override June 2025 to £950 (refinanced for one month) and skip Sep 2025.
  await db.insert(PlanningMonthBills).values([
    {
      year: 2025,
      date: new Date(Date.UTC(2025, 5, 1)),
      billId,
      amount: 95_000,
      currency: "GBP",
    },
    {
      year: 2025,
      date: new Date(Date.UTC(2025, 8, 1)),
      billId,
      amount: null,
      currency: null,
    },
  ]);

  const data = await runGql(LoanCalcDoc, {});
  const row = data.loanCalculator?.find((r) => r.liability.id === loan);
  // Apr 2025 → Apr 2026 inclusive (collection on the 1st, 2026-04-01 ≤
  // 2026-04-18). Sep 2025 dropped (override.amount = null), Jun 2025 = £950,
  // every other month = £1000.
  expect(row?.paymentHistory).toMatchInlineSnapshot();
});

import { db } from "@/db";
import {
  PlanningPayslipAdjustments,
  PlanningPayslips,
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

async function recordSnapshot(
  date: string,
  values: { categoryId: string; amount: number; isLiability?: boolean }[],
): Promise<void> {
  await runGql(
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
}

const ForecastDoc = graphql(`
  query Forecast {
    netWorthForecast(years: 1, limit: 5) {
      workings {
        categories {
          __typename
          ... on NetWorthForecastLoan {
            category {
              id
            }
            monthlyRepayment {
              amount
            }
            monthlyPayslipRepayment {
              amount
            }
            monthlyBillRepayment {
              amount
            }
          }
        }
      }
    }
  }
`);

it("loan monthlyRepayment uses real payslip adjustments and doesn't double-count predicted student-loan deductions for the same month", async () => {
  // FY 2026 is "today" (test clock = 2026-04-18). Need rates for the
  // earning's predicted student-loan deduction calc.
  await seedYear("2026");
  const cash = await createCash("Main");
  await assign(cash, "Main");
  const loan = await createLoan("Student Loan", 7);
  await recordSnapshot("2026-03-31", [
    { categoryId: cash, amount: 1_000_000 },
    { categoryId: loan, amount: -2_000_000, isLiability: true },
  ]);

  // Active earning that drives a predicted monthly student-loan deduction
  // routed to `loan`. With £100k gross, the predicted SL deduction is
  // ~£545/mo — substantially larger than the real £100/mo adjustments
  // we seed below, so any double-counting bug shows up clearly.
  await runGql(
    graphql(`
      mutation ($a: ID!, $l: ID!) {
        earningsCreate(
          name: "Day job"
          start: "2026-04-01"
          amountGross: { amount: 100000, currency: "GBP" }
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
    { a: cash, l: loan },
  );

  // Seed 12 months of real PlanningPayslipAdjustments (Apr 2025 → Mar 2026)
  // each tagged to `loan` with a £100 deduction. With 12 months of real
  // data filling the entire EWMA window, the synthetic backfill must skip
  // every month — so `monthlyPayslipRepayment` = £100 (the real EWMA),
  // not £100 + ~£545 (real + predicted, the bug).
  const payslipRows = Array.from({ length: 12 }, (_, i) => ({
    // i = 0 → Apr 2025, ..., i = 11 → Mar 2026.
    date: new Date(Date.UTC(2025, 3 + i, 28)),
    amountGross: 300_000,
    currency: "GBP" as const,
    name: `Payslip ${i}`,
    toAccountId: cash,
  }));
  const inserted = await db
    .insert(PlanningPayslips)
    .values(payslipRows)
    .returning({ id: PlanningPayslips.id });
  await db.insert(PlanningPayslipAdjustments).values(
    inserted.map((p) => ({
      payslipId: p.id,
      amount: -10_000,
      name: "Student loan",
      liabilityId: loan,
    })),
  );

  const data = await runGql(ForecastDoc, {});
  const cats = data.netWorthForecast!.workings.categories;
  const slForecast = cats.find(
    (c): c is Extract<typeof c, { __typename: "NetWorthForecastLoan" }> =>
      c.__typename === "NetWorthForecastLoan" && c.category.id === loan,
  );
  expect({
    monthlyRepayment: slForecast?.monthlyRepayment.amount,
    monthlyPayslipRepayment: slForecast?.monthlyPayslipRepayment.amount,
    monthlyBillRepayment: slForecast?.monthlyBillRepayment.amount,
  }).toMatchInlineSnapshot(`
    {
      "monthlyBillRepayment": 0,
      "monthlyPayslipRepayment": 100,
      "monthlyRepayment": 100,
    }
  `);
});

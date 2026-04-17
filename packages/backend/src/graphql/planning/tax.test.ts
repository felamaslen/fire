import { formatTable } from "#test/format-table";

import { computeUKTake, type UKTakeInput } from "./tax";

// Mirrors typical UK FY 24/25 rates. Amounts are in pence.
const rates: UKTakeInput["rates"] = {
  year: 2024,
  rateBasic: 0.2,
  rateHigher: 0.4,
  rateAdditional: 0.45,
  thresholdBasic: 1_257_000, // £12,570 personal allowance / top of PA
  thresholdHigher: 5_027_000, // top of basic band = £50,270
  thresholdAdditional: 12_500_000, // top of higher band = £125,000
  rateNicMain: 0.08,
  rateNicAdditional: 0.02,
  thresholdNicPrimary: 1_257_000, // PT = £12,570
  thresholdNicUpperEarnings: 5_027_000, // UEL = £50,270
  rateStudentLoanPlan2: 0.09,
  thresholdStudentLoanPlan2: 2_729_500, // £27,295
  thresholdPersonalAllowanceTaper: 10_000_000, // £100,000
  createdAt: new Date(),
  updatedAt: new Date(),
};

const noPension = { netPay: 0, relief: 0, sacrifice: null };

it("returns zeros at or below the personal allowance", () => {
  expect(
    computeUKTake({
      gross: 1_200_000,
      pension: noPension,
      studentLoanPlan2: true,
      rates,
    }),
  ).toMatchInlineSnapshot(`
    {
      "gross": 1200000,
      "incomeTax": 0,
      "net": 1200000,
      "nic": 0,
      "studentLoan": 0,
    }
  `);
});

it("applies basic-rate tax and NIC for a typical basic-rate earner", () => {
  expect(
    computeUKTake({
      gross: 3_000_000,
      pension: noPension,
      studentLoanPlan2: true,
      rates,
    }),
  ).toMatchInlineSnapshot(`
    {
      "gross": 3000000,
      "incomeTax": 348600,
      "net": 2487615,
      "nic": 139440,
      "studentLoan": 24345,
    }
  `);
});

it("crosses the higher-rate band for a £80k earner", () => {
  expect(
    computeUKTake({
      gross: 8_000_000,
      pension: noPension,
      studentLoanPlan2: true,
      rates,
    }),
  ).toMatchInlineSnapshot(`
    {
      "gross": 8000000,
      "incomeTax": 1943200,
      "net": 5221395,
      "nic": 361060,
      "studentLoan": 474345,
    }
  `);
});

it("personal-allowance taper across the £95k–£130k band", () => {
  const grosses = [
    9_500_000, 10_000_000, 10_500_000, 11_000_000, 11_500_000, 12_000_000,
    12_514_000, 13_000_000,
  ];
  const rows = grosses.map((gross) => {
    const r = computeUKTake({
      gross,
      pension: noPension,
      studentLoanPlan2: true,
      rates,
    });
    return [gross, r.net, r.incomeTax, r.nic, r.studentLoan];
  });
  expect(
    formatTable(["GROSS", "NET", "INCOME TAX", "NIC", "STUDENT LOAN"], rows),
  ).toMatchInlineSnapshot(`
    "
    GROSS    NET     INCOME TAX NIC    STUDENT LOAN
    9500000  5956395 2543200    391060 609345      
    10000000 6201395 2743200    401060 654345      
    10500000 6396395 2993200    411060 699345      
    11000000 6591395 3243200    421060 744345      
    11500000 6786395 3493200    431060 789345      
    12000000 6981395 3743200    441060 834345      
    12514000 7181155 4000900    451340 880605      
    13000000 7394995 4219600    461060 924345      "
  `);
});

it("salary sacrifice reduces tax, NI and student-loan bases", () => {
  const baseline = computeUKTake({
    gross: 8_000_000,
    pension: noPension,
    studentLoanPlan2: true,
    rates,
  });
  const withSacrifice = computeUKTake({
    gross: 8_000_000,
    pension: { ...noPension, sacrifice: 0.1 },
    studentLoanPlan2: true,
    rates,
  });
  expect({ baseline, withSacrifice }).toMatchInlineSnapshot(`
    {
      "baseline": {
        "gross": 8000000,
        "incomeTax": 1943200,
        "net": 5221395,
        "nic": 361060,
        "studentLoan": 474345,
      },
      "withSacrifice": {
        "gross": 7200000,
        "incomeTax": 1623200,
        "net": 4829395,
        "nic": 345060,
        "studentLoan": 402345,
      },
    }
  `);
});

it("net-pay pension reduces income-tax + SL bases but not NIC", () => {
  const baseline = computeUKTake({
    gross: 5_000_000,
    pension: noPension,
    studentLoanPlan2: true,
    rates,
  });
  const withNetPay = computeUKTake({
    gross: 5_000_000,
    pension: { ...noPension, netPay: 0.1 },
    studentLoanPlan2: true,
    rates,
  });
  expect({ baseline, withNetPay }).toMatchInlineSnapshot(`
    {
      "baseline": {
        "gross": 5000000,
        "incomeTax": 748600,
        "net": 3747615,
        "nic": 299440,
        "studentLoan": 204345,
      },
      "withNetPay": {
        "gross": 5000000,
        "incomeTax": 648600,
        "net": 3892615,
        "nic": 299440,
        "studentLoan": 159345,
      },
    }
  `);
});

it("relief-at-source pension is ignored at PAYE time", () => {
  const baseline = computeUKTake({
    gross: 5_000_000,
    pension: noPension,
    studentLoanPlan2: true,
    rates,
  });
  const withRelief = computeUKTake({
    gross: 5_000_000,
    pension: { ...noPension, relief: 0.1 },
    studentLoanPlan2: true,
    rates,
  });
  expect({ baseline, withRelief }).toMatchInlineSnapshot(`
    {
      "baseline": {
        "gross": 5000000,
        "incomeTax": 748600,
        "net": 3747615,
        "nic": 299440,
        "studentLoan": 204345,
      },
      "withRelief": {
        "gross": 5000000,
        "incomeTax": 748600,
        "net": 3747615,
        "nic": 299440,
        "studentLoan": 204345,
      },
    }
  `);
});

it("no student loan contribution below the plan 2 threshold", () => {
  expect(
    computeUKTake({
      gross: 2_500_000,
      pension: noPension,
      studentLoanPlan2: true,
      rates,
    }),
  ).toMatchInlineSnapshot(`
    {
      "gross": 2500000,
      "incomeTax": 248600,
      "net": 2151960,
      "nic": 99440,
      "studentLoan": 0,
    }
  `);
});

it("studentLoanPlan2=false zeros the student-loan deduction regardless of income", () => {
  const withPlan2 = computeUKTake({
    gross: 8_000_000,
    pension: noPension,
    studentLoanPlan2: true,
    rates,
  });
  const withoutPlan2 = computeUKTake({
    gross: 8_000_000,
    pension: noPension,
    studentLoanPlan2: false,
    rates,
  });
  expect({ withPlan2, withoutPlan2 }).toMatchInlineSnapshot(`
    {
      "withPlan2": {
        "gross": 8000000,
        "incomeTax": 1943200,
        "net": 5221395,
        "nic": 361060,
        "studentLoan": 474345,
      },
      "withoutPlan2": {
        "gross": 8000000,
        "incomeTax": 1943200,
        "net": 5695740,
        "nic": 361060,
        "studentLoan": 0,
      },
    }
  `);
});

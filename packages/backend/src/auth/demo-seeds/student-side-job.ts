import { applyFlavour } from "./seed-helpers";
import type { DemoSeedFn } from "./types";

/** Student with a side job. Small cash balances, a student loan that's still growing, ~2 years of history. */
export const seedStudentSideJob: DemoSeedFn = async ({
  db,
  today,
  onProgress,
}) => {
  await applyFlavour(
    db,
    today,
    {
      historyMonths: 24,
      assets: [
        {
          name: "Current Account",
          type: "CASH",
          startValue: 40000,
          endValue: 120000,
          planningAccount: true,
        },
        {
          name: "Emergency Savings",
          type: "CASH",
          startValue: 20000,
          endValue: 180000,
          planningAccount: true,
        },
        {
          // Tiny trading-app pot — the student punts a few quid a month on
          // cannabis stocks with a dash of tech on the side. Small absolute
          // values (£42 starting, £150 now) match the "few quid here and
          // there" spending pattern.
          name: "Trading App",
          type: "STOCK",
          startValue: 4200,
          endValue: 15000,
          holdings: [
            { ticker: "TLRY", weight: 0.5 },
            { ticker: "CGC", weight: 0.3 },
            { ticker: "SMT.L", weight: 0.2 },
          ],
        },
      ],
      liabilities: [
        {
          name: "Student Loan",
          type: "LOAN",
          startValue: 3200000,
          endValue: 4100000,
          interestRate: 7.3,
        },
        {
          name: "Overdraft",
          type: "CREDIT_CARD",
          startValue: 40000,
          endValue: 15000,
        },
      ],
      bills: [
        { name: "Rent (shared)", amount: 50000, dayOfMonth: 1 },
        { name: "Phone", amount: 1800, dayOfMonth: 6 },
        { name: "Streaming", amount: 1500, dayOfMonth: 8 },
        { name: "Groceries", amount: 22000, dayOfMonth: 20 },
      ],
      earnings: [{ name: "Side Job (Café)", yearly: 900000 }],
    },
    onProgress,
  );
};

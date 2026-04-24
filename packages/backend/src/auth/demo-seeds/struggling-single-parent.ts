import { applyFlavour } from "./seed-helpers";
import type { DemoSeedFn } from "./types";

/** Single parent under pressure. Personal loans, a car loan that's underwater, short history. */
export const seedStrugglingSingleParent: DemoSeedFn = async ({
  db,
  today,
  onProgress,
}) => {
  await applyFlavour(
    db,
    today,
    {
      historyMonths: 18,
      assets: [
        {
          name: "Current Account",
          type: "CASH",
          startValue: 15000,
          endValue: 8000,
          planningAccount: true,
        },
        {
          name: "Family Car",
          type: "VEHICLE",
          startValue: 950000,
          endValue: 550000,
        },
      ],
      liabilities: [
        {
          name: "Personal Loan",
          type: "LOAN",
          startValue: 800000,
          endValue: 650000,
          interestRate: 12.9,
        },
        {
          // Upside-down: balance exceeds the car's value throughout history.
          name: "Car Loan",
          type: "LOAN",
          startValue: 1400000,
          endValue: 900000,
          interestRate: 9.4,
        },
        {
          name: "Credit Card",
          type: "CREDIT_CARD",
          startValue: 220000,
          endValue: 340000,
        },
      ],
      bills: [
        { name: "Rent", amount: 110000, dayOfMonth: 1 },
        { name: "Utilities", amount: 22000, dayOfMonth: 8 },
        { name: "Childcare", amount: 80000, dayOfMonth: 15 },
        { name: "Car Loan Payment", amount: 25000, dayOfMonth: 18 },
        { name: "Groceries", amount: 45000, dayOfMonth: 22 },
      ],
      earnings: [{ name: "Wages", yearly: 2760000 }],
    },
    onProgress,
  );
};

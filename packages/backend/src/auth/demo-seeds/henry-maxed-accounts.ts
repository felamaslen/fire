import { applyFlavour } from "./seed-helpers";
import type { DemoSeedFn } from "./types";

/** High earner, not rich yet: maxed ISA + pension contributions, low expenses, clean balance sheet, aggressive trajectory. */
export const seedHenryMaxedAccounts: DemoSeedFn = async ({ db, today }) => {
  await applyFlavour(db, today, {
    historyMonths: 60,
    assets: [
      {
        name: "Current Account",
        type: "CASH",
        startValue: 150000,
        endValue: 450000,
        planningAccount: true,
      },
      {
        name: "Emergency Fund",
        type: "CASH",
        startValue: 1500000,
        endValue: 3000000,
        planningAccount: true,
      },
      {
        name: "ISA",
        type: "STOCK",
        startValue: 4000000,
        endValue: 11500000,
      },
      {
        name: "GIA",
        type: "STOCK",
        startValue: 200000,
        endValue: 4500000,
      },
      {
        name: "SIPP",
        type: "PENSION",
        startValue: 6000000,
        endValue: 28000000,
      },
    ],
    liabilities: [],
    bills: [
      { name: "Rent", amount: 170000, dayOfMonth: 1 },
      { name: "Utilities", amount: 12000, dayOfMonth: 10 },
      { name: "Phone / Internet", amount: 6000, dayOfMonth: 12 },
      { name: "Groceries", amount: 40000, dayOfMonth: 20 },
    ],
    earnings: [{ name: "Base Salary", yearly: 13200000 }],
  });
};

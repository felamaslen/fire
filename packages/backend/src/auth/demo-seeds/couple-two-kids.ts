import { applyFlavour } from "./seed-helpers";
import type { DemoSeedFn } from "./types";

/** Average couple, 2 kids, 10 years of history. Moderate salaries, mortgage on a house, paid-off car, steady stock + pension accumulation. */
export const seedCoupleTwoKids: DemoSeedFn = async ({ db, today }) => {
  await applyFlavour(db, today, {
    historyMonths: 120,
    assets: [
      {
        name: "Joint Current Account",
        type: "CASH",
        startValue: 280000,
        endValue: 950000,
        planningAccount: true,
      },
      {
        name: "Joint Savings",
        type: "CASH",
        startValue: 1500000,
        endValue: 3500000,
        planningAccount: true,
      },
      {
        name: "ISA — A",
        type: "STOCK",
        startValue: 0,
        endValue: 4800000,
        // Balanced: broad index tracker + a growth trust for a bit of
        // upside, skewed conservative because the kids' ISAs / future
        // house-move money are in scope.
      },
      {
        name: "ISA — B",
        type: "STOCK",
        startValue: 0,
        endValue: 3900000,
      },
      {
        name: "Workplace Pension — A",
        type: "PENSION",
        startValue: 1200000,
        endValue: 9800000,
      },
      {
        name: "Workplace Pension — B",
        type: "PENSION",
        startValue: 800000,
        endValue: 7200000,
      },
      {
        name: "Family Home",
        type: "PROPERTY",
        startValue: 38000000,
        endValue: 58000000,
      },
      {
        name: "Family Car",
        type: "VEHICLE",
        startValue: 1800000,
        endValue: 600000,
      },
    ],
    liabilities: [
      {
        name: "Mortgage",
        type: "LOAN",
        startValue: 28000000,
        endValue: 16000000,
        interestRate: 4.25,
      },
      {
        name: "Joint Credit Card",
        type: "CREDIT_CARD",
        startValue: 120000,
        endValue: 180000,
      },
    ],
    bills: [
      { name: "Mortgage", amount: 180000, dayOfMonth: 1 },
      { name: "Council Tax", amount: 22000, dayOfMonth: 5 },
      { name: "Energy", amount: 18000, dayOfMonth: 10 },
      { name: "Internet", amount: 4500, dayOfMonth: 12 },
      { name: "Childcare", amount: 140000, dayOfMonth: 15 },
      { name: "Groceries", amount: 80000, dayOfMonth: 20 },
    ],
    earnings: [
      { name: "Salary — A", yearly: 6600000 },
      { name: "Salary — B", yearly: 5040000 },
    ],
  });
};

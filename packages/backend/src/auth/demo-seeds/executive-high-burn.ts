import { applyFlavour } from "./seed-helpers";
import type { DemoSeedFn } from "./types";

/** Executive compensation, expensive lifestyle. Large salary, fat pension, expensive cars and a big mortgage. */
export const seedExecutiveHighBurn: DemoSeedFn = async ({ db, today }) => {
  await applyFlavour(db, today, {
    historyMonths: 96,
    assets: [
      {
        name: "Current Account",
        type: "CASH",
        startValue: 800000,
        endValue: 1200000,
        planningAccount: true,
      },
      {
        name: "Offset Savings",
        type: "CASH",
        startValue: 4000000,
        endValue: 8500000,
        planningAccount: true,
      },
      {
        name: "ISA",
        type: "STOCK",
        startValue: 2000000,
        endValue: 15000000,
        // Executive favours income over capital growth — City of London,
        // Bankers, Murray International pay quarterly dividends with long
        // unbroken track records.
      },
      {
        name: "GIA",
        type: "STOCK",
        startValue: 5000000,
        endValue: 60000000,
      },
      {
        name: "SIPP",
        type: "PENSION",
        startValue: 12000000,
        endValue: 95000000,
      },
      {
        name: "Primary Residence",
        type: "PROPERTY",
        startValue: 180000000,
        endValue: 240000000,
      },
      {
        name: "Holiday Home",
        type: "PROPERTY",
        startValue: 55000000,
        endValue: 72000000,
      },
      {
        name: "Car",
        type: "VEHICLE",
        startValue: 8500000,
        endValue: 5500000,
      },
    ],
    liabilities: [
      {
        name: "Mortgage",
        type: "LOAN",
        startValue: 95000000,
        endValue: 62000000,
        interestRate: 4.1,
      },
      {
        name: "Amex Platinum",
        type: "CREDIT_CARD",
        startValue: 850000,
        endValue: 1400000,
      },
    ],
    bills: [
      { name: "Mortgage", amount: 420000, dayOfMonth: 1 },
      { name: "Council Tax", amount: 42000, dayOfMonth: 5 },
      { name: "Energy", amount: 35000, dayOfMonth: 10 },
      { name: "Cleaner", amount: 80000, dayOfMonth: 12 },
      { name: "Private School", amount: 520000, dayOfMonth: 15 },
      { name: "Restaurants", amount: 180000, dayOfMonth: 20 },
      { name: "Travel", amount: 250000, dayOfMonth: 25 },
    ],
    earnings: [
      { name: "Base Salary", yearly: 30000000 },
      { name: "Bonus Accrual", yearly: 9600000 },
    ],
  });
};

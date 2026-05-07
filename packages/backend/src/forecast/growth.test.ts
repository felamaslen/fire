import {
  creditCardEwmaSpend,
  ewma,
  ewmaMonthlyContribution,
  type LiabilityBill,
  type LiabilityTx,
  loanEwmaRepayment,
  monthlyGrowthFactor,
  projectLoanBalance,
  projectMonthlyGrowth,
} from "./growth";

const asOf = new Date(Date.UTC(2026, 3, 1)); // 2026-04-01

describe("ewma", () => {
  it("returns 0 for an empty input", () => {
    expect(ewma([])).toBe(0);
  });

  it("returns the single sample unchanged", () => {
    expect(ewma([42])).toBe(42);
  });

  it("returns the constant when every sample is equal", () => {
    expect(ewma([10, 10, 10, 10])).toBeCloseTo(10);
  });

  it("weights the most-recent (first) sample strictly more than older ones", () => {
    const result = ewma([100, 50, 30, 20]);
    expect(result).toBeGreaterThan(50);
    expect(result).toBeLessThan(100);
  });

  it("approaches the newest value as the window shrinks", () => {
    const recentLarge = ewma([100, 20]);
    const diluted = ewma([100, 20, 20, 20, 20, 20, 20, 20]);
    expect(recentLarge).toBeGreaterThan(diluted);
  });
});

describe("monthlyGrowthFactor", () => {
  it("returns 1 for null or zero growth", () => {
    expect(monthlyGrowthFactor(null)).toBe(1);
    expect(monthlyGrowthFactor(0)).toBe(1);
  });

  it("compounds to the annual rate over 12 months", () => {
    const factor = monthlyGrowthFactor(10);
    expect(Math.pow(factor, 12)).toBeCloseTo(1.1, 10);
  });

  it("handles negative rates (depreciation)", () => {
    const factor = monthlyGrowthFactor(-15);
    expect(Math.pow(factor, 12)).toBeCloseTo(0.85, 10);
    expect(factor).toBeLessThan(1);
  });
});

describe("projectMonthlyGrowth", () => {
  it("returns `months + 1` values starting at `startValue`", () => {
    const out = projectMonthlyGrowth(100, 0, 5);
    expect(out).toHaveLength(6);
    expect(out[0]).toBe(100);
  });

  it("leaves value unchanged when the rate is zero", () => {
    const out = projectMonthlyGrowth(100, 0, 24);
    expect(out[out.length - 1]).toBe(100);
  });

  it("grows 5%/year to roughly 1.05x after 12 months", () => {
    const out = projectMonthlyGrowth(1000, 5, 12);
    expect(out[12]).toBeCloseTo(1050, 1);
  });

  it("depreciates a vehicle at 15%/year", () => {
    const out = projectMonthlyGrowth(20000, -15, 24);
    // After 2 years a vehicle losing 15%/year ≈ 0.85² × 20000 = 14450.
    expect(out[24]).toBeCloseTo(14450, 0);
  });
});

describe("projectLoanBalance", () => {
  it("keeps balance flat when the repayment exactly matches monthly interest", () => {
    const monthlyFactor = Math.pow(1.05, 1 / 12);
    const interestOnly = 100000 * (monthlyFactor - 1);
    const out = projectLoanBalance(100000, interestOnly, 5, 12);
    expect(out[12]).toBeCloseTo(100000, 0);
  });

  it("pays down a no-interest loan linearly", () => {
    const out = projectLoanBalance(1200, 100, 0, 12);
    expect(out[6]).toBeCloseTo(600);
    expect(out[12]).toBeCloseTo(0);
  });

  it("clamps the balance at zero once paid off", () => {
    const out = projectLoanBalance(500, 1000, 0, 6);
    expect(out[1]).toBe(0);
    expect(out[6]).toBe(0);
  });

  it("grows unpaid debt when the repayment is below the accruing interest", () => {
    const out = projectLoanBalance(1000, 1, 24, 12);
    // 24% apr compounded monthly ≈ 1.268 over 12 months; £1/month chips
    // hardly make a dent, so the balance must end higher.
    expect(out[12]).toBeGreaterThan(1200);
  });
});

describe("creditCardEwmaSpend", () => {
  it("returns 0 when there are no transactions", () => {
    expect(creditCardEwmaSpend([], asOf)).toBe(0);
  });

  it("returns the constant when every month has the same spend", () => {
    const txs: LiabilityTx[] = [];
    for (let i = 1; i <= 12; i++) {
      txs.push({ date: new Date(Date.UTC(2026, 3 - i, 15)), amount: -100 });
    }
    expect(creditCardEwmaSpend(txs, asOf)).toBeCloseTo(100);
  });

  it("treats absolute value — sign on PlanningTransactions.amount is noise here", () => {
    const txs: LiabilityTx[] = [
      { date: new Date(Date.UTC(2026, 2, 10)), amount: -50 },
      { date: new Date(Date.UTC(2026, 2, 15)), amount: 50 },
    ];
    expect(creditCardEwmaSpend(txs, asOf)).toBeGreaterThan(0);
  });

  it("skips the current (partially-elapsed) month", () => {
    // asOf month is Apr 2026 — an April transaction must not contribute.
    const txs: LiabilityTx[] = [
      { date: new Date(Date.UTC(2026, 3, 15)), amount: -9999 },
    ];
    expect(creditCardEwmaSpend(txs, asOf)).toBe(0);
  });

  it("weights the most-recent month strictly above the mean", () => {
    const txs: LiabilityTx[] = [
      // Mar 2026 = £500 spend (most recent full month before asOf)
      { date: new Date(Date.UTC(2026, 2, 5)), amount: -500 },
      // Feb 2026 = £100
      { date: new Date(Date.UTC(2026, 1, 5)), amount: -100 },
      // Jan 2026 = £100
      { date: new Date(Date.UTC(2026, 0, 5)), amount: -100 },
    ];
    const result = creditCardEwmaSpend(txs, asOf);
    // Arithmetic mean over 12 months = (500 + 100 + 100) / 12 ≈ 58.3;
    // EWMA weights Mar most heavily so it must come out above the mean.
    expect(result).toBeGreaterThan(58.3);
    expect(result).toBeLessThan(500);
  });
});

describe("loanEwmaRepayment", () => {
  const monthlyBill: LiabilityBill = {
    start: new Date(Date.UTC(2020, 0, 1)),
    end: null,
    frequency: "MONTHLY",
    collectionDate: "15",
    amount: 1000,
  };

  it("returns 0 when no transactions and no bill schedule exist", () => {
    expect(loanEwmaRepayment([], [], asOf)).toBe(0);
  });

  it("falls back to the scheduled bill amount for months with no transactions", () => {
    expect(loanEwmaRepayment([], [monthlyBill], asOf)).toBeCloseTo(1000);
  });

  it("prefers actual transactions over bill schedule when both exist for a month", () => {
    const txs: LiabilityTx[] = [
      // Mar 2026 — an actual payment of 1200 (overrides the 1000 bill)
      { date: new Date(Date.UTC(2026, 2, 20)), amount: -1200 },
    ];
    const result = loanEwmaRepayment(txs, [monthlyBill], asOf, 3);
    expect(result).toBeGreaterThan(1000);
    expect(result).toBeLessThan(1200);
  });

  it("skips months with neither a transaction nor a firing bill", () => {
    const expired: LiabilityBill = {
      ...monthlyBill,
      end: new Date(Date.UTC(2020, 11, 31)),
    };
    expect(loanEwmaRepayment([], [expired], asOf)).toBe(0);
  });

  it("stops after `maxLookback` months even if fewer than `windowMonths` samples are found", () => {
    const txs: LiabilityTx[] = [
      { date: new Date(Date.UTC(2020, 0, 15)), amount: -500 },
    ];
    expect(loanEwmaRepayment(txs, [], asOf, 10, 12)).toBe(0);
  });
});

describe("ewmaMonthlyContribution", () => {
  it("returns 0 when there are no transactions", () => {
    expect(ewmaMonthlyContribution([], asOf)).toBe(0);
  });

  it("recovers a constant monthly contribution", () => {
    const txs: LiabilityTx[] = [];
    for (let i = 1; i <= 36; i++) {
      txs.push({ date: new Date(Date.UTC(2026, 3 - i, 15)), amount: -1000 });
    }
    expect(ewmaMonthlyContribution(txs, asOf)).toBeCloseTo(1000);
  });

  it("sums absolute values within the same month", () => {
    // PlanningTransactions outflows are negative, but occasional inflows
    // (e.g. a withdrawal recorded as positive on the wrapper) must still
    // contribute their magnitude to the EWMA.
    const txs: LiabilityTx[] = [
      { date: new Date(Date.UTC(2026, 2, 10)), amount: -1000 },
      { date: new Date(Date.UTC(2026, 2, 20)), amount: 400 },
    ];
    const result = ewmaMonthlyContribution(txs, asOf, 3);
    // Only Mar 2026 has activity (|-1000| + |400| = 1400) → EWMA over
    // [1400, 0, 0] sits strictly above 0 and below 1400.
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThan(1400);
  });

  it("skips the current (partially-elapsed) month", () => {
    const txs: LiabilityTx[] = [
      { date: new Date(Date.UTC(2026, 3, 10)), amount: -1000 },
    ];
    expect(ewmaMonthlyContribution(txs, asOf)).toBe(0);
  });

  it("truncates to `windowMonths` of history", () => {
    const txs: LiabilityTx[] = [
      { date: new Date(Date.UTC(2026, 3 - 40, 10)), amount: -10000 },
    ];
    expect(ewmaMonthlyContribution(txs, asOf, 36)).toBe(0);
  });
});

import {
  type ForecastCategory,
  type ForecastInputs,
  runForecast,
} from "./engine";

const asOf = new Date(Date.UTC(2026, 3, 1)); // 2026-04-01

function baseInputs(overrides: Partial<ForecastInputs> = {}): ForecastInputs {
  return {
    asOfMonthStart: asOf,
    months: 12,
    categories: [],
    startingBalance: new Map(),
    liabilityTxs: new Map(),
    loanBills: new Map(),
    portfolioTxs: new Map(),
    payslips: [],
    accountIds: [],
    nonLiabilityBills: [],
    ...overrides,
  };
}

describe("runForecast", () => {
  it("returns `months + 1` points anchored at `asOfMonthStart`", () => {
    const { points } = runForecast(baseInputs());
    expect(points).toHaveLength(13);
    expect(points[0].date).toEqual(asOf);
  });

  it("holds OPTION and MISC balances flat", () => {
    const option: ForecastCategory = { id: "opt-1", kind: "option" };
    const misc: ForecastCategory = {
      id: "misc-1",
      kind: "asset",
      assetType: "MISC",
    };
    const { points } = runForecast(
      baseInputs({
        categories: [option, misc],
        startingBalance: new Map([
          [option.id, 500],
          [misc.id, 1500],
        ]),
      }),
    );
    expect(points[0].assets).toBe(2000);
    expect(points[12].assets).toBe(2000);
  });

  it("compounds PROPERTY monthly at its annual growth rate", () => {
    const house: ForecastCategory = {
      id: "house",
      kind: "asset",
      assetType: "PROPERTY",
      growthRate: 6,
    };
    const { points, workings } = runForecast(
      baseInputs({
        categories: [house],
        startingBalance: new Map([[house.id, 500000]]),
      }),
    );
    // 6%/yr over 12 months ≈ 1.06x
    expect(points[12].net).toBeCloseTo(530000, -1);
    const w = workings.categories.find((c) => c.categoryId === house.id);
    expect(w?.growthRate).toBe(6);
  });

  it("grows STOCK portfolio by xirr and adds EWMA contribution each month", () => {
    const isa: ForecastCategory = {
      id: "isa",
      kind: "asset",
      assetType: "STOCK",
      xirr: 0, // growth factor = 1, so only contributions accumulate
    };
    const portfolioTxs = new Map([
      [
        isa.id,
        Array.from({ length: 36 }, (_, i) => ({
          date: new Date(Date.UTC(2026, 3 - (i + 1), 15)),
          units: 10,
          price: 100,
        })),
      ],
    ]);
    const { workings } = runForecast(
      baseInputs({
        categories: [isa],
        startingBalance: new Map([[isa.id, 100000]]),
        portfolioTxs,
      }),
    );
    const w = workings.categories.find((c) => c.categoryId === isa.id);
    expect(w?.monthlyContribution).toBeCloseTo(1000);
    // start 100k + 12 × 1000 contribution = 112k (xirr 0 ⇒ no growth);
    // the engine also debits those contributions from cash, but asserting
    // on the isolated per-category projection side-steps that coupling.
    expect(w?.projectedBalance[12]).toBeCloseTo(112000);
  });

  it("drops skipped liabilities entirely", () => {
    const cash: ForecastCategory = {
      id: "cash",
      kind: "asset",
      assetType: "CASH",
    };
    const closedCard: ForecastCategory = {
      id: "closed",
      kind: "liability",
      liabilityType: "CREDIT_CARD",
      skip: true,
    };
    const { points } = runForecast(
      baseInputs({
        categories: [cash, closedCard],
        startingBalance: new Map([
          [cash.id, 10000],
          [closedCard.id, 4000],
        ]),
      }),
    );
    expect(points[0].liabilities).toBe(0);
    expect(points[0].net).toBe(10000);
  });

  it("nets income − cashflow-out onto the cash bucket", () => {
    const cash: ForecastCategory = {
      id: "cash",
      kind: "asset",
      assetType: "CASH",
    };
    // Payslip EWMA: constant £3000/month to account 'acc-1'
    const payslips = Array.from({ length: 10 }, (_, i) => ({
      date: new Date(Date.UTC(2026, 2 - (i % 10), 15)),
      toAccountId: "acc-1",
      netAmount: 3000,
    }));
    const nonLiabilityBills = [
      {
        start: new Date(Date.UTC(2020, 0, 1)),
        end: null,
        frequency: "MONTHLY" as const,
        collectionDate: "1",
        amount: 2000,
      },
    ];
    const { points, workings } = runForecast(
      baseInputs({
        categories: [cash],
        startingBalance: new Map([[cash.id, 0]]),
        payslips,
        accountIds: ["acc-1"],
        nonLiabilityBills,
      }),
    );
    expect(workings.cashflow.monthlyIncome).toBeCloseTo(3000);
    expect(workings.cashflow.monthlyBills).toBeCloseTo(2000);
    expect(workings.cashflow.monthlyNetCashFlow).toBeCloseTo(1000);
    expect(points[12].assets).toBeCloseTo(12000);
  });

  it("exposes per-category workings for a LOAN", () => {
    const loan: ForecastCategory = {
      id: "loan",
      kind: "liability",
      liabilityType: "LOAN",
      interestRate: 5,
    };
    const txs = Array.from({ length: 10 }, (_, i) => ({
      date: new Date(Date.UTC(2026, 2 - i, 15)),
      amount: -1000,
    }));
    const { workings } = runForecast(
      baseInputs({
        categories: [loan],
        startingBalance: new Map([[loan.id, 100000]]),
        liabilityTxs: new Map([[loan.id, txs]]),
      }),
    );
    const w = workings.categories.find((c) => c.categoryId === loan.id);
    expect(w?.monthlyRepayment).toBeCloseTo(1000);
    expect(w?.interestRate).toBe(5);
    // Balance must go down after the first month (repayment > accrued interest on £100k@5%).
    expect(w?.projectedBalance[1]).toBeLessThan(100000);
  });
});

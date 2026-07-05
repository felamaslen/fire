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
    loanPayslipAdjustments: new Map(),
    portfolioContributionTxs: new Map(),
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

  it("holds CASH balances flat across the horizon", () => {
    const cash: ForecastCategory = {
      id: "cash",
      kind: "asset",
      assetType: "CASH",
    };
    const { points } = runForecast(
      baseInputs({
        categories: [cash],
        startingBalance: new Map([[cash.id, 12345]]),
      }),
    );
    expect(points[0].assets).toBe(12345);
    expect(points[12].assets).toBe(12345);
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
    const portfolioContributionTxs = new Map([
      [
        isa.id,
        Array.from({ length: 36 }, (_, i) => ({
          date: new Date(Date.UTC(2026, 3 - (i + 1), 15)),
          amount: -1000,
        })),
      ],
    ]);
    const { workings } = runForecast(
      baseInputs({
        categories: [isa],
        startingBalance: new Map([[isa.id, 100000]]),
        portfolioContributionTxs,
      }),
    );
    const w = workings.categories.find((c) => c.categoryId === isa.id);
    expect(w?.monthlyContribution).toBeCloseTo(1000);
    // start 100k + 12 × 1000 contribution = 112k (xirr 0 ⇒ no growth)
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

  it("folds credit-card balances into the cash position, leaving net worth unchanged", () => {
    const cash: ForecastCategory = {
      id: "cash",
      kind: "asset",
      assetType: "CASH",
    };
    const card: ForecastCategory = {
      id: "card",
      kind: "liability",
      liabilityType: "CREDIT_CARD",
    };
    const { points } = runForecast(
      baseInputs({
        categories: [cash, card],
        startingBalance: new Map([
          [cash.id, 10000],
          [card.id, 2000],
        ]),
      }),
    );
    const cashAt = (p: (typeof points)[number]) =>
      p.assetsByType.find((b) => b.type === "CASH")?.amount ?? 0;
    // Card folds into cash: available cash = 10000 − 2000, no liability band.
    expect(cashAt(points[0])).toBe(8000);
    expect(points[0].liabilities).toBe(0);
    expect(points[0].assets).toBe(8000);
    expect(points[0].net).toBe(8000);
    // Held flat across the horizon (both cash and card stay put).
    expect(cashAt(points[12])).toBe(8000);
    expect(points[12].liabilities).toBe(0);
    expect(points[12].net).toBe(8000);
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

  describe("ISA bridge", () => {
    // Retirement 2030-01, last pension access 2035-01 → 60-month bridge.
    // asOfMonthStart is 2026-04, so retirementIndex = 45, bridgeEndIndex = 105.
    const retirementYear = 2030;
    const pensionAccessIdx = (2035 - 2026) * 12 - 3; // 105

    it("drains STOCK linearly to ~0 by the last pension access date", () => {
      const isa: ForecastCategory = {
        id: "isa",
        kind: "asset",
        assetType: "STOCK",
        xirr: 0,
      };
      const sipp: ForecastCategory = {
        id: "sipp",
        kind: "asset",
        assetType: "PENSION",
        xirr: 0,
        accessibleFrom: new Date(Date.UTC(2035, 0, 1)),
      };
      const { workings } = runForecast(
        baseInputs({
          months: 240,
          categories: [isa, sipp],
          startingBalance: new Map([
            [isa.id, 120000],
            [sipp.id, 500000],
          ]),
          retirementYear,
        }),
      );
      const isaW = workings.categories.find((c) => c.categoryId === isa.id);
      // Just before bridge end — pot is near zero.
      expect(isaW?.projectedBalance[pensionAccessIdx - 1]).toBeLessThan(1500);
      // At bridge end the pot is effectively empty; 4% SWR then applies
      // but there's nothing left to draw from.
      expect(isaW?.projectedBalance[pensionAccessIdx]).toBeLessThan(1500);
    });

    it("holds locked PENSION flat during the bridge, drawing 4% only after it becomes accessible", () => {
      const isa: ForecastCategory = {
        id: "isa",
        kind: "asset",
        assetType: "STOCK",
        xirr: 0,
      };
      const sipp: ForecastCategory = {
        id: "sipp",
        kind: "asset",
        assetType: "PENSION",
        xirr: 0,
        accessibleFrom: new Date(Date.UTC(2035, 0, 1)),
      };
      const { workings } = runForecast(
        baseInputs({
          months: 240,
          categories: [isa, sipp],
          startingBalance: new Map([
            [isa.id, 120000],
            [sipp.id, 500000],
          ]),
          retirementYear,
        }),
      );
      const sippW = workings.categories.find((c) => c.categoryId === sipp.id);
      // Untouched throughout the bridge (xirr=0 so balance stays flat).
      expect(sippW?.projectedBalance[pensionAccessIdx - 1]).toBeCloseTo(500000);
      // Drawdown begins at / after pension access.
      expect(sippW?.projectedBalance[pensionAccessIdx + 1]).toBeLessThan(
        500000,
      );
    });

    it("applies 4% to STOCK from retirement when there's no bridge (no pensions)", () => {
      const isa: ForecastCategory = {
        id: "isa",
        kind: "asset",
        assetType: "STOCK",
        xirr: 0,
      };
      const retirementIdx = (retirementYear - 2026) * 12 - 3; // 45
      const { workings } = runForecast(
        baseInputs({
          months: 240,
          categories: [isa],
          startingBalance: new Map([[isa.id, 120000]]),
          retirementYear,
        }),
      );
      const isaW = workings.categories.find((c) => c.categoryId === isa.id);
      // First post-retirement month: 4%/12 drawdown = balance * (1 - 0.04/12).
      const expected = 120000 * (1 - 0.04 / 12);
      expect(isaW?.projectedBalance[retirementIdx]).toBeCloseTo(expected, 0);
    });

    it("does not compress the bridge when the chart horizon ends before the last pension access", () => {
      // Retirement 2030, pension access 2045 → real bridge is 15 years.
      // Query with only 10 years visible (months = 120). The STOCK pot
      // should drain slowly enough that it's nowhere near zero at the end
      // of the visible horizon — the bridge is a household property, not
      // a chart property.
      const isa: ForecastCategory = {
        id: "isa",
        kind: "asset",
        assetType: "STOCK",
        xirr: 0,
      };
      const sipp: ForecastCategory = {
        id: "sipp",
        kind: "asset",
        assetType: "PENSION",
        xirr: 0,
        accessibleFrom: new Date(Date.UTC(2045, 0, 1)),
      };
      const { workings } = runForecast(
        baseInputs({
          months: 120,
          categories: [isa, sipp],
          startingBalance: new Map([
            [isa.id, 120000],
            [sipp.id, 500000],
          ]),
          retirementYear: 2030,
        }),
      );
      const isaW = workings.categories.find((c) => c.categoryId === isa.id);
      // At the visible horizon (month 120) we're only partway through the
      // 15-year bridge — plenty of ISA left.
      expect(isaW?.projectedBalance[120]).toBeGreaterThan(30000);
    });

    it("applies 4% to STOCK from retirement when retirement is at/after the last pension access", () => {
      const isa: ForecastCategory = {
        id: "isa",
        kind: "asset",
        assetType: "STOCK",
        xirr: 0,
      };
      const sipp: ForecastCategory = {
        id: "sipp",
        kind: "asset",
        assetType: "PENSION",
        xirr: 0,
        accessibleFrom: new Date(Date.UTC(2030, 0, 1)), // at retirement
      };
      const retirementIdx = (retirementYear - 2026) * 12 - 3; // 45
      const { workings } = runForecast(
        baseInputs({
          months: 240,
          categories: [isa, sipp],
          startingBalance: new Map([
            [isa.id, 120000],
            [sipp.id, 500000],
          ]),
          retirementYear,
        }),
      );
      const isaW = workings.categories.find((c) => c.categoryId === isa.id);
      const expected = 120000 * (1 - 0.04 / 12);
      expect(isaW?.projectedBalance[retirementIdx]).toBeCloseTo(expected, 0);
    });
  });
});

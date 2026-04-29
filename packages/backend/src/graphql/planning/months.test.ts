import {
  earningMonthCoverage,
  effectiveMonthGrossFraction,
  monthId,
  monthsInFYYear,
  parseMonthId,
  planningMonthKey,
  yearsOverlapping,
} from "./months";

it("monthId encodes to short-month-lowercase + year", () => {
  expect(monthId(new Date(Date.UTC(2024, 11, 15)))).toBe("dec-2024");
  expect(monthId(new Date(Date.UTC(2025, 0, 1)))).toBe("jan-2025");
  expect(monthId(new Date(Date.UTC(2025, 3, 30)))).toBe("apr-2025");
});

it("parseMonthId round-trips to a UTC date at day=1 of that month", () => {
  const d = parseMonthId("dec-2024");
  expect(d.toISOString()).toBe("2024-12-01T00:00:00.000Z");
  expect(monthId(d)).toBe("dec-2024");
});

it("parseMonthId rejects malformed input", () => {
  expect(() => parseMonthId("2024-12")).toThrow(/Invalid month id/);
  expect(() => parseMonthId("xyz-2024")).toThrow(/Invalid month id/);
  expect(() => parseMonthId("")).toThrow(/Invalid month id/);
});

it("planningMonthKey maps a calendar day to its FY (April → start year)", () => {
  // April 5, 2025 → FY25/26 → year = 2025
  expect(planningMonthKey(new Date(Date.UTC(2025, 3, 5)))).toEqual({
    year: 2025,
    date: new Date(Date.UTC(2025, 3, 1)),
  });
  // March 31, 2026 → still FY25/26 → year = 2025
  expect(planningMonthKey(new Date(Date.UTC(2026, 2, 31)))).toEqual({
    year: 2025,
    date: new Date(Date.UTC(2026, 2, 1)),
  });
  // April 1, 2026 → FY26/27 → year = 2026
  expect(planningMonthKey(new Date(Date.UTC(2026, 3, 1)))).toEqual({
    year: 2026,
    date: new Date(Date.UTC(2026, 3, 1)),
  });
  // January 15, 2025 → FY24/25 → year = 2024
  expect(planningMonthKey(new Date(Date.UTC(2025, 0, 15)))).toEqual({
    year: 2024,
    date: new Date(Date.UTC(2025, 0, 1)),
  });
});

it("monthsInFYYear emits 12 ordered months April → March", () => {
  const months = monthsInFYYear(2025).map((d) => monthId(d));
  expect(months).toEqual([
    "apr-2025",
    "may-2025",
    "jun-2025",
    "jul-2025",
    "aug-2025",
    "sep-2025",
    "oct-2025",
    "nov-2025",
    "dec-2025",
    "jan-2026",
    "feb-2026",
    "mar-2026",
  ]);
});

it("yearsOverlapping returns each FY the range touches", () => {
  expect(
    yearsOverlapping(
      new Date(Date.UTC(2024, 10, 1)),
      new Date(Date.UTC(2025, 5, 1)),
    ),
  ).toEqual([2024, 2025]);
  expect(
    yearsOverlapping(
      new Date(Date.UTC(2025, 3, 1)),
      new Date(Date.UTC(2026, 2, 31)),
    ),
  ).toEqual([2025]);
  expect(
    yearsOverlapping(
      new Date(Date.UTC(2023, 0, 1)),
      new Date(Date.UTC(2026, 5, 1)),
    ),
  ).toEqual([2022, 2023, 2024, 2025, 2026]);
});

it("yearsOverlapping caps an open-ended range at today + 10y", () => {
  const start = new Date(Date.UTC(2025, 3, 1));
  const years = yearsOverlapping(start, null);
  expect(years[0]).toBe(2025);
  const thisYear = new Date().getUTCFullYear();
  // Last year in the list should be roughly (thisYear + 10); allow ±1 for FY rounding.
  expect(years[years.length - 1]).toBeGreaterThanOrEqual(thisYear + 9);
  expect(years[years.length - 1]).toBeLessThanOrEqual(thisYear + 10);
});

it("earningMonthCoverage is 1 for a fully-covered month", () => {
  expect(
    earningMonthCoverage(
      new Date(Date.UTC(2025, 3, 1)), // 1 Apr
      new Date(Date.UTC(2025, 3, 30)), // 30 Apr
      new Date(Date.UTC(2025, 3, 1)),
    ),
  ).toBe(1);
});

it("earningMonthCoverage pro-rates when the earning starts mid-month", () => {
  // 16 Apr – 30 Apr = 15 days of 30 = 0.5
  expect(
    earningMonthCoverage(
      new Date(Date.UTC(2025, 3, 16)),
      null,
      new Date(Date.UTC(2025, 3, 1)),
    ),
  ).toBeCloseTo(15 / 30);
});

it("earningMonthCoverage pro-rates when the earning ends mid-month", () => {
  // 1 Apr – 15 Apr = 15 days of 30 = 0.5
  expect(
    earningMonthCoverage(
      new Date(Date.UTC(2025, 3, 1)),
      new Date(Date.UTC(2025, 3, 15)),
      new Date(Date.UTC(2025, 3, 1)),
    ),
  ).toBeCloseTo(15 / 30);
});

// `effectiveMonthGrossFraction` reuses the same fixtures: 30k annual gross =>
// weeklyGross ~= £576.92 (57692p), and the FY25/26 statutory weekly = £187.18
// (18718p) which is below 90% × weekly => statutory floor fraction = 18718 /
// 57692 ≈ 0.3245.
const APR_2025 = new Date(Date.UTC(2025, 3, 1));
const ANNUAL_GROSS_30K_WEEKLY = 3_000_000 / 52;
const STAT_WEEKLY = 18_718;

it("effectiveMonthGrossFraction returns 1 for a fully-covered month with no leaves", () => {
  expect(
    effectiveMonthGrossFraction(
      new Date(Date.UTC(2025, 3, 1)),
      null,
      [],
      ANNUAL_GROSS_30K_WEEKLY,
      STAT_WEEKLY,
      APR_2025,
    ),
  ).toBe(1);
});

it("effectiveMonthGrossFraction equals coverage when the earning starts mid-month with no leaves", () => {
  // 16-30 Apr = 15 of 30 days → 0.5
  expect(
    effectiveMonthGrossFraction(
      new Date(Date.UTC(2025, 3, 16)),
      null,
      [],
      ANNUAL_GROSS_30K_WEEKLY,
      STAT_WEEKLY,
      APR_2025,
    ),
  ).toBeCloseTo(15 / 30);
});

it("effectiveMonthGrossFraction takes fractionOfGross during a non-statutory leave", () => {
  // Whole April unpaid (fraction=0) → expect 0; half pay → 0.5.
  const leave = (frac: number) => ({
    start: new Date(Date.UTC(2025, 3, 1)),
    end: new Date(Date.UTC(2025, 3, 30)),
    fractionOfGross: frac,
    statutoryEligible: false,
  });
  expect(
    effectiveMonthGrossFraction(
      new Date(Date.UTC(2025, 3, 1)),
      null,
      [leave(0)],
      ANNUAL_GROSS_30K_WEEKLY,
      STAT_WEEKLY,
      APR_2025,
    ),
  ).toBe(0);
  expect(
    effectiveMonthGrossFraction(
      new Date(Date.UTC(2025, 3, 1)),
      null,
      [leave(0.5)],
      ANNUAL_GROSS_30K_WEEKLY,
      STAT_WEEKLY,
      APR_2025,
    ),
  ).toBeCloseTo(0.5);
});

it("effectiveMonthGrossFraction floors a statutory-eligible leave at min(stat / weekly, 0.9)", () => {
  // 30k annual: weekly ~£576.92, statutory £187.18 → floor ≈ 0.3245.
  // A row at fractionOfGross=0 + isSMP gets bumped to that floor.
  const fraction = effectiveMonthGrossFraction(
    new Date(Date.UTC(2025, 3, 1)),
    null,
    [
      {
        start: new Date(Date.UTC(2025, 3, 1)),
        end: new Date(Date.UTC(2025, 3, 30)),
        fractionOfGross: 0,
        statutoryEligible: true,
      },
    ],
    ANNUAL_GROSS_30K_WEEKLY,
    STAT_WEEKLY,
    APR_2025,
  );
  expect(fraction).toBeCloseTo(STAT_WEEKLY / ANNUAL_GROSS_30K_WEEKLY);
});

it("effectiveMonthGrossFraction caps the statutory floor at 0.9 of normal weekly for low earners", () => {
  // £5k annual: weekly = ~£96.15. Statutory £187.18 would exceed 90% of
  // weekly (~£86.54), so the floor is capped at 0.9.
  const lowWeekly = 500_000 / 52;
  const fraction = effectiveMonthGrossFraction(
    new Date(Date.UTC(2025, 3, 1)),
    null,
    [
      {
        start: new Date(Date.UTC(2025, 3, 1)),
        end: new Date(Date.UTC(2025, 3, 30)),
        fractionOfGross: 0,
        statutoryEligible: true,
      },
    ],
    lowWeekly,
    STAT_WEEKLY,
    APR_2025,
  );
  expect(fraction).toBeCloseTo(0.9);
});

it("effectiveMonthGrossFraction prefers the higher of fraction and statutory floor", () => {
  // 90% explicit fraction > the ~32% statutory floor → 0.9 wins.
  const fraction = effectiveMonthGrossFraction(
    new Date(Date.UTC(2025, 3, 1)),
    null,
    [
      {
        start: new Date(Date.UTC(2025, 3, 1)),
        end: new Date(Date.UTC(2025, 3, 30)),
        fractionOfGross: 0.9,
        statutoryEligible: true,
      },
    ],
    ANNUAL_GROSS_30K_WEEKLY,
    STAT_WEEKLY,
    APR_2025,
  );
  expect(fraction).toBeCloseTo(0.9);
});

it("effectiveMonthGrossFraction blends partial-month leave with normal pay", () => {
  // 16-30 Apr (15 days) at 0% unpaid leave; 1-15 Apr (15 days) at full pay.
  // Expected: 15/30 × 1 + 15/30 × 0 = 0.5.
  const fraction = effectiveMonthGrossFraction(
    new Date(Date.UTC(2025, 3, 1)),
    null,
    [
      {
        start: new Date(Date.UTC(2025, 3, 16)),
        end: new Date(Date.UTC(2025, 3, 30)),
        fractionOfGross: 0,
        statutoryEligible: false,
      },
    ],
    ANNUAL_GROSS_30K_WEEKLY,
    STAT_WEEKLY,
    APR_2025,
  );
  expect(fraction).toBeCloseTo(15 / 30);
});

it("effectiveMonthGrossFraction stages compose: 6 weeks 90%, then SMP-only floor", () => {
  // April covered by stage A (1-15 Apr at 0.9 + SMP) and stage B (16-30 Apr
  // at 0 + SMP, floors to ~0.3245). Expect 15/30 × 0.9 + 15/30 × floor.
  const stat = STAT_WEEKLY / ANNUAL_GROSS_30K_WEEKLY;
  const fraction = effectiveMonthGrossFraction(
    new Date(Date.UTC(2025, 3, 1)),
    null,
    [
      {
        start: new Date(Date.UTC(2025, 3, 1)),
        end: new Date(Date.UTC(2025, 3, 15)),
        fractionOfGross: 0.9,
        statutoryEligible: true,
      },
      {
        start: new Date(Date.UTC(2025, 3, 16)),
        end: new Date(Date.UTC(2025, 3, 30)),
        fractionOfGross: 0,
        statutoryEligible: true,
      },
    ],
    ANNUAL_GROSS_30K_WEEKLY,
    STAT_WEEKLY,
    APR_2025,
  );
  expect(fraction).toBeCloseTo((15 / 30) * 0.9 + (15 / 30) * stat);
});

it("earningMonthCoverage returns 0 when the earning doesn't overlap the month", () => {
  expect(
    earningMonthCoverage(
      new Date(Date.UTC(2025, 4, 1)), // 1 May
      new Date(Date.UTC(2025, 4, 10)),
      new Date(Date.UTC(2025, 3, 1)), // April
    ),
  ).toBe(0);
  expect(
    earningMonthCoverage(
      new Date(Date.UTC(2025, 2, 1)), // 1 Mar
      new Date(Date.UTC(2025, 2, 31)),
      new Date(Date.UTC(2025, 3, 1)), // April
    ),
  ).toBe(0);
});

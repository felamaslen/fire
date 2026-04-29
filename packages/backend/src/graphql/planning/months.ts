import {
  addDays,
  differenceInCalendarDays,
  isAfter,
  isBefore,
  max,
  min,
  subDays,
} from "date-fns";

const MONTH_SHORT = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
] as const;

/** Encode a PlanningMonth's composite key as a client-facing id (e.g. `"dec-2024"`). */
export function monthId(date: Date): string {
  return `${MONTH_SHORT[date.getUTCMonth()]}-${date.getUTCFullYear()}`;
}

/** Parse a `"mon-YYYY"` id back to a UTC Date at day=1 of that month. Throws on malformed input. */
export function parseMonthId(id: string): Date {
  const m = /^([a-z]{3})-(\d{4})$/.exec(id);
  if (!m) throw new Error(`Invalid month id: ${id}`);
  const idx = MONTH_SHORT.indexOf(m[1] as (typeof MONTH_SHORT)[number]);
  if (idx < 0) throw new Error(`Invalid month id: ${id}`);
  return new Date(Date.UTC(Number(m[2]), idx, 1));
}

/** Compose the composite (year, date) PK of the PlanningMonths row that contains `date`, where `year` is the UK FY starting year (April → March). */
export function planningMonthKey(date: Date): { year: number; date: Date } {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth();
  const fyYear = m >= 3 ? y : y - 1; // April (3) onwards belongs to FY that started this calendar year
  return {
    year: fyYear,
    date: new Date(Date.UTC(date.getUTCFullYear(), m, 1)),
  };
}

/** Twelve (year, date) PKs for the months of UK FY `year` — April `year` through March `year+1`. */
export function monthsInFYYear(year: number): Date[] {
  const out: Date[] = [];
  for (let i = 0; i < 12; i++) {
    const m = (3 + i) % 12;
    const y = 3 + i < 12 ? year : year + 1;
    out.push(new Date(Date.UTC(y, m, 1)));
  }
  return out;
}

/**
 * Fraction of a calendar month covered by the earning range
 * `[start, end]` (`end` null → ongoing). Returns `0` when the earning
 * doesn't intersect the month, `1` when it covers every day, and a value
 * in `(0, 1)` when the earning starts or ends mid-month (pro-rata). Both
 * endpoints are inclusive: an earning whose `end` falls on day `d` still
 * "covers" day `d`.
 */
export function earningMonthCoverage(
  earningStart: Date,
  earningEnd: Date | null,
  monthStart: Date,
): number {
  const monthEnd = addMonthsUTC(monthStart, 1);
  const monthLastDay = subDays(monthEnd, 1);
  const effectiveEnd = earningEnd ?? new Date(8640000000000000);
  if (isAfter(earningStart, monthLastDay)) return 0;
  if (isBefore(effectiveEnd, monthStart)) return 0;
  const overlapStart = max([monthStart, earningStart]);
  const overlapEnd = min([monthLastDay, effectiveEnd]);
  const overlapDays = differenceInCalendarDays(overlapEnd, overlapStart) + 1;
  const monthDays = differenceInCalendarDays(monthEnd, monthStart);
  return overlapDays / monthDays;
}

/** A single parental-leave stage for an earning, in the shape consumed by `effectiveMonthGrossFraction`. */
export type ParentalLeaveStage = {
  start: Date;
  end: Date | null;
  /** Fraction of normal gross paid during this stage, in `[0, 1]`. */
  fractionOfGross: number;
  /** Whether the statutory parental-pay floor applies during this stage. */
  statutoryEligible: boolean;
};

/**
 * Fraction of an earning's normal annual gross that this calendar month represents, accounting for the earning's start / end dates and any parental-leave stages overlapping the month.
 *
 * Each day of the month contributes `0` if outside the earning range, `1` if fully worked, or the leave's effective fraction `max(stage.fractionOfGross, statutoryFloorFraction)` if covered by a parental-leave stage. The statutory floor is `min(statutoryWeeklyRate / weeklyGross, 0.9)` when `statutoryEligible`, else `0`.
 *
 * Multiply the result by `earning.amountGross` to get the effective annual gross for `computeUKTake` for this month — divide that take by 12 to get the month's projection.
 */
export function effectiveMonthGrossFraction(
  earningStart: Date,
  earningEnd: Date | null,
  parentalLeaves: ParentalLeaveStage[],
  weeklyGross: number,
  statutoryWeeklyRate: number,
  monthStart: Date,
): number {
  const monthEnd = addMonthsUTC(monthStart, 1);
  const monthDays = differenceInCalendarDays(monthEnd, monthStart);
  const effectiveEnd = earningEnd;
  // SMP / SPP weekly entitlement, expressed as a fraction of normal weekly
  // gross. HMRC defines the rate as the *lower of* the flat statutory weekly
  // amount or 90% of average weekly earnings — so high earners are capped at
  // the statutory rate, low earners at 90% of their own pay. This is the
  // *rate calculation*; whether it actually applies on a given day is
  // decided per-stage below.
  const statFraction =
    weeklyGross > 0 ? Math.min(statutoryWeeklyRate / weeklyGross, 0.9) : 0;
  let weighted = 0;
  for (let i = 0; i < monthDays; i++) {
    const day = addDays(monthStart, i);
    if (isBefore(day, earningStart)) continue;
    if (effectiveEnd != null && isAfter(day, effectiveEnd)) continue;
    const stage = parentalLeaves.find(
      (l) => !isBefore(day, l.start) && (l.end == null || !isAfter(day, l.end)),
    );
    if (stage) {
      // Statutory pay is a *minimum guaranteed payment* — eligible employees
      // can never be paid below SMP / SPP, but an enhanced employer scheme
      // can pay more. Take the *higher of* the contractual fraction and the
      // statutory entitlement (when eligible). E.g. a `0% + isSMP` row tops
      // up to the statutory rate; a `90% + isSMP` row stays at 90% because
      // it already exceeds the floor.
      const floor = stage.statutoryEligible ? statFraction : 0;
      weighted += Math.max(stage.fractionOfGross, floor);
    } else {
      weighted += 1;
    }
  }
  return weighted / monthDays;
}

/** `MM/YYYY` label for a UTC-anchored date — e.g. `04/2025` for an April
 * 2025 payslip. Used as the tail of transaction / payslip names. */
export function monthYearLabel(date: Date): string {
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${month}/${date.getUTCFullYear()}`;
}

/** Add `n` calendar months to a UTC-anchored date. Equivalent to date-fns
 * `addMonths`, but computed in UTC so dates at UTC-midnight don't drift by
 * the local TZ offset around DST boundaries. */
export function addMonthsUTC(date: Date, n: number): Date {
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth() + n,
      date.getUTCDate(),
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds(),
    ),
  );
}

/** First day (midnight) of `date`'s calendar month, anchored in UTC. Equivalent to date-fns `startOfMonth` but TZ-safe for UTC-anchored dates. */
export function startOfMonthUTC(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

/** UK FY years overlapping the `[start, end]` date range. `end` null → open-ended (cap at a far-future year derived from today + 10y). */
export function yearsOverlapping(start: Date, end: Date | null): number[] {
  const effectiveEnd =
    end ?? new Date(Date.UTC(new Date().getUTCFullYear() + 10, 2, 31));
  const startYear = planningMonthKey(start).year;
  const endYear = planningMonthKey(effectiveEnd).year;
  const out: number[] = [];
  for (let y = startYear; y <= endYear; y++) out.push(y);
  return out;
}

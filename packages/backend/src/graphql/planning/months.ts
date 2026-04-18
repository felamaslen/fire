import {
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

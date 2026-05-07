import { UnreachableCaseError } from "@/errors";

import type { PortfolioTimePeriod } from "./portfolio";

/** Whole days since the Unix epoch (UTC midnight) for an ISO `YYYY-MM-DD` string. The string must already be in canonical Postgres-emitted shape — no validation here. */
export function daysSinceEpoch(s: string): number {
  return (
    Date.UTC(
      Number(s.slice(0, 4)),
      Number(s.slice(5, 7)) - 1,
      Number(s.slice(8, 10)),
    ) / 86_400_000
  );
}

/**
 * Resolve the chart's left-edge date for a `(period, length)` pair, clamped to
 * never precede the data's earliest in-scope date. Mirrors the SQL expression
 * `Portfolio.timeseries` builds inline (`greatest((now − interval) , firstDate)`)
 * so chart resolvers that compute the start date in TS share one source of
 * truth instead of re-deriving the period rules per call.
 *
 * `now` and `firstDate` are ISO `YYYY-MM-DD` strings. The return value is also
 * an ISO `YYYY-MM-DD` string (date string comparison is correct for that
 * shape, so callers can compare with `<` / `>` against transaction dates).
 */
export function periodStartDate(
  now: string,
  firstDate: string,
  period: PortfolioTimePeriod,
  length: number,
): string {
  const sub = (years: number, months: number) => {
    const d = new Date(`${now}T00:00:00Z`);
    if (years) d.setUTCFullYear(d.getUTCFullYear() - years);
    if (months) d.setUTCMonth(d.getUTCMonth() - months);
    return d.toISOString().slice(0, 10);
  };
  switch (period) {
    case "ALL":
      return firstDate;
    case "YEAR": {
      const cap = sub(length, 0);
      return cap > firstDate ? cap : firstDate;
    }
    case "MONTH": {
      const cap = sub(0, length);
      return cap > firstDate ? cap : firstDate;
    }
    case "YTD": {
      const cap = `${now.slice(0, 4)}-01-01`;
      return cap > firstDate ? cap : firstDate;
    }
    default:
      throw new UnreachableCaseError(period);
  }
}

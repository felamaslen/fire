import { asc, eq } from "drizzle-orm";
import type { Float, Int } from "grats";

import { CURRENCIES } from "@/config";
import { db } from "@/db";
import { InvestmentPrices } from "@/db/schema/investments";

import type { Date as CalendarDate } from "../date";
import { assertCurrencyCode } from "../money";

/** One sample on `Investment.priceHistory`: `x` days since the series' `initialDate`, `y` is the split-adjusted unit price in major units of the parent series' `currency` (e.g. `1.235` for £1.235). @gqlType */
export type InvestmentPriceHistoryPoint = {
  /** @gqlField */
  x: Int;
  /** Split-adjusted unit price at this sample, in major units of the parent series' `currency`. @gqlField */
  y: Float;
};

/** Daily-sampled split-adjusted unit-price history for an `Investment`, oldest sample first. Every recorded daily-close quote is included; values are expressed in today's post-split share-count terms (so a quote from before a 2-for-1 split appears as half its raw observed value). @gqlType */
export type InvestmentPriceHistory = {
  /** ISO-4217 code every `y` is expressed in. Matches the parent investment's currency. @gqlField */
  currency: string;
  /** Calendar date of the earliest sample. `points[i].x` is days since this date. @gqlField */
  initialDate: CalendarDate;
  /** @gqlField */
  points: InvestmentPriceHistoryPoint[];
};

const ONE_DAY_MS = 86_400_000;

export async function loadInvestmentPriceHistory(
  investmentId: string,
  currency: string,
): Promise<InvestmentPriceHistory | null> {
  assertCurrencyCode(currency);
  const { scale } = CURRENCIES[currency];
  const divisor = 10 ** scale;
  const rows = await db
    .select({
      date: InvestmentPrices.date,
      priceAdjusted: InvestmentPrices.priceAdjusted,
    })
    .from(InvestmentPrices)
    .where(eq(InvestmentPrices.investmentId, investmentId))
    .orderBy(asc(InvestmentPrices.date));
  if (rows.length === 0) return null;
  const initialDate = rows[0].date;
  const initialMs = initialDate.getTime();
  const points: InvestmentPriceHistoryPoint[] = rows.map((r) => ({
    x: Math.round((r.date.getTime() - initialMs) / ONE_DAY_MS) as Int,
    y: (Number(r.priceAdjusted) / divisor) as Float,
  }));
  return { currency, initialDate, points };
}

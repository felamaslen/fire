import YahooFinance from "yahoo-finance2";

import { isDemoSession } from "@/auth/session-als";
import { CURRENCIES } from "@/config";
import { db } from "@/db";
import { InvestmentPricesLive } from "@/db/schema/investments";
import { assertCurrencyCode } from "@/graphql/money";
import { log } from "@/log";

const yahooFinance = new YahooFinance({
  suppressNotices: ["yahooSurvey", "ripHistorical"],
});

/** A live quote is "stale" — and so eligible for a background refresh — once it's older than this. */
export const LIVE_QUOTE_STALE_MS = 5 * 60 * 1000;

type Quote = {
  priceMinorUnits: number;
  /** Previous-trading-day close in the same fractional units as `priceMinorUnits`. Sourced from Yahoo's `regularMarketPreviousClose`; used to compute `dailyGain*` without relying on cached close-history (which can be arbitrarily old). `null` when Yahoo doesn't report a previous close. */
  previousClosePriceMinorUnits: number | null;
  currency: string;
  /** Wall-clock time we refreshed this entry from Yahoo. */
  fetchedAt: Date;
  /** Time of the actual price tick reported by Yahoo (`regularMarketTime`). Falls back to `fetchedAt` when Yahoo doesn't report it. */
  date: Date;
};

/** Per-process dedup of in-flight Yahoo fetches. The persisted `InvestmentPricesLive` row is the cache; this map only collapses concurrent requests for the same symbol within a single tick. */
const inflight = new Map<string, Promise<Quote | null>>();

/** Whether `now` is inside the live-fetch window for the given currency. For `GBP` the window is Mon–Fri 07:00–17:30 Europe/London (LSE 08:00–16:30 with a one-hour buffer either side). All other currencies are unrestricted for now. */
export function isInBusinessHours(
  currency: string,
  now: Date = new Date(),
): boolean {
  if (currency !== "GBP") return true;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const weekday = parts.find((p) => p.type === "weekday")?.value;
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  const minute = Number(parts.find((p) => p.type === "minute")?.value);
  if (weekday === "Sat" || weekday === "Sun") return false;
  const minutesOfDay = hour * 60 + minute;
  return minutesOfDay >= 7 * 60 && minutesOfDay <= 17 * 60 + 30;
}

type FetchOpts = {
  investmentId: string;
  currency: string;
  /** Set by the daily-close cron, which should fetch even outside the live window because it runs right after market close. */
  bypassBusinessHours?: boolean;
};

/**
 * Fetch a fresh live quote from Yahoo and upsert it into `InvestmentPricesLive`. Skips the network when `opts.currency` is outside its business-hours window (see `isInBusinessHours`) unless `bypassBusinessHours` is set; returns `null` in that case so callers know nothing was refreshed.
 *
 * Concurrent calls for the same symbol share a single in-flight fetch.
 */
export async function fetchQuote(
  symbol: string,
  opts: FetchOpts,
): Promise<Quote | null> {
  // Demo sessions must never hit Yahoo *or* persist real-market data — the
  // demo portfolio is built on synthetic seeded history and a real Yahoo
  // overlay would create visible discontinuities. Bail without a fetch.
  if (isDemoSession()) return null;

  if (!opts.bypassBusinessHours && !isInBusinessHours(opts.currency)) {
    return null;
  }

  const existing = inflight.get(symbol);
  if (existing) return existing;

  const promise = (async () => {
    log.info(`refreshing yahoo quote for ${symbol}`);
    try {
      const res = (await yahooFinance.quote(
        symbol,
        {},
        { validateResult: false },
      )) as {
        regularMarketPrice?: number;
        regularMarketPreviousClose?: number;
        regularMarketTime?: Date | string;
        currency?: string;
      };
      const price = res.regularMarketPrice;
      const previousClose = res.regularMarketPreviousClose;
      const currency = res.currency;
      if (price == null || currency == null) return null;
      // Yahoo reports LSE stocks in `GBp` / `GBX` (pence) — the price is
      // already in minor units of GBP, so don't scale it.
      const alreadyMinor = currency === "GBp" || currency === "GBX";
      const currencyCode = alreadyMinor ? "GBP" : currency.toUpperCase();
      const scale = (CURRENCIES as Record<string, { scale: number }>)[
        currencyCode
      ]?.scale;
      if (scale == null) return null;
      try {
        assertCurrencyCode(currencyCode);
      } catch {
        return null;
      }
      const toMinor = (v: number) => (alreadyMinor ? v : v * 10 ** scale);
      const fetchedAt = new Date();
      const tickAt = res.regularMarketTime
        ? new Date(res.regularMarketTime)
        : fetchedAt;
      const quote: Quote = {
        priceMinorUnits: toMinor(price),
        previousClosePriceMinorUnits:
          previousClose == null ? null : toMinor(previousClose),
        currency: currencyCode,
        fetchedAt,
        date: tickAt,
      };
      try {
        await db
          .insert(InvestmentPricesLive)
          .values({
            investmentId: opts.investmentId,
            refreshedAt: fetchedAt,
            date: tickAt,
            currency: currencyCode,
            price: quote.priceMinorUnits,
            pricePreviousClose: quote.previousClosePriceMinorUnits,
            data: res,
            updatedAt: fetchedAt,
          })
          .onConflictDoUpdate({
            target: InvestmentPricesLive.investmentId,
            set: {
              refreshedAt: fetchedAt,
              date: tickAt,
              currency: currencyCode,
              price: quote.priceMinorUnits,
              pricePreviousClose: quote.previousClosePriceMinorUnits,
              data: res,
              updatedAt: fetchedAt,
            },
          });
      } catch (err) {
        log.warn(`failed to persist live quote for ${symbol}`, { err });
      }
      return quote;
    } catch (err) {
      log.warn(`yahoo quote for ${symbol} failed`, { err });
      return null;
    } finally {
      inflight.delete(symbol);
    }
  })();
  inflight.set(symbol, promise);
  return promise;
}

export function TEST__clearInflightForTesting(): void {
  inflight.clear();
}

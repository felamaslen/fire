import { LRUCache } from "lru-cache";
import YahooFinance from "yahoo-finance2";

import { log } from "@/log";

const yahooFinance = new YahooFinance({
  suppressNotices: ["yahooSurvey", "ripHistorical"],
});

const TTL_MS = 24 * 60 * 60 * 1000;
const STALE_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 1000;

type Quote = {
  priceMinorUnits: number;
  currency: string;
  fetchedAt: Date;
};

const cache = new LRUCache<string, Quote>({
  max: MAX_ENTRIES,
  ttl: TTL_MS,
});

const inflight = new Map<string, Promise<Quote | null>>();

/** Read the currently cached quote for a ticker, without triggering network activity. */
export function readCachedQuote(symbol: string): Quote | null {
  return cache.get(symbol) ?? null;
}

/** Whether a cached quote is old enough to refetch (> STALE_MS). */
function isStale(quote: Quote | null | undefined): boolean {
  if (!quote) return true;
  return Date.now() - quote.fetchedAt.getTime() > STALE_MS;
}

/**
 * Fetch (or return a cached value for) a live quote. When the cached value is fresh (< 5 min old) it's returned as-is. When stale or missing, a network fetch is kicked off; callers can `await` the returned promise or fire-and-forget.
 *
 * Concurrent calls for the same symbol share a single in-flight fetch.
 */
export async function fetchQuote(symbol: string): Promise<Quote | null> {
  const cached = cache.get(symbol);
  if (cached && !isStale(cached)) return cached;

  const existing = inflight.get(symbol);
  if (existing) return existing;

  const promise = (async () => {
    log.info(`refreshing yahoo quote for ${symbol}`);
    try {
      const res = (await yahooFinance.quote(
        symbol,
        {},
        { validateResult: false },
      )) as { regularMarketPrice?: number; currency?: string };
      const price = res.regularMarketPrice;
      const currency = res.currency;
      if (price == null || currency == null) return null;
      // Yahoo reports LSE stocks in `GBp` / `GBX` (pence) — the price is
      // already in minor units of GBP, so don't scale it.
      const alreadyMinor = currency === "GBp" || currency === "GBX";
      const currencyCode = alreadyMinor ? "GBP" : currency.toUpperCase();
      const { CURRENCIES } = await import("@/config");
      const scale = (CURRENCIES as Record<string, { scale: number }>)[
        currencyCode
      ]?.scale;
      if (scale == null) return null;
      const quote: Quote = {
        priceMinorUnits: alreadyMinor ? price : price * 10 ** scale,
        currency: currencyCode,
        fetchedAt: new Date(),
      };
      cache.set(symbol, quote);
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

/** Serve the cached quote (may be stale); in the background, kick off a refresh if it's missing or older than 5 minutes. */
export function readOrRefresh(symbol: string): Quote | null {
  const cached = cache.get(symbol);
  if (isStale(cached)) {
    void fetchQuote(symbol);
  }
  return cached ?? null;
}

export function TEST__clearCacheForTesting(): void {
  cache.clear();
  inflight.clear();
}

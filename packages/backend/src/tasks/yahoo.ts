import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { LRUCache } from "lru-cache";
import YahooFinance from "yahoo-finance2";

import { isDemoSession } from "@/auth/session-als";
import { env } from "@/env";
import { log } from "@/log";

const yahooFinance = new YahooFinance({
  suppressNotices: ["yahooSurvey", "ripHistorical"],
});

const TTL_MS = 24 * 60 * 60 * 1000;
const STALE_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 1000;

type Quote = {
  priceMinorUnits: number;
  /** Previous-trading-day close in the same fractional units as `priceMinorUnits`. Sourced from Yahoo's `regularMarketPreviousClose`; used to compute `dailyGain*` without relying on cached close-history (which can be arbitrarily old). `null` when Yahoo doesn't report a previous close. */
  previousClosePriceMinorUnits: number | null;
  currency: string;
  fetchedAt: Date;
};

const cache = new LRUCache<string, Quote>({
  max: MAX_ENTRIES,
  ttl: TTL_MS,
});

const inflight = new Map<string, Promise<Quote | null>>();

// Persist the LRU to disk everywhere except tests (which need a clean slate).
// In dev it survives HMR reloads; in prod it survives container restarts
// provided `YAHOO_CACHE_PATH` points at a file inside a mounted volume.
const PERSIST_ENABLED = env.NODE_ENV !== "test";
const PERSIST_PATH =
  env.YAHOO_CACHE_PATH ?? resolve(process.cwd(), ".yahoo-cache.json");

type PersistedEntry = {
  key: string;
  priceMinorUnits: number;
  previousClosePriceMinorUnits: number | null;
  currency: string;
  fetchedAt: string;
};

function loadCacheFromDisk(): void {
  if (!PERSIST_ENABLED) return;
  try {
    const raw = readFileSync(PERSIST_PATH, "utf8");
    const entries = JSON.parse(raw) as PersistedEntry[];
    for (const e of entries) {
      // Skip entries persisted before `previousClosePriceMinorUnits` was
      // added — loading them would serve a stale quote with null prev-close,
      // which makes `dailyGain*` null for the ticker until the cache entry
      // eventually ages out. Dropping them forces the next read to refetch
      // via Yahoo and land a fully-populated quote.
      if (e.previousClosePriceMinorUnits === undefined) continue;
      cache.set(e.key, {
        priceMinorUnits: e.priceMinorUnits,
        previousClosePriceMinorUnits: e.previousClosePriceMinorUnits,
        currency: e.currency,
        fetchedAt: new Date(e.fetchedAt),
      });
    }
    log.info(`loaded ${entries.length} yahoo quote(s) from ${PERSIST_PATH}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn(`failed to load yahoo cache from ${PERSIST_PATH}`, { err });
    }
  }
}

let persistTimer: NodeJS.Timeout | null = null;
function schedulePersist(): void {
  if (!PERSIST_ENABLED) return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const entries: PersistedEntry[] = [];
    for (const [key, value] of cache.entries()) {
      entries.push({
        key,
        priceMinorUnits: value.priceMinorUnits,
        previousClosePriceMinorUnits: value.previousClosePriceMinorUnits,
        currency: value.currency,
        fetchedAt: value.fetchedAt.toISOString(),
      });
    }
    try {
      writeFileSync(PERSIST_PATH, JSON.stringify(entries, null, 2));
    } catch (err) {
      log.warn(`failed to persist yahoo cache to ${PERSIST_PATH}`, { err });
    }
  }, 500);
}

loadCacheFromDisk();

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
  // Demo sessions must never hit Yahoo *or* see real-user cache entries —
  // even if the warm LRU has a quote for the same ticker, surfacing it in a
  // demo portfolio would overlay a real market price on the synthetic seeded
  // history and create visible discontinuities. Return `null`; the portfolio
  // / stats UI degrades gracefully to the most recent `InvestmentPrices` row.
  if (isDemoSession()) return null;

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
      )) as {
        regularMarketPrice?: number;
        regularMarketPreviousClose?: number;
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
      const { CURRENCIES } = await import("@/config");
      const scale = (CURRENCIES as Record<string, { scale: number }>)[
        currencyCode
      ]?.scale;
      if (scale == null) return null;
      const toMinor = (v: number) => (alreadyMinor ? v : v * 10 ** scale);
      const quote: Quote = {
        priceMinorUnits: toMinor(price),
        previousClosePriceMinorUnits:
          previousClose == null ? null : toMinor(previousClose),
        currency: currencyCode,
        fetchedAt: new Date(),
      };
      cache.set(symbol, quote);
      schedulePersist();
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

/** Serve the cached quote (may be stale); in the background, kick off a refresh if it's missing or older than 5 minutes. In a demo session, returns whatever is cached without scheduling a background fetch — see `fetchQuote` for the rationale. */
export function readOrRefresh(symbol: string): Quote | null {
  if (isDemoSession()) return null;
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

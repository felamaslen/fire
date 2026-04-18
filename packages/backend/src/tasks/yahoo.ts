import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { LRUCache } from "lru-cache";
import YahooFinance from "yahoo-finance2";

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
  currency: string;
  fetchedAt: Date;
};

const cache = new LRUCache<string, Quote>({
  max: MAX_ENTRIES,
  ttl: TTL_MS,
});

const inflight = new Map<string, Promise<Quote | null>>();

// In dev, persist the LRU between HMR reloads so we don't hammer Yahoo every
// time a file changes. Disabled in prod/test — prod gets its warm cache from
// the daily cron, and tests start from a clean slate.
const PERSIST_ENABLED = env.NODE_ENV === "development";
const PERSIST_PATH = resolve(process.cwd(), ".yahoo-cache.json");

type PersistedEntry = {
  key: string;
  priceMinorUnits: number;
  currency: string;
  fetchedAt: string;
};

function loadCacheFromDisk(): void {
  if (!PERSIST_ENABLED) return;
  try {
    const raw = readFileSync(PERSIST_PATH, "utf8");
    const entries = JSON.parse(raw) as PersistedEntry[];
    for (const e of entries) {
      cache.set(e.key, {
        priceMinorUnits: e.priceMinorUnits,
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

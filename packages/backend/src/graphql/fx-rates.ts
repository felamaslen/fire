import assert from "node:assert";

import type { Float } from "grats";
import { LRUCache } from "lru-cache";

import { HOME_CURRENCY } from "@/config";
import { env } from "@/env";

import { assertCurrencyCode } from "./money";

/** Live exchange rate for a single currency against the server's home currency. @gqlType */
export type CurrencyExchangeRate = {
  /** ISO-4217 code of the home currency `rate` is quoted into (the server's configured `currencyDefault`). @gqlField */
  base: string;
  /** ISO-4217 code of the foreign currency (e.g. `"USD"`). @gqlField */
  currency: string;
  /** Units of `base` per 1 unit of `currency`. @gqlField */
  rate: Float;
};

/** Per-currency cache of "units of currency per 1 USD", populated from the openexchangerates `latest.json` endpoint. We cache against the API's USD base so a single fetch covers every requested currency, with a 5-minute TTL per entry. */
const usdRateCache = new LRUCache<string, number>({
  max: 200,
  ttl: 5 * 60 * 1000,
});

/** @internal Test helper. */
export function _resetCurrencyExchangeRateCacheForTests(): void {
  usdRateCache.clear();
}

async function fetchUsdRates(symbols: string[]): Promise<void> {
  if (symbols.length === 0) return;
  assert(
    env.OPENEXCHANGERATES_APP_ID,
    "FX rates are disabled — set `OPENEXCHANGERATES_APP_ID` on the server.",
  );
  const url = `https://openexchangerates.org/api/latest.json?app_id=${encodeURIComponent(env.OPENEXCHANGERATES_APP_ID)}&symbols=${symbols.join(",")}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`openexchangerates: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as { rates?: Record<string, number> };
  assert(body.rates, "openexchangerates returned no rates");
  for (const [code, rate] of Object.entries(body.rates)) {
    usdRateCache.set(code, rate);
  }
}

/**
 * Fetch live exchange rates for one or more foreign currencies, quoted into the server's home currency (see `currencyDefault`). Each returned `rate` is in units of the home currency per 1 unit of the foreign currency. Rates are pulled from openexchangerates.org and cached server-side for 5 minutes per currency.
 *
 * @gqlQueryField
 * @gqlAnnotate semanticNonNull
 */
export async function currencyExchangeRates(
  /** ISO-4217 codes to look up against the home currency. The home currency itself is silently skipped. */
  currencies: string[],
): Promise<CurrencyExchangeRate[] | null> {
  for (const code of currencies) assertCurrencyCode(code);

  const wanted = Array.from(
    new Set([HOME_CURRENCY, ...currencies.filter((c) => c !== HOME_CURRENCY)]),
  );
  const missing = wanted.filter((c) => usdRateCache.get(c) === undefined);
  await fetchUsdRates(missing);

  const homePerUsd = usdRateCache.get(HOME_CURRENCY);
  assert(
    homePerUsd != null,
    `openexchangerates didn't return a rate for ${HOME_CURRENCY}`,
  );

  const out: CurrencyExchangeRate[] = [];
  for (const code of currencies) {
    if (code === HOME_CURRENCY) continue;
    const codePerUsd = usdRateCache.get(code);
    if (codePerUsd == null) continue;
    out.push({
      base: HOME_CURRENCY,
      currency: code,
      rate: homePerUsd / codePerUsd,
    });
  }
  return out;
}

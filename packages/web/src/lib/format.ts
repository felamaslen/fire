/**
 * `Intl.NumberFormat` is expensive to construct, so every formatter in the
 * app routes through the cache below. Keyed on the stringified args so the
 * same `(locale, options)` pair always hits the same instance.
 */
const cache = new Map<string, Intl.NumberFormat>();

export function numberFormat(
  locale: string | undefined,
  options: Intl.NumberFormatOptions,
): Intl.NumberFormat {
  const key = JSON.stringify([locale ?? null, options]);
  let f = cache.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale, options);
    cache.set(key, f);
  }
  return f;
}

/**
 * Format `amount` in `currency` using accounting sign (negatives wrapped in
 * parentheses, e.g. `£(2,702.35)`). Locale is pinned to `en-GB` so SSR and
 * CSR produce identical output regardless of Node's / the browser's default.
 *
 * When `compact` is true, the output uses short-scale notation (`£34.2k`,
 * `£1.2m`) with one decimal place and the KMBT suffix lower-cased to match
 * the product's style.
 */
export function formatAccountingMoney(
  currency: string,
  amount: number,
  { compact = false }: { compact?: boolean } = {},
): string {
  const f = numberFormat(
    "en-GB",
    compact
      ? {
          style: "currency",
          currency,
          currencySign: "accounting",
          notation: "compact",
          maximumFractionDigits: 1,
        }
      : {
          style: "currency",
          currency,
          currencySign: "accounting",
          maximumFractionDigits: 2,
        },
  );
  const out = f.format(amount);
  return compact ? out.replace(/([KMBT])/g, (c) => c.toLowerCase()) : out;
}

/**
 * Whole-unit variant of `formatAccountingMoney` — no decimals. Useful for
 * dense UI like chart tooltips where every pixel of width counts.
 */
export function formatAccountingMoneyRounded(
  currency: string,
  amount: number,
): string {
  return numberFormat("en-GB", {
    style: "currency",
    currency,
    currencySign: "accounting",
    maximumFractionDigits: 0,
  }).format(amount);
}

/**
 * Extract the locale-appropriate currency symbol for `currency` (e.g. `£`
 * for `GBP`). Uses the user's default locale so the symbol matches what
 * they'd see elsewhere on their system. Falls back to the raw code on
 * unsupported inputs.
 */
export function currencySymbol(currency: string): string {
  try {
    const parts = numberFormat(undefined, {
      style: "currency",
      currency,
    }).formatToParts(0);
    return parts.find((p) => p.type === "currency")?.value ?? currency;
  } catch {
    return currency;
  }
}

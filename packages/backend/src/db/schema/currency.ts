import { sql } from "drizzle-orm";
import { pgEnum } from "drizzle-orm/pg-core";
import { pgCustomSQL } from "drizzle-pgkit-migrator";

import { CURRENCIES } from "@/config";

/**
 * Order of values stored in the `CurrencyCode` Postgres enum, in the exact order they were appended by migrations `0000` (initial set) and `0004` (`ALTER TYPE … ADD VALUE`). Postgres enum order is part of the schema, so the Drizzle definition must match the migrated order to avoid drift.
 *
 * Adding a new currency goes at the end of this list and into `CURRENCIES`; new values must also land in a migration that runs `ALTER TYPE "CurrencyCode" ADD VALUE`.
 */
const CURRENCY_CODE_ENUM_ORDER = [
  "GBP",
  "USD",
  "EUR",
  "JPY",
  "CZK",
  "NOK",
  "CNY",
  "HKD",
  "AUD",
  "SCR",
  "TWD",
  "AED",
  "ARS",
  "BDT",
  "BHD",
  "BRL",
  "CAD",
  "CHF",
  "CLP",
  "COP",
  "DKK",
  "EGP",
  "GHS",
  "HUF",
  "ILS",
  "INR",
  "ISK",
  "JOD",
  "KES",
  "KRW",
  "KWD",
  "LKR",
  "MAD",
  "MXN",
  "MYR",
  "NGN",
  "NZD",
  "OMR",
  "PEN",
  "PHP",
  "PKR",
  "PLN",
  "QAR",
  "RON",
  "RSD",
  "RUB",
  "SAR",
  "SEK",
  "SGD",
  "THB",
  "TND",
  "TRY",
  "UAH",
  "UYU",
  "VES",
  "VND",
  "ZAR",
] as const satisfies readonly (keyof typeof CURRENCIES)[];

// Compile-time exhaustiveness check: every key in `CURRENCIES` must appear in `CURRENCY_CODE_ENUM_ORDER`.
type _MissingFromEnumOrder = Exclude<
  keyof typeof CURRENCIES,
  (typeof CURRENCY_CODE_ENUM_ORDER)[number]
>;
const _checkAllCurrenciesCovered: _MissingFromEnumOrder extends never
  ? true
  : ["Missing from CURRENCY_CODE_ENUM_ORDER:", _MissingFromEnumOrder] = true;
void _checkAllCurrenciesCovered;

/** ISO-4217 reporting currency codes supported across the system. Enum value set comes from `CURRENCIES` in `@/config`; the order is fixed by `CURRENCY_CODE_ENUM_ORDER` above to match the on-disk Postgres enum order produced by the migrations. */
export const currencyCode = pgEnum("CurrencyCode", CURRENCY_CODE_ENUM_ORDER);

export type CurrencyCode = (typeof currencyCode.enumValues)[number];

/** Number of fractional digits for an ISO-4217 code — `2` for GBP, `0` for JPY, `3` for KWD, etc. Mirrors `CURRENCIES[code].scale` so SQL-side amount conversion (e.g. `NetWorthEntryBuckets_refresh_fn`) doesn't have to round-trip into TypeScript. The body is generated from `CURRENCIES` at build time, so any new currency lands in both the TS config and this SQL function in a single change. */
export const Currency_scale_fn = pgCustomSQL(
  sql.raw(
    `CREATE FUNCTION "Currency_scale"(p_code "CurrencyCode") RETURNS int LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_code::text
    ${Object.entries(CURRENCIES)
      .map(([code, { scale }]) => `WHEN '${code}' THEN ${scale}`)
      .join("\n    ")}
  END;
$$;`,
  ),
  { priority: 1 },
);

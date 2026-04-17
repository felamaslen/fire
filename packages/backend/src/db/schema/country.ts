import { strict as assert } from "node:assert";

import { pgEnum } from "drizzle-orm/pg-core";

/** ISO-3166-1 alpha-2 country codes supported across the system. */
export const countryCode = pgEnum("CountryCode", ["GB"]);

export type CountryCode = (typeof countryCode.enumValues)[number];

/** Narrow a client-supplied string into the `CountryCode` enum. Throws on unsupported values. */
export function assertCountryCode(s: string): asserts s is CountryCode {
  assert(
    (countryCode.enumValues as readonly string[]).includes(s),
    `Unsupported country: ${s}`,
  );
}

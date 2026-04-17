import { pgEnum } from "drizzle-orm/pg-core";

import { CURRENCIES } from "@/config";

/** ISO-4217 reporting currency codes supported across the system. Enum values come from `CURRENCIES` in `@/config` so the DB enum and the runtime metadata (scales, etc.) stay in lockstep. */
export const currencyCode = pgEnum(
  "CurrencyCode",
  Object.keys(CURRENCIES) as [
    keyof typeof CURRENCIES,
    ...(keyof typeof CURRENCIES)[],
  ],
);

export type CurrencyCode = (typeof currencyCode.enumValues)[number];

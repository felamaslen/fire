import { pgEnum } from "drizzle-orm/pg-core";

/** ISO-4217 reporting currency codes supported across the system. */
export const currencyCode = pgEnum("CurrencyCode", [
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
]);

export type CurrencyCode = (typeof currencyCode.enumValues)[number];

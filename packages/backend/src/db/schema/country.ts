import { pgEnum } from "drizzle-orm/pg-core";

/** ISO-3166-1 alpha-2 country codes supported across the system. */
export const countryCode = pgEnum("CountryCode", ["GB"]);

export type CountryCode = (typeof countryCode.enumValues)[number];

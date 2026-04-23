import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  integer,
  pgTable,
  timestamp,
} from "drizzle-orm/pg-core";

import { currencyCode } from "./currency";

/**
 * Singleton row holding app-wide settings that don't belong to any other domain object. The `singleton` column is pinned to `true` by a check constraint so there can only ever be one row. New settings are added as nullable columns — a missing row means "no settings configured yet" and every column defaults to its null semantics.
 */
export const AppSettings = pgTable(
  "AppSettings",
  {
    singleton: boolean("singleton").primaryKey(),
    /** Portfolio-wide target cash reserve as an absolute monetary value (applied across all investment wrappers in aggregate). Null until set. Non-negative. */
    cashAllocationAmount: bigint("cashAllocationAmount", { mode: "number" }),
    /** ISO-4217 currency the cash-allocation target is denominated in. Paired with `cashAllocationAmount` — either both set or both null. */
    cashAllocationCurrency: currencyCode("cashAllocationCurrency"),
    /** Calendar year the user plans to retire in. Null until set. The first day of this year is when the retirement forecast takes effect: income drops to zero, portfolio drawdown begins, spending continues with inflation. */
    retirementYear: integer("retirementYear"),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check("AppSettings_singleton_ck", sql`${t.singleton} = true`),
    check(
      "AppSettings_cashAllocationAmount_ck",
      sql`${t.cashAllocationAmount} IS NULL OR ${t.cashAllocationAmount} >= 0`,
    ),
    check(
      "AppSettings_cashAllocationPair_ck",
      sql`(${t.cashAllocationAmount} IS NULL) = (${t.cashAllocationCurrency} IS NULL)`,
    ),
    check(
      "AppSettings_retirementYear_ck",
      sql`${t.retirementYear} IS NULL OR ${t.retirementYear} BETWEEN 1900 AND 2200`,
    ),
  ],
);

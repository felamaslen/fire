import { relations, sql } from "drizzle-orm";
import { check, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { currencyCode } from "./currency";

/** A tradable holding — a stock (identified by ticker) or a fund (identified by a URL to the product page). */
export const Investments = pgTable(
  "Investments",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    name: text("name").notNull(),
    /** Ticker on the relevant exchange, e.g. `SMT.L`, `AAPL`. Set iff this is a listed stock. */
    stockCode: text("stockCode"),
    /** URL to the fund's product page (e.g. a Hargreaves Lansdown page). Set iff this is a fund. */
    fundLink: text("fundLink"),
    /** Quote currency. All transactions and prices for this investment must match. */
    currency: currencyCode("currency").notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "Investments_stockCode_fundLink_ck",
      sql`(${t.stockCode} IS NOT NULL)::int + (${t.fundLink} IS NOT NULL)::int = 1`,
    ),
  ],
);

export const investmentsRelations = relations(Investments, () => ({}));

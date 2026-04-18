import { strict as assert } from "node:assert";

import type { Float } from "grats";

import { CURRENCIES, HOME_CURRENCY } from "@/config";
import { type CurrencyCode, currencyCode } from "@/db/schema/currency";

export { CURRENCIES };

/**
 * ISO-4217 code of the server's configured home currency (e.g. `"GBP"`). Used by clients as the default currency when the user has not configured any currency rates on an entry.
 *
 * @gqlQueryField
 * @gqlAnnotate semanticNonNull
 */
export function currencyDefault(): string | null {
  return HOME_CURRENCY;
}

/** Metadata for a currency supported by the server. @gqlType */
export type Currency = {
  /** ISO-4217 three-letter code (e.g. `"USD"`). @gqlField */
  code: string;
  /** Human-readable currency name (e.g. `"United States dollar"`). @gqlField */
  name: string;
};

/**
 * Every currency code the server accepts for money inputs, paired with a human-readable name. Use this to populate currency pickers.
 *
 * @gqlQueryField
 * @gqlAnnotate semanticNonNull
 */
export function currencies(): Currency[] | null {
  return Object.entries(CURRENCIES).map(([code, c]) => ({
    code,
    name: c.name,
  }));
}

export function assertCurrencyCode(s: string): asserts s is CurrencyCode {
  assert(
    (currencyCode.enumValues as readonly string[]).includes(s),
    `Unsupported currency: ${s}`,
  );
}

/** A monetary value with an ISO-4217 currency. `amount` is in major units (e.g. 123.45 for £123.45). @gqlType */
export class Money {
  /** Amount in major units of `currency` (e.g. 123.45 for £123.45). @gqlField */
  readonly amount: Float;
  /** ISO-4217 currency code (e.g. "GBP"). @gqlField */
  readonly currency: string;

  private constructor(amountMinor: number, currency: CurrencyCode) {
    const { scale } = CURRENCIES[currency];
    this.amount = amountMinor / 10 ** scale;
    this.currency = currency;
  }

  /** Build a Money from a minor-denomination integer (e.g. 12345 pence → £123.45). */
  static fromMinorDenomination(amount: number, currency: string): Money {
    assertCurrencyCode(currency);
    return new Money(amount, currency);
  }
}

/** Client-supplied monetary value. `amount` is in major units of `currency` (e.g. 123.45 for £123.45). @gqlInput */
export type MoneyInput = {
  /** Amount in major units of `currency` (e.g. 123.45 for £123.45). */
  amount: Float;
  /** ISO-4217 currency code (e.g. "GBP"). */
  currency: string;
};

/**
 * Validate a MoneyInput and return the amount in the currency's minor denomination as an integer.
 * Throws if the currency is not supported.
 */
export function getMoneyInputFractionalAmount(input: MoneyInput): {
  currency: CurrencyCode;
  amount: number;
} {
  assertCurrencyCode(input.currency);
  const { scale } = CURRENCIES[input.currency];
  const amount = Math.round(input.amount * 10 ** scale);
  return { currency: input.currency, amount };
}

/**
 * Validate a MoneyInput and return the amount in the currency's minor denomination without rounding. Suitable for sub-penny-precision fields stored as `double precision` (e.g. `InvestmentPrices.price`).
 */
export function getMoneyInputFractionalAmountDouble(input: MoneyInput): {
  currency: CurrencyCode;
  amount: number;
} {
  assertCurrencyCode(input.currency);
  const { scale } = CURRENCIES[input.currency];
  return { currency: input.currency, amount: input.amount * 10 ** scale };
}

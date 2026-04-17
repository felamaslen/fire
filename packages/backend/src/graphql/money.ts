import { strict as assert } from "node:assert";

import type { Float } from "grats";

import { CURRENCIES } from "@/config";
import { type CurrencyCode, currencyCode } from "@/db/schema/currency";

export { CURRENCIES };

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

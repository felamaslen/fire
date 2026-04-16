import { strict as assert } from "node:assert";

import type { Float } from "grats";

import { type CurrencyCode, currencyCode } from "@/db/schema/currency";

/** Per-currency metadata used to translate between major and minor denominations. */
export const CURRENCIES: Record<
  CurrencyCode,
  {
    /** Number of fractional digits in the currency's minor denomination (2 for GBP/USD, 0 for JPY, ...). */
    scale: number;
  }
> = {
  GBP: { scale: 2 }, // penny (1/100 pound)
  USD: { scale: 2 }, // cent (1/100 dollar)
  EUR: { scale: 2 }, // cent (1/100 euro)
  JPY: { scale: 0 }, // no minor unit (sen withdrawn 1953)
  CZK: { scale: 2 }, // haléř (1/100 koruna — no longer minted, still ISO's minor unit)
  NOK: { scale: 2 }, // øre (1/100 krone — no longer minted, still ISO's minor unit)
  CNY: { scale: 2 }, // fen (分, 1/100 yuan — jiao is 1/10 but ISO uses fen)
  HKD: { scale: 2 }, // cent (1/100 dollar)
  AUD: { scale: 2 }, // cent (1/100 dollar)
  SCR: { scale: 2 }, // cent (1/100 rupee)
  TWD: { scale: 2 }, // fen (分, 1/100 new dollar)
};

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

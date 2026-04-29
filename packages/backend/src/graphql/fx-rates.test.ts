import { graphql, runGql } from "#test/gql";
import { http, HttpResponse, useMswServer } from "#test/msw";

import { _resetCurrencyExchangeRateCacheForTests } from "./fx-rates";

const server = useMswServer();

const RATES_URL = "https://openexchangerates.org/api/latest.json";

/** Fixture captured from a real `https://openexchangerates.org/api/latest.json?symbols=GBP,USD,EUR,JPY` call. Each value is "units of <currency> per 1 USD" — the free-tier API always bases at USD. */
const REAL_USD_RATES: Record<string, number> = {
  EUR: 0.85644,
  GBP: 0.742031,
  JPY: 160.38253571,
  USD: 1,
};

const CurrencyExchangeRatesDocument = graphql(`
  query CurrencyExchangeRatesTest($currencies: [String!]!) {
    currencyExchangeRates(currencies: $currencies) {
      base
      currency
      rate
    }
  }
`);

beforeEach(() => {
  _resetCurrencyExchangeRateCacheForTests();
});

function ratesHandler(
  rates: Record<string, number> = REAL_USD_RATES,
  hits: { count: number; symbols: string[] } = { count: 0, symbols: [] },
) {
  return http.get(RATES_URL, ({ request }) => {
    hits.count += 1;
    const symbols = new URL(request.url).searchParams.get("symbols") ?? "";
    hits.symbols.push(symbols);
    const wanted = new Set(symbols.split(","));
    const filtered = Object.fromEntries(
      Object.entries(rates).filter(([k]) => wanted.has(k)),
    );
    return HttpResponse.json({ base: "USD", rates: filtered });
  });
}

it("returns rates quoted into the home currency (units of base per 1 currency)", async () => {
  server.use(ratesHandler());
  const data = await runGql(CurrencyExchangeRatesDocument, {
    currencies: ["USD", "EUR", "JPY"],
  });
  // Home currency is GBP; API quotes everything against USD. To get GBP per 1
  // EUR: 1 EUR = (1 / rates.EUR) USD = (rates.GBP / rates.EUR) GBP. JPY uses
  // the same cross-rate formula.
  expect(data.currencyExchangeRates).toEqual([
    { base: "GBP", currency: "USD", rate: REAL_USD_RATES.GBP },
    {
      base: "GBP",
      currency: "EUR",
      rate: REAL_USD_RATES.GBP / REAL_USD_RATES.EUR,
    },
    {
      base: "GBP",
      currency: "JPY",
      rate: REAL_USD_RATES.GBP / REAL_USD_RATES.JPY,
    },
  ]);
  expect(data.currencyExchangeRates).toMatchInlineSnapshot(`
    [
      {
        "base": "GBP",
        "currency": "USD",
        "rate": 0.742031,
      },
      {
        "base": "GBP",
        "currency": "EUR",
        "rate": 0.8664132922329644,
      },
      {
        "base": "GBP",
        "currency": "JPY",
        "rate": 0.004626632174850529,
      },
    ]
  `);
});

it("skips the home currency when it appears in the request", async () => {
  server.use(ratesHandler());
  const data = await runGql(CurrencyExchangeRatesDocument, {
    currencies: ["GBP", "USD"],
  });
  expect(data.currencyExchangeRates).toEqual([
    { base: "GBP", currency: "USD", rate: REAL_USD_RATES.GBP },
  ]);
});

it("caches rates for 5 minutes — repeat queries don't re-hit the API", async () => {
  const hits = { count: 0, symbols: [] as string[] };
  server.use(ratesHandler(REAL_USD_RATES, hits));
  await runGql(CurrencyExchangeRatesDocument, { currencies: ["USD"] });
  await runGql(CurrencyExchangeRatesDocument, { currencies: ["USD"] });
  expect(hits.count).toBe(1);
});

it("only fetches currencies that aren't already cached", async () => {
  const hits = { count: 0, symbols: [] as string[] };
  server.use(ratesHandler(REAL_USD_RATES, hits));
  await runGql(CurrencyExchangeRatesDocument, { currencies: ["USD"] });
  await runGql(CurrencyExchangeRatesDocument, { currencies: ["USD", "EUR"] });
  expect(hits.count).toBe(2);
  // First fetch covered GBP+USD; second only needed EUR.
  expect(hits.symbols[1].split(",").sort()).toEqual(["EUR"]);
});

it("rejects unsupported currency codes", async () => {
  await expect(
    runGql(CurrencyExchangeRatesDocument, { currencies: ["XXX"] }),
  ).rejects.toThrowErrorMatchingInlineSnapshot(
    `[Error: GraphQL errors: Unsupported currency: XXX]`,
  );
});

it("surfaces an upstream HTTP failure", async () => {
  server.use(
    http.get(RATES_URL, () => new HttpResponse(null, { status: 503 })),
  );
  await expect(
    runGql(CurrencyExchangeRatesDocument, { currencies: ["USD"] }),
  ).rejects.toThrowErrorMatchingInlineSnapshot(
    `[Error: GraphQL errors: openexchangerates: 503 Service Unavailable]`,
  );
});

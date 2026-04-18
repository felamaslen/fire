import { http, HttpResponse, useMswServer } from "#test/msw";

import {
  fetchQuote,
  readCachedQuote,
  readOrRefresh,
  TEST__clearCacheForTesting,
} from "./yahoo";

const server = useMswServer();

const QUOTE_URL = "https://query2.finance.yahoo.com/v7/finance/quote";

type QuoteResult = {
  symbol: string;
  regularMarketPrice?: number;
  currency?: string;
};

function yahooQuoteHandler(
  quotes: QuoteResult[],
  opts: { hits?: { count: number } } = {},
) {
  return http.get(QUOTE_URL, ({ request }) => {
    if (opts.hits) opts.hits.count += 1;
    const symbols = new URL(request.url).searchParams.get("symbols") ?? "";
    const wanted = new Set(symbols.split(","));
    const result = quotes.filter((q) => wanted.has(q.symbol));
    return HttpResponse.json({
      quoteResponse: { result, error: null },
    });
  });
}

function yahooConsentHandlers() {
  return [
    http.get(
      "https://finance.yahoo.com/quote/AAPL",
      () =>
        new HttpResponse(null, {
          status: 200,
          headers: { "set-cookie": "A1=foo; Path=/" },
        }),
    ),
    http.get("https://query1.finance.yahoo.com/v1/test/getcrumb", () =>
      HttpResponse.text("test-crumb"),
    ),
  ];
}

beforeEach(() => {
  TEST__clearCacheForTesting();
  server.use(...yahooConsentHandlers());
});

describe("fetchQuote", () => {
  it("stores the converted minor-unit price and currency", async () => {
    server.use(
      yahooQuoteHandler([
        { symbol: "AAPL", regularMarketPrice: 123.45, currency: "GBP" },
      ]),
    );
    const result = await fetchQuote("AAPL");
    expect(result).toMatchObject({
      priceMinorUnits: 12345,
      currency: "GBP",
    });
    expect(readCachedQuote("AAPL")).toEqual(result);
  });

  it("dedupes concurrent fetches for the same symbol", async () => {
    const hits = { count: 0 };
    server.use(
      yahooQuoteHandler(
        [{ symbol: "AAPL", regularMarketPrice: 50, currency: "USD" }],
        { hits },
      ),
    );
    await Promise.all([
      fetchQuote("AAPL"),
      fetchQuote("AAPL"),
      fetchQuote("AAPL"),
    ]);
    expect(hits.count).toBe(1);
  });

  it("returns null when the quote has no price", async () => {
    server.use(yahooQuoteHandler([{ symbol: "BAD", currency: "GBP" }]));
    expect(await fetchQuote("BAD")).toBeNull();
  });

  it("returns null when the network call fails", async () => {
    server.use(http.get(QUOTE_URL, () => HttpResponse.error()));
    expect(await fetchQuote("ERR")).toBeNull();
  });
});

describe("readOrRefresh", () => {
  it("returns null on the first call and triggers a background fetch", async () => {
    server.use(
      yahooQuoteHandler([
        { symbol: "AAPL", regularMarketPrice: 50, currency: "GBP" },
      ]),
    );

    expect(readOrRefresh("AAPL")).toBeNull();
    await vi.waitFor(() => expect(readCachedQuote("AAPL")).not.toBeNull());
    expect(readOrRefresh("AAPL")).toMatchObject({ priceMinorUnits: 5000 });
  });

  it("serves cached quotes that are still fresh without triggering a new fetch", async () => {
    const hits = { count: 0 };
    server.use(
      yahooQuoteHandler(
        [{ symbol: "AAPL", regularMarketPrice: 50, currency: "GBP" }],
        { hits },
      ),
    );
    await fetchQuote("AAPL");
    readOrRefresh("AAPL");
    expect(hits.count).toBe(1);
  });
});

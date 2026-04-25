import { db } from "@/db";
import { Investments } from "@/db/schema/investments";
import { http, HttpResponse, useMswServer } from "#test/msw";

import { fetchQuote, TEST__clearInflightForTesting } from "./yahoo";

async function createInvestment(
  stockCode: string,
  currency: "GBP" | "USD" = "GBP",
): Promise<string> {
  const [row] = await db
    .insert(Investments)
    .values({ name: stockCode, stockCode, currency })
    .returning({ id: Investments.id });
  return row.id;
}

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
  TEST__clearInflightForTesting();
  server.use(...yahooConsentHandlers());
});

describe("fetchQuote", () => {
  it("stores the converted minor-unit price and currency", async () => {
    server.use(
      yahooQuoteHandler([
        { symbol: "AAPL", regularMarketPrice: 123.45, currency: "GBP" },
      ]),
    );
    const id = await createInvestment("AAPL");
    const result = await fetchQuote("AAPL", {
      investmentId: id,
      currency: "GBP",
      bypassBusinessHours: true,
    });
    expect(result).toMatchObject({
      priceMinorUnits: 12345,
      currency: "GBP",
    });
  });

  it("treats GBp / GBX quotes as already being in pence", async () => {
    server.use(
      yahooQuoteHandler([
        { symbol: "EQQQ.L", regularMarketPrice: 48145, currency: "GBp" },
      ]),
    );
    const id = await createInvestment("EQQQ.L");
    const result = await fetchQuote("EQQQ.L", {
      investmentId: id,
      currency: "GBP",
      bypassBusinessHours: true,
    });
    expect(result).toMatchObject({
      priceMinorUnits: 48145,
      currency: "GBP",
    });
  });

  it("dedupes concurrent fetches for the same symbol", async () => {
    const hits = { count: 0 };
    server.use(
      yahooQuoteHandler(
        [{ symbol: "AAPL", regularMarketPrice: 50, currency: "USD" }],
        { hits },
      ),
    );
    const id = await createInvestment("AAPL", "USD");
    const opts = {
      investmentId: id,
      currency: "USD",
      bypassBusinessHours: true,
    };
    await Promise.all([
      fetchQuote("AAPL", opts),
      fetchQuote("AAPL", opts),
      fetchQuote("AAPL", opts),
    ]);
    expect(hits.count).toBe(1);
  });

  it("returns null when the quote has no price", async () => {
    server.use(yahooQuoteHandler([{ symbol: "BAD", currency: "GBP" }]));
    const id = await createInvestment("BAD");
    expect(
      await fetchQuote("BAD", {
        investmentId: id,
        currency: "GBP",
        bypassBusinessHours: true,
      }),
    ).toBeNull();
  });

  it("returns null when the network call fails", async () => {
    server.use(http.get(QUOTE_URL, () => HttpResponse.error()));
    const id = await createInvestment("ERR");
    expect(
      await fetchQuote("ERR", {
        investmentId: id,
        currency: "GBP",
        bypassBusinessHours: true,
      }),
    ).toBeNull();
  });
});

describe("business-hours gate", () => {
  it("skips the network when called for GBP outside the LSE window", async () => {
    // TEST_NOW (Sat 2026-04-18 12:00 UTC) is a weekend → outside the GBP
    // window for any time-of-day. Without `bypassBusinessHours` the call
    // must not hit Yahoo, even with no cached row to fall back to.
    const hits = { count: 0 };
    server.use(
      yahooQuoteHandler(
        [{ symbol: "AAPL", regularMarketPrice: 50, currency: "GBP" }],
        { hits },
      ),
    );
    const id = await createInvestment("AAPL");
    const result = await fetchQuote("AAPL", {
      investmentId: id,
      currency: "GBP",
    });
    expect(result).toBeNull();
    expect(hits.count).toBe(0);
  });

  it("persists the live quote to InvestmentPricesLive on success", async () => {
    server.use(
      yahooQuoteHandler([
        {
          symbol: "AAPL",
          regularMarketPrice: 123.45,
          currency: "GBP",
        },
      ]),
    );
    const id = await createInvestment("AAPL");
    await fetchQuote("AAPL", {
      investmentId: id,
      currency: "GBP",
      bypassBusinessHours: true,
    });
    const { InvestmentPricesLive } = await import("@/db/schema/investments");
    const rows = await db.select().from(InvestmentPricesLive);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      investmentId: id,
      currency: "GBP",
      price: 12345,
    });
  });
});

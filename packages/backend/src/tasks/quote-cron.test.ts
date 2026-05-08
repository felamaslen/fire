import { eq } from "drizzle-orm";

import { db } from "@/db";
import {
  InvestmentPrices,
  Investments,
  InvestmentTransactions,
} from "@/db/schema/investments";
import { NetWorthCategoryAssets } from "@/db/schema/net-worth";
import { http, HttpResponse, useMswServer } from "#test/msw";

import { refreshAllStockQuotes } from "./quote-cron";
import { TEST__clearInflightForTesting as clearInflightForTesting } from "./yahoo";

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

beforeEach(() => {
  clearInflightForTesting();
  server.use(
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
  );
});

async function createInvestment(
  name: string,
  stockCode: string | null,
  currency: "GBP" | "USD" = "GBP",
): Promise<string> {
  const [row] = await db
    .insert(Investments)
    .values({
      name,
      stockCode,
      fundLink: stockCode === null ? "https://example.com" : null,
      currency,
    })
    .returning({ id: Investments.id });
  return row.id;
}

async function createWrapper(name: string): Promise<string> {
  const [row] = await db
    .insert(NetWorthCategoryAssets)
    .values({ name, type: "STOCK" })
    .returning({ id: NetWorthCategoryAssets.id });
  return row.id;
}

async function buy(
  investmentId: string,
  assetId: string,
  units: number,
  date: string = "2024-01-01",
): Promise<void> {
  await db.insert(InvestmentTransactions).values({
    investmentId,
    assetId,
    date: new Date(date),
    units,
    price: 100,
    currency: "GBP",
  });
}

describe("refreshAllStockQuotes", () => {
  it("persists a fresh price row for each stock investment on business days", async () => {
    const id = await createInvestment("Apple", "AAPL", "GBP");
    const wrapper = await createWrapper("ISA");
    await buy(id, wrapper, 1);
    server.use(
      yahooQuoteHandler([
        { symbol: "AAPL", regularMarketPrice: 5, currency: "GBP" },
      ]),
    );

    await refreshAllStockQuotes(new Date("2024-03-04T18:00:00Z")); // Monday

    const rows = await db
      .select()
      .from(InvestmentPrices)
      .where(eq(InvestmentPrices.investmentId, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ price: 500, currency: "GBP" });
  });

  it("skips non-business days", async () => {
    await createInvestment("Apple", "AAPL", "GBP");
    const hits = { count: 0 };
    server.use(yahooQuoteHandler([], { hits }));
    await refreshAllStockQuotes(new Date("2024-03-03T18:00:00Z")); // Sunday
    expect(hits.count).toBe(0);
  });

  it("skips investments with no ticker (funds)", async () => {
    await createInvestment("Fund", null);
    const hits = { count: 0 };
    server.use(yahooQuoteHandler([], { hits }));
    await refreshAllStockQuotes(new Date("2024-03-04T18:00:00Z"));
    expect(hits.count).toBe(0);
  });

  it("skips persisting when the quote currency doesn't match", async () => {
    const id = await createInvestment("Apple", "AAPL", "GBP");
    const wrapper = await createWrapper("ISA");
    await buy(id, wrapper, 1);
    server.use(
      yahooQuoteHandler([
        { symbol: "AAPL", regularMarketPrice: 5, currency: "USD" },
      ]),
    );
    await refreshAllStockQuotes(new Date("2024-03-04T18:00:00Z"));
    const rows = await db
      .select()
      .from(InvestmentPrices)
      .where(eq(InvestmentPrices.investmentId, id));
    expect(rows).toHaveLength(0);
  });

  it("skips investments with zero held units (fully sold)", async () => {
    const id = await createInvestment("Apple", "AAPL", "GBP");
    const wrapper = await createWrapper("ISA");
    await buy(id, wrapper, 1, "2024-01-01");
    await buy(id, wrapper, -1, "2024-02-01");
    const hits = { count: 0 };
    server.use(yahooQuoteHandler([], { hits }));
    await refreshAllStockQuotes(new Date("2024-03-04T18:00:00Z"));
    expect(hits.count).toBe(0);
    const rows = await db.select().from(InvestmentPrices);
    expect(rows).toHaveLength(0);
  });

  it("upserts when a price already exists for today", async () => {
    const id = await createInvestment("Apple", "AAPL", "GBP");
    const wrapper = await createWrapper("ISA");
    await buy(id, wrapper, 1);
    const today = new Date(Date.UTC(2024, 2, 4));
    await db.insert(InvestmentPrices).values({
      investmentId: id,
      date: today,
      price: 111,
      currency: "GBP",
    });
    server.use(
      yahooQuoteHandler([
        { symbol: "AAPL", regularMarketPrice: 5, currency: "GBP" },
      ]),
    );
    await refreshAllStockQuotes(new Date("2024-03-04T18:00:00Z"));
    const rows = await db
      .select()
      .from(InvestmentPrices)
      .where(eq(InvestmentPrices.investmentId, id));
    expect(rows).toHaveLength(1);
    expect(rows[0].price).toBe(500);
  });
});

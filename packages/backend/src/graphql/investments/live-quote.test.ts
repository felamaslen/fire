import { fetchQuote, TEST__clearCacheForTesting } from "@/tasks/yahoo";
import { graphql, runGql } from "#test/gql";
import { http, HttpResponse, useMswServer } from "#test/msw";

const server = useMswServer();

const QUOTE_URL = "https://query2.finance.yahoo.com/v7/finance/quote";

function yahooHandlers(
  regularMarketPrice: number,
  currency: string,
  regularMarketPreviousClose?: number,
) {
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
      HttpResponse.text("crumb"),
    ),
    http.get(QUOTE_URL, ({ request }) => {
      const symbols = new URL(request.url).searchParams.get("symbols") ?? "";
      return HttpResponse.json({
        quoteResponse: {
          result: [
            {
              symbol: symbols,
              regularMarketPrice,
              regularMarketPreviousClose,
              currency,
            },
          ],
          error: null,
        },
      });
    }),
  ];
}

beforeEach(() => {
  TEST__clearCacheForTesting();
});

async function createInvestment(): Promise<string> {
  const doc = graphql(`
    mutation {
      investmentCreate(
        name: "Apple"
        currency: "GBP"
        asset: { stock: { code: "AAPL" } }
      ) {
        id
      }
    }
  `);
  const data = await runGql(doc, {});
  return data.investmentCreate.id;
}

async function createAsset(): Promise<string> {
  const doc = graphql(`
    mutation {
      netWorthCategoryCreate(input: { asset: { name: "ISA", type: STOCK } }) {
        id
      }
    }
  `);
  const data = await runGql(doc, {});
  return data.netWorthCategoryCreate.id;
}

async function buy(
  investmentId: string,
  assetId: string,
  units: number,
  priceAmount: number,
): Promise<void> {
  const doc = graphql(`
    mutation ($investmentId: ID!, $assetId: ID!, $units: Int!, $price: Float!) {
      investmentTransactionCreate(
        investmentId: $investmentId
        assetId: $assetId
        date: "2024-01-01"
        units: $units
        price: { amount: $price, currency: "GBP" }
      ) {
        id
      }
    }
  `);
  await runGql(doc, { investmentId, assetId, units, price: priceAmount });
}

async function setCachedPrice(
  investmentId: string,
  date: string,
  price: number,
): Promise<void> {
  const { db } = await import("@/db");
  const { InvestmentPrices } = await import("@/db/schema/investments");
  await db.insert(InvestmentPrices).values({
    investmentId,
    date: new Date(date),
    price,
    currency: "GBP",
  });
}

const POSITION_QUERY = graphql(`
  query {
    investments {
      edges {
        node {
          position {
            totalValue {
              amount
            }
            dailyGainValue {
              amount
            }
          }
        }
      }
    }
  }
`);

describe("dailyGain uses live quote when available", () => {
  it("compares the live quote to the quote's own previousClose", async () => {
    const id = await createInvestment();
    const asset = await createAsset();
    await buy(id, asset, 10, 5);
    // Cached close exists but dailyGain ignores it — the live quote's
    // `regularMarketPreviousClose` is authoritative.
    await setCachedPrice(id, "2024-01-01", 500);

    server.use(...yahooHandlers(7, "GBP", 6.5));
    await fetchQuote("AAPL");

    const data = await runGql(POSITION_QUERY, {});
    const pos = data.investments?.edges[0]?.node.position;
    // Live 7 GBP = 700 pence, previousClose 6.5 GBP = 650 pence. Daily move
    // per share is 50 pence — comes from Yahoo's previousClose, NOT from
    // the cached 500-pence close (which would give a fake +200 / share).
    expect(pos?.totalValue?.amount).toBeCloseTo(10 * 7);
    expect(pos?.dailyGainValue?.amount).toBeCloseTo(10 * (7 - 6.5));
  });

  it("is null when the live quote has no previousClose", async () => {
    const id = await createInvestment();
    const asset = await createAsset();
    await buy(id, asset, 10, 5);
    await setCachedPrice(id, "2024-01-01", 500);

    server.use(...yahooHandlers(7, "GBP"));
    await fetchQuote("AAPL");

    const data = await runGql(POSITION_QUERY, {});
    const pos = data.investments?.edges[0]?.node.position;
    expect(pos?.dailyGainValue).toBeNull();
  });

  it("regression: a long-stale cached close never leaks into dailyGain", async () => {
    // When the cached price history stops years ago (e.g. a data source
    // lapsed) and the ticker later trades again, the old code promoted the
    // stale close into `pricePrevious` when the live quote arrived, so
    // `dailyGain = live − ancient_close` reported a multi-year move as a
    // single "daily" gain. The fix sources `pricePrevious` strictly from
    // the live quote's own `regularMarketPreviousClose`.
    const id = await createInvestment();
    const asset = await createAsset();
    await buy(id, asset, 10, 5);
    // Last cached close is two years old.
    await setCachedPrice(id, "2024-01-01", 200);

    // Today live is 2.10 GBP with a genuine previousClose of 2.12 — i.e.
    // the stock is actually DOWN today. The old logic would have reported
    // dailyGain = (210 − 200) × 10 = +100 using the ancient close.
    server.use(...yahooHandlers(2.1, "GBP", 2.12));
    await fetchQuote("AAPL");

    const data = await runGql(POSITION_QUERY, {});
    const pos = data.investments?.edges[0]?.node.position;
    expect(pos?.totalValue?.amount).toBeCloseTo(10 * 2.1);
    // (2.10 − 2.12) × 10 units = −0.20 → minor units −20 → amount −0.20 GBP.
    expect(pos?.dailyGainValue?.amount).toBeCloseTo(10 * (2.1 - 2.12));
  });

  it("ignores the live quote when its currency doesn't match", async () => {
    const id = await createInvestment();
    const asset = await createAsset();
    await buy(id, asset, 10, 5);
    await setCachedPrice(id, "2024-01-01", 500);

    server.use(...yahooHandlers(7, "USD", 6.5));
    await fetchQuote("AAPL");

    const doc = graphql(`
      query {
        investments {
          edges {
            node {
              position {
                totalValue {
                  amount
                }
              }
            }
          }
        }
      }
    `);
    const data = await runGql(doc, {});
    expect(
      data.investments?.edges[0]?.node.position?.totalValue?.amount,
    ).toBeCloseTo(10 * 5);
  });
});

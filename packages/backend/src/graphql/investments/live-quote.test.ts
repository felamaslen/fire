import { fetchQuote, TEST__clearCacheForTesting } from "@/tasks/yahoo";
import { graphql, runGql } from "#test/gql";
import { http, HttpResponse, useMswServer } from "#test/msw";

const server = useMswServer();

const QUOTE_URL = "https://query2.finance.yahoo.com/v7/finance/quote";

function yahooHandlers(regularMarketPrice: number, currency: string) {
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

describe("dailyGain uses live quote when available", () => {
  it("compares live quote to yesterday's close", async () => {
    const id = await createInvestment();
    const asset = await createAsset();
    await buy(id, asset, 10, 5);
    await setCachedPrice(id, "2024-01-01", 500);

    server.use(...yahooHandlers(7, "GBP"));
    await fetchQuote("AAPL"); // prime the LRU cache

    const doc = graphql(`
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
    const data = await runGql(doc, {});
    const pos = data.investments?.edges[0]?.node.position;
    // Live quote is 7 GBP = 700 pence; yesterday 500 pence.
    expect(pos?.totalValue?.amount).toBeCloseTo(10 * 7);
    expect(pos?.dailyGainValue?.amount).toBeCloseTo(10 * (7 - 5));
  });

  it("ignores the live quote when its currency doesn't match", async () => {
    const id = await createInvestment();
    const asset = await createAsset();
    await buy(id, asset, 10, 5);
    await setCachedPrice(id, "2024-01-01", 500);

    server.use(...yahooHandlers(7, "USD"));
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

import { eq } from "drizzle-orm";

import { db } from "@/db";
import { InvestmentPricesLive } from "@/db/schema/investments";
import {
  fetchQuote,
  TEST__clearInflightForTesting,
  TEST__drainInflightForTesting,
} from "@/tasks/yahoo";
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
  TEST__clearInflightForTesting();
});

async function createInvestment(
  name = "Apple",
  code = "AAPL",
): Promise<string> {
  const doc = graphql(`
    mutation ($name: String!, $code: String!) {
      investmentCreate(
        name: $name
        currency: "GBP"
        asset: { stock: { code: $code } }
      ) {
        id
      }
    }
  `);
  const data = await runGql(doc, { name, code });
  return data.investmentCreate.id;
}

async function createAsset(name = "ISA"): Promise<string> {
  const doc = graphql(`
    mutation ($name: String!) {
      netWorthCategoryCreate(input: { asset: { name: $name, type: STOCK } }) {
        id
      }
    }
  `);
  const data = await runGql(doc, { name });
  return data.netWorthCategoryCreate.id;
}

async function createTransfer(
  assetIdFrom: string,
  assetIdTo: string,
  date: string,
): Promise<void> {
  const doc = graphql(`
    mutation ($from: ID!, $to: ID!, $date: Date!) {
      assetStockTransferCreate(
        assetIdFrom: $from
        assetIdTo: $to
        date: $date
      ) {
        id
      }
    }
  `);
  await runGql(doc, { from: assetIdFrom, to: assetIdTo, date });
}

async function buy(
  investmentId: string,
  assetId: string,
  units: number,
  priceAmount: number,
  date = "2024-01-01",
): Promise<void> {
  const doc = graphql(`
    mutation (
      $investmentId: ID!
      $assetId: ID!
      $units: Float!
      $price: Float!
      $date: Date!
    ) {
      investmentTransactionCreate(
        investmentId: $investmentId
        assetId: $assetId
        date: $date
        units: $units
        price: { amount: $price, currency: "GBP" }
      ) {
        id
      }
    }
  `);
  await runGql(doc, { investmentId, assetId, units, price: priceAmount, date });
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
    await fetchQuote("AAPL", {
      investmentId: id,
      currency: "GBP",
      bypassBusinessHours: true,
    });

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
    await fetchQuote("AAPL", {
      investmentId: id,
      currency: "GBP",
      bypassBusinessHours: true,
    });

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
    await fetchQuote("AAPL", {
      investmentId: id,
      currency: "GBP",
      bypassBusinessHours: true,
    });

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
    await fetchQuote("AAPL", {
      investmentId: id,
      currency: "GBP",
      bypassBusinessHours: true,
    });

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

describe("triggerLiveRefreshes skips fully-sold investments", () => {
  it("doesn't fetch a Yahoo quote for an investment with net-zero units", async () => {
    // Two investments on different tickers so each gets its own fetchQuote
    // call (the inflight map is keyed by symbol). AAPL is still held;
    // MSFT has been fully sold.
    const heldId = await createInvestment("Apple", "AAPL");
    const soldId = await createInvestment("Microsoft", "MSFT");
    const asset = await createAsset();
    await buy(heldId, asset, 10, 5);
    await buy(soldId, asset, 10, 5);
    await buy(soldId, asset, -10, 6);

    server.use(...yahooHandlers(7, "GBP", 6.5));

    // Run the list query — this is what triggers `triggerLiveRefreshes`.
    // Selecting `position` is what pulls the per-investment slice rows
    // through the stats loader, which is where `triggerLiveRefreshes` runs.
    const LIST_QUERY = graphql(`
      query {
        investments {
          edges {
            node {
              id
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
    await runGql(LIST_QUERY, {});
    await TEST__drainInflightForTesting();

    const liveRows = await db
      .select()
      .from(InvestmentPricesLive)
      .where(eq(InvestmentPricesLive.investmentId, soldId));
    expect(liveRows).toEqual([]);

    // Sanity check: the held investment did get a live row, so the
    // refresh path is wired up — the sold one's absence is a deliberate
    // skip, not a side-effect of the test set-up.
    const heldRows = await db
      .select()
      .from(InvestmentPricesLive)
      .where(eq(InvestmentPricesLive.investmentId, heldId));
    expect(heldRows).toHaveLength(1);
  });

  it("skips when units were transferred across wrappers and then sold", async () => {
    // The transfer model leaves the original buy on the source wrapper's
    // slice (+10) and the post-transfer sell on the destination's slice
    // (−10), so a per-slice `unitsHeld > 0` check would still see the source
    // row and fire a quote. The net across the investment is zero — fully
    // sold — and no refresh should fire.
    const id = await createInvestment("Apple", "AAPL");
    const wrapperA = await createAsset("ISA");
    const wrapperB = await createAsset("SIPP");
    await buy(id, wrapperA, 10, 5, "2024-01-01");
    await createTransfer(wrapperA, wrapperB, "2024-02-01");
    await buy(id, wrapperB, -10, 6, "2024-03-01");

    server.use(...yahooHandlers(7, "GBP", 6.5));

    const LIST_QUERY = graphql(`
      query {
        investments {
          edges {
            node {
              id
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
    await runGql(LIST_QUERY, {});
    await TEST__drainInflightForTesting();

    const liveRows = await db
      .select()
      .from(InvestmentPricesLive)
      .where(eq(InvestmentPricesLive.investmentId, id));
    expect(liveRows).toEqual([]);
  });
});

import { graphql, runGql } from "#test/gql";

/**
 * End-to-end snapshot of every field `InvestmentsPage` reads, against a
 * fixture that deliberately exercises the tricky cross-wrapper edge cases:
 *
 * - `AAPL` held in two wrappers (ISA + SIPP) — same investment appears on
 *   multiple per-wrapper portfolio slices.
 * - `MSFT` fully sold in one wrapper (ISA) but still held in another (SIPP)
 *   — wrapper-scoped aggregates report the ISA slice as "fully sold" (value
 *   = sell proceeds) while the global aggregate sees net-held units.
 * - `AMZN` / `TSLA` / `BRK` fully sold in their one wrapper — realised
 *   gain flows into `totalGain` but `totalValue` is the sell proceeds.
 * - `GOOG` is held in a single wrapper only — the "exists in one wrapper
 *   only" baseline.
 *
 * The snapshots lock in the current behaviour so any accidental drift —
 * e.g. while consolidating the three raw-row loaders in
 * `stats.ts` / `loadHeldInvestmentsUncached` / `computeDailySeriesMinorByInvestment`
 * into fewer DB roundtrips — surfaces as a visible diff.
 */

async function createAsset(name: string): Promise<string> {
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

async function createStock(name: string, code: string): Promise<string> {
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

async function tx(
  investmentId: string,
  assetId: string,
  date: string,
  units: number,
  priceAmount: number,
): Promise<void> {
  const doc = graphql(`
    mutation (
      $investmentId: ID!
      $assetId: ID!
      $date: Date!
      $units: Int!
      $priceAmount: Float!
    ) {
      investmentTransactionCreate(
        investmentId: $investmentId
        assetId: $assetId
        date: $date
        units: $units
        price: { amount: $priceAmount, currency: "GBP" }
      ) {
        id
      }
    }
  `);
  await runGql(doc, { investmentId, assetId, date, units, priceAmount });
}

async function setPrice(
  investmentId: string,
  date: string,
  amount: number,
): Promise<void> {
  const { db } = await import("@/db");
  const { InvestmentPrices } = await import("@/db/schema/investments");
  await db.insert(InvestmentPrices).values({
    investmentId,
    date: new Date(date),
    price: amount,
    currency: "GBP",
  });
}

async function setPrices(
  investmentId: string,
  series: Array<[date: string, price: number]>,
): Promise<void> {
  for (const [date, price] of series) {
    await setPrice(investmentId, date, price);
  }
}

it("covers the InvestmentsPage surface across shared / fully-sold wrappers", async () => {
  // Wrappers.
  const isa = await createAsset("ISA");
  const sipp = await createAsset("SIPP");
  const gia = await createAsset("GIA");

  // Investments. Names are alphabetised so the default ordering out of
  // `portfolios()` (by `Investments.id`, which is `uuidv7` → insertion
  // order) matches the snapshot intuitively.
  const aapl = await createStock("Apple", "AAPL");
  const amzn = await createStock("Amazon", "AMZN");
  const brk = await createStock("Berkshire", "BRK");
  const goog = await createStock("Google", "GOOG");
  const msft = await createStock("Microsoft", "MSFT");
  const tsla = await createStock("Tesla", "TSLA");

  // AAPL — held in ISA + SIPP.
  await tx(aapl, isa, "2025-01-10", 10, 100);
  await tx(aapl, sipp, "2025-01-10", 5, 100);

  // AMZN — ISA only, fully sold.
  await tx(amzn, isa, "2025-02-01", 10, 50);
  await tx(amzn, isa, "2025-10-01", -10, 80);

  // MSFT — fully sold in ISA, still held in SIPP.
  await tx(msft, isa, "2025-03-01", 5, 200);
  await tx(msft, isa, "2025-11-01", -5, 250);
  await tx(msft, sipp, "2025-04-01", 10, 200);

  // TSLA — SIPP only, fully sold.
  await tx(tsla, sipp, "2025-05-01", 4, 500);
  await tx(tsla, sipp, "2025-12-01", -4, 700);

  // GOOG — GIA only, held.
  await tx(goog, gia, "2025-06-01", 2, 1000);

  // BRK — GIA only, fully sold.
  await tx(brk, gia, "2025-07-01", 3, 400);
  await tx(brk, gia, "2025-12-15", -3, 600);

  // Daily prices leading up to `TEST_NOW` (2026-04-18) for each held
  // investment. `InvestmentPrices.price` is in the currency's minor
  // denomination (pence for GBP) — matching the `priceMinor` the
  // `investmentTransactionCreate` mutation writes — so £150 = `15_000`.
  // Short series intentionally: the point is to exercise
  // `timeseries` / `candlestick` shape, not scale.
  await setPrices(aapl, [
    ["2026-04-14", 13_000],
    ["2026-04-15", 13_500],
    ["2026-04-16", 14_000],
    ["2026-04-17", 14_500],
    ["2026-04-18", 15_000],
  ]);
  await setPrices(msft, [
    ["2026-04-14", 27_000],
    ["2026-04-15", 28_000],
    ["2026-04-16", 28_500],
    ["2026-04-17", 29_000],
    ["2026-04-18", 30_000],
  ]);
  await setPrices(goog, [
    ["2026-04-14", 135_000],
    ["2026-04-15", 140_000],
    ["2026-04-16", 142_500],
    ["2026-04-17", 145_000],
    ["2026-04-18", 150_000],
  ]);

  const doc = graphql(`
    query InvestmentsPage($isaId: ID!, $sippId: ID!, $giaId: ID!) {
      aggregate: portfolio(skipLive: true) {
        totalValue {
          amount
          currency
        }
        totalCost {
          amount
        }
        totalGain {
          amount
        }
        percentGain
        timeseries(period: ALL) {
          initialDate
          points {
            x
            y
          }
        }
        candlestick(period: ALL) {
          initialDate
          points {
            x
            from
            to
            lo
            hi
          }
        }
      }
      aggregatePerInvestment: portfolios(skipLive: true) {
        edges {
          node {
            investment {
              name
            }
            totalValue {
              amount
            }
            totalGain {
              amount
            }
          }
        }
      }
      isa: portfolio(filterAssetIdIn: [$isaId], skipLive: true) {
        totalValue {
          amount
        }
        totalGain {
          amount
        }
      }
      isaPerInvestment: portfolios(filterAssetIdIn: [$isaId], skipLive: true) {
        edges {
          node {
            investment {
              name
            }
            totalValue {
              amount
            }
            totalGain {
              amount
            }
          }
        }
      }
      sipp: portfolio(filterAssetIdIn: [$sippId], skipLive: true) {
        totalValue {
          amount
        }
        totalGain {
          amount
        }
      }
      sippPerInvestment: portfolios(
        filterAssetIdIn: [$sippId]
        skipLive: true
      ) {
        edges {
          node {
            investment {
              name
            }
            totalValue {
              amount
            }
            totalGain {
              amount
            }
          }
        }
      }
      gia: portfolio(filterAssetIdIn: [$giaId], skipLive: true) {
        totalValue {
          amount
        }
        totalGain {
          amount
        }
      }
      giaPerInvestment: portfolios(filterAssetIdIn: [$giaId], skipLive: true) {
        edges {
          node {
            investment {
              name
            }
            totalValue {
              amount
            }
            totalGain {
              amount
            }
          }
        }
      }
    }
  `);

  const data = await runGql(doc, {
    isaId: isa,
    sippId: sipp,
    giaId: gia,
  });
  expect(data).toMatchInlineSnapshot(`
    {
      "aggregate": {
        "candlestick": {
          "initialDate": "2026-04-14",
          "points": [
            {
              "from": 7350,
              "hi": 7625,
              "lo": 7350,
              "to": 7625,
              "x": 0,
            },
            {
              "from": 7625,
              "hi": 8250,
              "lo": 7625,
              "to": 8250,
              "x": 2,
            },
          ],
        },
        "percentGain": 1.323943661971831,
        "timeseries": {
          "initialDate": "2026-04-14",
          "points": [
            {
              "x": 0,
              "y": 7350,
            },
            {
              "x": 1,
              "y": 7625,
            },
            {
              "x": 2,
              "y": 7800,
            },
            {
              "x": 3,
              "y": 7975,
            },
            {
              "x": 4,
              "y": 8250,
            },
          ],
        },
        "totalCost": {
          "amount": 3550,
        },
        "totalGain": {
          "amount": 4700,
        },
        "totalValue": {
          "amount": 8250,
          "currency": "GBP",
        },
      },
      "aggregatePerInvestment": {
        "edges": [
          {
            "node": {
              "investment": {
                "name": "Apple",
              },
              "totalGain": {
                "amount": 750,
              },
              "totalValue": {
                "amount": 2250,
              },
            },
          },
          {
            "node": {
              "investment": {
                "name": "Amazon",
              },
              "totalGain": {
                "amount": 300,
              },
              "totalValue": {
                "amount": 0,
              },
            },
          },
          {
            "node": {
              "investment": {
                "name": "Berkshire",
              },
              "totalGain": {
                "amount": 600,
              },
              "totalValue": {
                "amount": 0,
              },
            },
          },
          {
            "node": {
              "investment": {
                "name": "Google",
              },
              "totalGain": {
                "amount": 1000,
              },
              "totalValue": {
                "amount": 3000,
              },
            },
          },
          {
            "node": {
              "investment": {
                "name": "Microsoft",
              },
              "totalGain": {
                "amount": 1250,
              },
              "totalValue": {
                "amount": 3000,
              },
            },
          },
          {
            "node": {
              "investment": {
                "name": "Tesla",
              },
              "totalGain": {
                "amount": 800,
              },
              "totalValue": {
                "amount": 0,
              },
            },
          },
        ],
      },
      "gia": {
        "totalGain": {
          "amount": 1600,
        },
        "totalValue": {
          "amount": 3000,
        },
      },
      "giaPerInvestment": {
        "edges": [
          {
            "node": {
              "investment": {
                "name": "Berkshire",
              },
              "totalGain": {
                "amount": 600,
              },
              "totalValue": {
                "amount": 0,
              },
            },
          },
          {
            "node": {
              "investment": {
                "name": "Google",
              },
              "totalGain": {
                "amount": 1000,
              },
              "totalValue": {
                "amount": 3000,
              },
            },
          },
        ],
      },
      "isa": {
        "totalGain": {
          "amount": 1050,
        },
        "totalValue": {
          "amount": 1500,
        },
      },
      "isaPerInvestment": {
        "edges": [
          {
            "node": {
              "investment": {
                "name": "Apple",
              },
              "totalGain": {
                "amount": 500,
              },
              "totalValue": {
                "amount": 1500,
              },
            },
          },
          {
            "node": {
              "investment": {
                "name": "Amazon",
              },
              "totalGain": {
                "amount": 300,
              },
              "totalValue": {
                "amount": 0,
              },
            },
          },
          {
            "node": {
              "investment": {
                "name": "Microsoft",
              },
              "totalGain": {
                "amount": 250,
              },
              "totalValue": {
                "amount": 0,
              },
            },
          },
        ],
      },
      "sipp": {
        "totalGain": {
          "amount": 2050,
        },
        "totalValue": {
          "amount": 3750,
        },
      },
      "sippPerInvestment": {
        "edges": [
          {
            "node": {
              "investment": {
                "name": "Apple",
              },
              "totalGain": {
                "amount": 250,
              },
              "totalValue": {
                "amount": 750,
              },
            },
          },
          {
            "node": {
              "investment": {
                "name": "Microsoft",
              },
              "totalGain": {
                "amount": 1000,
              },
              "totalValue": {
                "amount": 3000,
              },
            },
          },
          {
            "node": {
              "investment": {
                "name": "Tesla",
              },
              "totalGain": {
                "amount": 800,
              },
              "totalValue": {
                "amount": 0,
              },
            },
          },
        ],
      },
    }
  `);
});

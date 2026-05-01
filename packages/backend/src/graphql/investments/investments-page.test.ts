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
      $units: Float!
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

async function createCashAsset(name: string): Promise<string> {
  const data = await runGql(
    graphql(`
      mutation ($name: String!) {
        netWorthCategoryCreate(input: { asset: { name: $name, type: CASH } }) {
          id
        }
      }
    `),
    { name },
  );
  return data.netWorthCategoryCreate.id;
}

async function assignPlanningAccount(assetId: string): Promise<void> {
  await runGql(
    graphql(`
      mutation ($id: ID!) {
        planningAccountAssign(assetId: $id, alias: null) {
          id
        }
      }
    `),
    { id: assetId },
  );
}

async function seedYear(year: string): Promise<void> {
  await runGql(
    graphql(`
      mutation ($y: ID!) {
        planningYearSet(year: $y) {
          id
        }
      }
    `),
    { y: year },
  );
}

async function depositToWrapper(
  monthId: string,
  cashAccountId: string,
  wrapperId: string,
  cashAmount: number,
  name: string,
): Promise<void> {
  await runGql(
    graphql(`
      mutation (
        $monthId: ID!
        $cashAccountId: ID!
        $wrapperId: ID!
        $amount: MoneyInput!
        $name: String!
      ) {
        transactionCreate(
          monthId: $monthId
          accountId: $cashAccountId
          assetId: $wrapperId
          amount: $amount
          name: $name
        ) {
          id
        }
      }
    `),
    {
      monthId,
      cashAccountId,
      wrapperId,
      amount: { amount: cashAmount, currency: "GBP" },
      name,
    },
  );
}

async function setSplit(
  investmentId: string,
  date: string,
  ratio: number,
): Promise<void> {
  const { db } = await import("@/db");
  const { InvestmentStockSplits } = await import("@/db/schema/investments");
  await db.insert(InvestmentStockSplits).values({
    investmentId,
    date: new Date(date),
    ratio: String(ratio),
  });
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

  // AAPL — held in ISA + SIPP, 2-for-1 split between the buys and today's
  // prices. Pre-split units are doubled for value / units-held aggregation;
  // `unitsPriceSum` is the cash the user actually paid and stays unchanged.
  await tx(aapl, isa, "2025-01-10", 10, 100);
  await tx(aapl, sipp, "2025-01-10", 5, 100);
  await setSplit(aapl, "2025-06-01", 2);

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

  // Planning cash deposit into the ISA wrapper: -£200 from the cash account
  // (negative is the cash-account POV) = +£200 of uninvested cash float
  // sitting in the ISA. Lifts the ISA's `totalValue` (+ rolls into the
  // aggregate) but leaves `totalGain` untouched, since cash isn't a gain.
  const current = await createCashAsset("Current");
  await assignPlanningAccount(current);
  await seedYear("2026");
  await depositToWrapper("apr-2026", current, isa, -200, "April ISA contrib");

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
        candlestick(unit: WEEK, length: 1) {
          initialDate
          points {
            x0
            x1
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
          "initialDate": "2026-04-11",
          "points": [
            {
              "from": 9300,
              "hi": 10500,
              "lo": 9300,
              "to": 10500,
              "x0": 0,
              "x1": 7,
            },
          ],
        },
        "percentGain": 1.9577464788732395,
        "timeseries": {
          "initialDate": "2026-04-14",
          "points": [
            {
              "x": 0,
              "y": 9300,
            },
            {
              "x": 1,
              "y": 9650,
            },
            {
              "x": 2,
              "y": 9900,
            },
            {
              "x": 3,
              "y": 10150,
            },
            {
              "x": 4,
              "y": 10500,
            },
          ],
        },
        "totalCost": {
          "amount": 3550,
        },
        "totalGain": {
          "amount": 6950,
        },
        "totalValue": {
          "amount": 10500,
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
                "amount": 3000,
              },
              "totalValue": {
                "amount": 4500,
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
          "amount": 2550,
        },
        "totalValue": {
          "amount": 3000,
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
                "amount": 2000,
              },
              "totalValue": {
                "amount": 3000,
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
          "amount": 2800,
        },
        "totalValue": {
          "amount": 4500,
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
                "amount": 1000,
              },
              "totalValue": {
                "amount": 1500,
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

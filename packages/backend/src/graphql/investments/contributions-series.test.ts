import { graphql, runGql } from "#test/gql";

async function createStock(name = "Apple", code = "AAPL"): Promise<string> {
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

async function tx(
  investmentId: string,
  assetId: string,
  date: string,
  units: number,
  priceAmount: number,
  opts: { drip?: boolean } = {},
): Promise<void> {
  const doc = graphql(`
    mutation (
      $investmentId: ID!
      $assetId: ID!
      $date: Date!
      $units: Float!
      $priceAmount: Float!
      $drip: Boolean!
    ) {
      investmentTransactionCreate(
        investmentId: $investmentId
        assetId: $assetId
        date: $date
        units: $units
        price: { amount: $priceAmount, currency: "GBP" }
        drip: $drip
      ) {
        id
      }
    }
  `);
  await runGql(doc, {
    investmentId,
    assetId,
    date,
    units,
    priceAmount,
    drip: opts.drip ?? false,
  });
}

const PortfolioContributionsDocument = graphql(`
  query ($period: PortfolioTimePeriod!, $length: Int) {
    portfolio {
      contributions(period: $period, length: $length) {
        currency
        initialDate
        contributions {
          x
          y
        }
        withDrips {
          x
          y
        }
      }
    }
  }
`);

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2025-04-01T00:00:00Z"), toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
});

test("returns null when there are no transactions in scope", async () => {
  await createStock();
  await createAsset();
  const data = await runGql(PortfolioContributionsDocument, {
    period: "ALL",
    length: null,
  });
  expect(data.portfolio?.contributions).toBeNull();
});

test("emits a step series of cumulative non-DRIP contributions, with DRIPs layered on top", async () => {
  const stock = await createStock();
  const asset = await createAsset();
  await tx(stock, asset, "2024-01-15", 10, 5);
  await tx(stock, asset, "2024-06-01", 4, 7, { drip: true });
  await tx(stock, asset, "2025-02-10", -2, 9);

  const data = await runGql(PortfolioContributionsDocument, {
    period: "ALL",
    length: null,
  });
  expect(data.portfolio?.contributions).toMatchInlineSnapshot(`
    {
      "contributions": [
        {
          "x": 0,
          "y": 50,
        },
        {
          "x": 392,
          "y": 32,
        },
      ],
      "currency": "GBP",
      "initialDate": "2024-01-15",
      "withDrips": [
        {
          "x": 0,
          "y": 50,
        },
        {
          "x": 138,
          "y": 78,
        },
        {
          "x": 392,
          "y": 60,
        },
      ],
    }
  `);
});

test("rejects DRIP rows with non-positive units (drip_units_ck)", async () => {
  const { db } = await import("@/db");
  const { InvestmentTransactions } = await import("@/db/schema/investments");
  const stockId = await createStock();
  const assetId = await createAsset();
  let cause: unknown;
  try {
    await db.insert(InvestmentTransactions).values({
      investmentId: stockId,
      assetId,
      date: new Date("2024-02-01"),
      units: -5,
      price: 4,
      currency: "GBP",
      drip: true,
    });
  } catch (e) {
    cause = (e as { cause?: unknown }).cause;
  }
  // Drizzle wraps the underlying `pg` error as `cause`; assert on the pg
  // error's message rather than the wrapping `Failed query: …` string so
  // the snapshot doesn't carry per-test UUIDs.
  expect((cause as Error | undefined)?.message).toMatchInlineSnapshot(
    `"new row for relation "InvestmentTransactions" violates check constraint "InvestmentTransactions_drip_units_ck""`,
  );
});

test("clamps the window to the period and carries pre-window totals into the x=0 anchor", async () => {
  const stock = await createStock();
  const asset = await createAsset();
  // Two pre-window contributions (carryover) and one in-window change.
  await tx(stock, asset, "2022-05-01", 100, 4);
  await tx(stock, asset, "2023-08-01", 50, 6);
  await tx(stock, asset, "2024-12-01", 10, 5);
  // DRIP entirely pre-window — should fold into the carryover too.
  await tx(stock, asset, "2023-09-01", 1, 12, { drip: true });

  const data = await runGql(PortfolioContributionsDocument, {
    period: "YEAR",
    length: 1,
  });
  expect(data.portfolio?.contributions).toMatchInlineSnapshot(`
    {
      "contributions": [
        {
          "x": 0,
          "y": 700,
        },
        {
          "x": 244,
          "y": 750,
        },
      ],
      "currency": "GBP",
      "initialDate": "2024-04-01",
      "withDrips": [
        {
          "x": 0,
          "y": 712,
        },
        {
          "x": 244,
          "y": 762,
        },
      ],
    }
  `);
});

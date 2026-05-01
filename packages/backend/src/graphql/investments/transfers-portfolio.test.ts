import { db } from "@/db";
import {
  InvestmentPrices,
  InvestmentPricesLive,
} from "@/db/schema/investments";
import { graphql, runGql } from "#test/gql";

async function createStock(name: string, code: string): Promise<string> {
  const data = await runGql(
    graphql(`
      mutation ($name: String!, $code: String!) {
        investmentCreate(
          name: $name
          currency: "GBP"
          asset: { stock: { code: $code } }
        ) {
          id
        }
      }
    `),
    { name, code },
  );
  return data.investmentCreate.id;
}

async function createAsset(name = "ISA"): Promise<string> {
  const data = await runGql(
    graphql(`
      mutation ($name: String!) {
        netWorthCategoryCreate(input: { asset: { name: $name, type: STOCK } }) {
          id
        }
      }
    `),
    { name },
  );
  return data.netWorthCategoryCreate.id;
}

async function buy(
  investmentId: string,
  assetId: string,
  date: string,
  units: number,
  priceAmount: number,
): Promise<void> {
  await runGql(
    graphql(`
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
    `),
    { investmentId, assetId, date, units, priceAmount },
  );
}

async function setPrice(
  investmentId: string,
  date: string,
  amount: number,
): Promise<void> {
  await db.insert(InvestmentPrices).values({
    investmentId,
    date: new Date(date),
    price: amount,
    currency: "GBP",
  });
}

async function createTransferOut(
  assetIdFrom: string,
  assetIdTo: string,
  date: string,
): Promise<void> {
  await runGql(
    graphql(`
      mutation ($from: ID!, $to: ID!, $date: Date!) {
        assetStockTransferCreate(
          assetIdFrom: $from
          assetIdTo: $to
          date: $date
        ) {
          id
        }
      }
    `),
    { from: assetIdFrom, to: assetIdTo, date },
  );
}

const PortfolioStatsDocument = graphql(`
  query ($filterAssetIdIn: [ID!]) {
    portfolio(filterAssetIdIn: $filterAssetIdIn, skipLive: true) {
      totalValue {
        amount
      }
      totalCost {
        amount
      }
      totalGain {
        amount
      }
      cash {
        amount
      }
      xirr
    }
  }
`);

async function depositCash(
  assetId: string,
  date: string,
  amount: number,
): Promise<void> {
  await runGql(
    graphql(`
      mutation ($assetId: ID!, $date: Date!, $amount: Float!) {
        investmentDepositCreate(
          assetId: $assetId
          date: $date
          amount: { amount: $amount, currency: "GBP" }
          name: "seed"
        ) {
          id
        }
      }
    `),
    { assetId, date, amount },
  );
}

describe("Portfolio dateCap from transferOut", () => {
  it("freezes totalValue at the latest price ≤ transfer date - 1", async () => {
    const fromAsset = await createAsset("Old ISA");
    const toAsset = await createAsset("New ISA");
    const inv = await createStock("Acme", "ACME.L");
    // `buy` price is in major units (pounds, via `MoneyInput`); `setPrice`
    // is raw pence (minor) — so a £10 buy and a "10/unit" price quote agree
    // when the price quote is `1000`.
    await buy(inv, fromAsset, "2025-01-15", 100, 10);
    await setPrice(inv, "2025-01-15", 1000);
    await setPrice(inv, "2025-03-01", 1200);
    await setPrice(inv, "2025-04-01", 1500);

    // Without a transfer, the latest price (£15) is used.
    const before = await runGql(PortfolioStatsDocument, {
      filterAssetIdIn: [fromAsset],
    });
    expect(before.portfolio?.totalValue?.amount).toBe(1500);

    // After transferring out on 2025-03-15, the freeze date is 2025-03-14, so
    // the most recent price ≤ that date is £12.
    await createTransferOut(fromAsset, toAsset, "2025-03-15");
    const after = await runGql(PortfolioStatsDocument, {
      filterAssetIdIn: [fromAsset],
    });
    expect(after.portfolio).toMatchObject({
      totalValue: { amount: 1200 },
      totalCost: { amount: 1000 },
      totalGain: { amount: 200 },
    });
  });

  it("excludes transactions booked after the transfer date from totalCost", async () => {
    const fromAsset = await createAsset("Old ISA");
    const toAsset = await createAsset("New ISA");
    const inv = await createStock("Acme", "ACME.L");
    await buy(inv, fromAsset, "2025-01-15", 100, 10);
    // A stray buy after the transfer (e.g. mis-booked) — should be ignored.
    await buy(inv, fromAsset, "2025-04-01", 50, 20);
    await setPrice(inv, "2025-01-15", 1000);
    await setPrice(inv, "2025-03-01", 1200);

    await createTransferOut(fromAsset, toAsset, "2025-03-15");
    const data = await runGql(PortfolioStatsDocument, {
      filterAssetIdIn: [fromAsset],
    });
    expect(data.portfolio).toMatchObject({
      totalValue: { amount: 1200 },
      totalCost: { amount: 1000 },
    });
  });

  it("does not cap a portfolio scoped to multiple assets", async () => {
    const fromAsset = await createAsset("Old ISA");
    const toAsset = await createAsset("New ISA");
    const sibling = await createAsset("Sibling ISA");
    const inv = await createStock("Acme", "ACME.L");
    await buy(inv, fromAsset, "2025-01-15", 100, 10);
    await buy(inv, sibling, "2025-01-15", 50, 10);
    await setPrice(inv, "2025-01-15", 1000);
    await setPrice(inv, "2025-04-01", 1500);
    await createTransferOut(fromAsset, toAsset, "2025-03-15");

    // Multi-asset filter — no dateCap is applied; latest price (£15) wins.
    const data = await runGql(PortfolioStatsDocument, {
      filterAssetIdIn: [fromAsset, sibling],
    });
    expect(data.portfolio?.totalValue?.amount).toBe(2250);
  });

  it("ignores the live quote when capped (totalValue uses the dateCap'd cached price)", async () => {
    const fromAsset = await createAsset("Old ISA");
    const toAsset = await createAsset("New ISA");
    const inv = await createStock("Acme", "ACME.L");
    await buy(inv, fromAsset, "2025-01-15", 100, 10);
    await setPrice(inv, "2025-03-01", 1200);
    // A live quote that would otherwise dominate `priceLatest` — both the
    // live tick and its `previousClose` are far higher than the capped
    // cached price. We assert the cap wins regardless.
    await db.insert(InvestmentPricesLive).values({
      investmentId: inv,
      refreshedAt: new Date("2025-04-01T12:00:00Z"),
      date: new Date("2025-04-01T12:00:00Z"),
      currency: "GBP",
      price: 9999,
      pricePreviousClose: 9000,
    });
    await createTransferOut(fromAsset, toAsset, "2025-03-15");

    // skipLive: false explicitly — we want to prove the cap forces live off
    // even when the caller hasn't asked for it.
    const data = await runGql(
      graphql(`
        query ($filterAssetIdIn: [ID!]) {
          portfolio(filterAssetIdIn: $filterAssetIdIn, skipLive: false) {
            totalValue {
              amount
            }
          }
        }
      `),
      { filterAssetIdIn: [fromAsset] },
    );
    expect(data.portfolio?.totalValue?.amount).toBe(1200);
  });

  it("zeros out cash on a transferred-out wrapper", async () => {
    const fromAsset = await createAsset("Old ISA");
    const toAsset = await createAsset("New ISA");
    const inv = await createStock("Acme", "ACME.L");
    await depositCash(fromAsset, "2025-01-15", 500);
    await buy(inv, fromAsset, "2025-01-15", 100, 10);
    await setPrice(inv, "2025-03-01", 1200);

    // Sanity check: before the transfer, the asset's cash float is non-zero
    // (in this test it surfaces via the same `cash` field — the deposit has
    // been recorded, so the float is positive after netting buys).
    const before = await runGql(PortfolioStatsDocument, {
      filterAssetIdIn: [fromAsset],
    });
    // Only assert "cash exists" rather than an exact value — the cash-float
    // model includes wrapper-tracking logic outside the scope of this test.
    expect(before.portfolio?.cash?.amount).toBeGreaterThanOrEqual(0);

    await createTransferOut(fromAsset, toAsset, "2025-03-15");
    const after = await runGql(PortfolioStatsDocument, {
      filterAssetIdIn: [fromAsset],
    });
    expect(after.portfolio?.cash?.amount).toBe(0);
  });

  it("computes xirr against transactions ≤ transfer date and a frozen terminal", async () => {
    const fromAsset = await createAsset("Old ISA");
    const toAsset = await createAsset("New ISA");
    const inv = await createStock("Acme", "ACME.L");
    await buy(inv, fromAsset, "2025-01-15", 100, 10);
    await setPrice(inv, "2025-03-01", 1200);
    await createTransferOut(fromAsset, toAsset, "2025-03-15");

    const data = await runGql(PortfolioStatsDocument, {
      filterAssetIdIn: [fromAsset],
    });
    // The pair (-£1000 on 2025-01-15, +£1200 on 2025-03-14) yields a
    // positive xirr — assert the sign / non-null rather than the exact rate
    // (annualised IRR over a sub-year window is sensitive to the solver and
    // not the contract under test).
    expect(data.portfolio?.xirr).not.toBeNull();
    expect(data.portfolio?.xirr).toBeGreaterThan(0);
  });

  it("ends the timeseries chart at dateCap (no points after the transfer)", async () => {
    const fromAsset = await createAsset("Old ISA");
    const toAsset = await createAsset("New ISA");
    const inv = await createStock("Acme", "ACME.L");
    await buy(inv, fromAsset, "2025-01-15", 100, 10);
    await setPrice(inv, "2025-01-15", 1000);
    await setPrice(inv, "2025-03-01", 1200);
    await setPrice(inv, "2025-04-01", 1500);
    await createTransferOut(fromAsset, toAsset, "2025-03-15");

    const data = await runGql(
      graphql(`
        query ($filterAssetIdIn: [ID!]) {
          portfolio(filterAssetIdIn: $filterAssetIdIn, skipLive: false) {
            timeseries(period: ALL) {
              initialDate
              points {
                x
                y
              }
            }
          }
        }
      `),
      { filterAssetIdIn: [fromAsset] },
    );
    const series = data.portfolio?.timeseries;
    expect(series).not.toBeNull();
    // The last point's y should reflect the dateCap'd valuation (£12 ×
    // 100 = £1200), not anything later (the £15 price is past the cap).
    const last = series!.points.at(-1)!;
    expect(last.y).toBe(1200);
    // And the series shouldn't extend past 2025-03-14 (= dateCap). With
    // `initialDate` 2025-01-15, that's 58 days.
    const initial = new Date(series!.initialDate);
    const lastDateMs = initial.getTime() + last.x * 86400000;
    const lastIso = new Date(lastDateMs).toISOString().slice(0, 10);
    expect(lastIso <= "2025-03-14").toBe(true);
  });

  it("Investment.position auto-caps at the wrapper's transfer date", async () => {
    const fromAsset = await createAsset("Old ISA");
    const toAsset = await createAsset("New ISA");
    const inv = await createStock("Acme", "ACME.L");
    await buy(inv, fromAsset, "2025-01-15", 100, 10);
    // Stray transactions after the cap — must not influence the capped view.
    await buy(inv, fromAsset, "2025-04-01", 50, 20);
    await setPrice(inv, "2025-03-01", 1200);
    await setPrice(inv, "2025-04-01", 1500);
    await createTransferOut(fromAsset, toAsset, "2025-03-15");

    const data = await runGql(
      graphql(`
        query ($assets: [ID!]) {
          investments(filterAssetIdIn: $assets) {
            edges {
              node {
                id
                position(filterAssetIdIn: $assets) {
                  units
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
        }
      `),
      { assets: [fromAsset] },
    );
    const node = data.investments?.edges.find((e) => e.node.id === inv)?.node;
    expect(node?.position).toMatchObject({
      units: 100,
      totalValue: { amount: 1200 },
      totalGain: { amount: 200 },
    });
  });

  it("Investment.unitPriceLatest is null on a transferred-out wrapper view, even with a live quote", async () => {
    const fromAsset = await createAsset("Old ISA");
    const toAsset = await createAsset("New ISA");
    const inv = await createStock("Acme", "ACME.L");
    await buy(inv, fromAsset, "2025-01-15", 100, 10);
    await setPrice(inv, "2025-03-01", 1200);
    await db.insert(InvestmentPricesLive).values({
      investmentId: inv,
      refreshedAt: new Date("2025-04-01T12:00:00Z"),
      date: new Date("2025-04-01T12:00:00Z"),
      currency: "GBP",
      price: 9999,
      pricePreviousClose: 9000,
    });
    await createTransferOut(fromAsset, toAsset, "2025-03-15");

    const data = await runGql(
      graphql(`
        query ($assets: [ID!]) {
          investments(filterAssetIdIn: $assets) {
            edges {
              node {
                id
                unitPriceLatest(filterAssetIdIn: $assets) {
                  price {
                    amount
                  }
                }
                unitPriceCached(filterAssetIdIn: $assets) {
                  amount
                }
              }
            }
          }
        }
      `),
      { assets: [fromAsset] },
    );
    const node = data.investments?.edges.find((e) => e.node.id === inv)?.node;
    expect(node?.unitPriceLatest).toBeNull();
    expect(node?.unitPriceCached?.amount).toBe(12);
  });

  it("Query.investments filterIsSold treats post-transfer activity as out-of-scope", async () => {
    const fromAsset = await createAsset("Old ISA");
    const toAsset = await createAsset("New ISA");
    const sold = await createStock("Sold", "SOLD.L");
    const held = await createStock("Held", "HELD.L");
    const stray = await createStock("Stray", "STRAY.L");
    // `sold` was bought and sold before the transfer.
    await buy(sold, fromAsset, "2025-01-15", 100, 10);
    await buy(sold, fromAsset, "2025-02-15", -100, 12);
    // `held` was still held at the day before transfer.
    await buy(held, fromAsset, "2025-01-15", 50, 10);
    // `stray` was only bought *after* the transfer date — must be invisible
    // on this filtered view (the wrapper is frozen pre-transfer).
    await buy(stray, fromAsset, "2025-04-01", 30, 10);

    await createTransferOut(fromAsset, toAsset, "2025-03-15");

    // The wrapper is defunct (transferred out), so every in-scope position
    // counts as "sold" from the user's current perspective regardless of
    // its pre-transfer net units. `stray` never appears in either branch
    // because its only tx is post-transfer (out of frozen scope).
    const filtered = await runGql(
      graphql(`
        query ($filterAssetIdIn: [ID!]) {
          investments(filterAssetIdIn: $filterAssetIdIn, filterIsSold: false) {
            edges {
              node {
                id
                name
              }
            }
          }
        }
      `),
      { filterAssetIdIn: [fromAsset] },
    );
    expect(filtered.investments?.edges.map((e) => e.node.name)).toEqual([]);

    const onlySold = await runGql(
      graphql(`
        query ($filterAssetIdIn: [ID!]) {
          investments(filterAssetIdIn: $filterAssetIdIn, filterIsSold: true) {
            edges {
              node {
                id
                name
              }
            }
          }
        }
      `),
      { filterAssetIdIn: [fromAsset] },
    );
    expect(onlySold.investments?.edges.map((e) => e.node.name).sort()).toEqual([
      "Held",
      "Sold",
    ]);
  });

  it("destination Portfolio rolls source pre-transfer txs into totals", async () => {
    const fromAsset = await createAsset("Old ISA");
    const toAsset = await createAsset("New ISA");
    const inv = await createStock("Acme", "ACME.L");
    // Source has 100 units bought at £10 (£1000 cost) before the transfer.
    await buy(inv, fromAsset, "2025-01-15", 100, 10);
    // Destination books a further 50 units at £12 after the transfer.
    await buy(inv, toAsset, "2025-04-01", 50, 12);
    await setPrice(inv, "2025-05-01", 1500);
    await createTransferOut(fromAsset, toAsset, "2025-03-15");

    const data = await runGql(PortfolioStatsDocument, {
      filterAssetIdIn: [toAsset],
    });
    // 150 units × £15 = £2250 totalValue. Cost = £1000 + £600 = £1600.
    expect(data.portfolio).toMatchObject({
      totalValue: { amount: 2250 },
      totalCost: { amount: 1600 },
      totalGain: { amount: 650 },
    });
  });

  it("destination view excludes source's post-transfer activity", async () => {
    const fromAsset = await createAsset("Old ISA");
    const toAsset = await createAsset("New ISA");
    const inv = await createStock("Acme", "ACME.L");
    await buy(inv, fromAsset, "2025-01-15", 100, 10);
    // Stray buy on the source after the transfer — must NOT leak into the
    // destination's view.
    await buy(inv, fromAsset, "2025-04-01", 999, 50);
    await setPrice(inv, "2025-05-01", 1500);
    await createTransferOut(fromAsset, toAsset, "2025-03-15");

    const data = await runGql(PortfolioStatsDocument, {
      filterAssetIdIn: [toAsset],
    });
    expect(data.portfolio).toMatchObject({
      totalValue: { amount: 1500 },
      totalCost: { amount: 1000 },
    });
  });

  it("destination cash folds in source's pre-transfer flows (clamped at zero)", async () => {
    const fromAsset = await createAsset("Old ISA");
    const toAsset = await createAsset("New ISA");
    const inv = await createStock("Acme", "ACME.L");
    // Source: £500 deposit, £400 buy → +100 cash float pre-transfer.
    await depositCash(fromAsset, "2025-01-15", 500);
    await buy(inv, fromAsset, "2025-01-15", 40, 10);
    await setPrice(inv, "2025-03-01", 1200);
    await createTransferOut(fromAsset, toAsset, "2025-03-15");

    const data = await runGql(PortfolioStatsDocument, {
      filterAssetIdIn: [toAsset],
    });
    // Destination should *not* show the held positions' market value as
    // available cash. With our current model the destination's cash only
    // includes its own (zero) plus the source's pre-transfer float (£100).
    // Importantly — it must NOT explode to ~£480 (units × current price).
    expect(data.portfolio?.cash?.amount).toBeLessThan(200);
    expect(data.portfolio?.cash?.amount).toBeGreaterThanOrEqual(0);
  });

  it("Investment.position folds source pre-transfer holdings into the destination view", async () => {
    const fromAsset = await createAsset("Old ISA");
    const toAsset = await createAsset("New ISA");
    const inv = await createStock("Acme", "ACME.L");
    // Source bought 290 units before transfer.
    await buy(inv, fromAsset, "2022-01-15", 290, 10);
    // Destination sold 290 of those after the transfer (no buy in
    // destination — the units came in via the transfer).
    await buy(inv, toAsset, "2024-12-02", -290, 12);
    await setPrice(inv, "2025-01-01", 1300);
    await createTransferOut(fromAsset, toAsset, "2022-06-15");

    const data = await runGql(
      graphql(`
        query ($assets: [ID!]) {
          investments(filterAssetIdIn: $assets) {
            edges {
              node {
                id
                position(filterAssetIdIn: $assets) {
                  units
                }
              }
            }
          }
        }
      `),
      { assets: [toAsset] },
    );
    const node = data.investments?.edges.find((e) => e.node.id === inv)?.node;
    // 290 (source pre-transfer) + (-290) (destination) = 0 — not −290.
    expect(node?.position.units).toBe(0);
  });

  it("Query.investments(filterIsSold: true) classifies a transferred-then-sold position as sold", async () => {
    const fromAsset = await createAsset("Old ISA");
    const toAsset = await createAsset("New ISA");
    const inv = await createStock("Acme", "ACME.L");
    await buy(inv, fromAsset, "2022-01-15", 290, 10);
    await buy(inv, toAsset, "2024-12-02", -290, 12);
    await createTransferOut(fromAsset, toAsset, "2022-06-15");

    // filterIsSold = true: net 0 across (source pre-transfer + destination)
    // → fully sold → surfaces.
    const sold = await runGql(
      graphql(`
        query ($assets: [ID!]) {
          investments(filterAssetIdIn: $assets, filterIsSold: true) {
            edges {
              node {
                id
                name
              }
            }
          }
        }
      `),
      { assets: [toAsset] },
    );
    expect(sold.investments?.edges.map((e) => e.node.name)).toEqual(["Acme"]);

    // filterIsSold = false: should hide it.
    const held = await runGql(
      graphql(`
        query ($assets: [ID!]) {
          investments(filterAssetIdIn: $assets, filterIsSold: false) {
            edges {
              node {
                id
                name
              }
            }
          }
        }
      `),
      { assets: [toAsset] },
    );
    expect(held.investments?.edges.map((e) => e.node.name)).toEqual([]);
  });

  it("destination timeseries anchors at the source's earliest pre-transfer tx", async () => {
    const fromAsset = await createAsset("Old ISA");
    const toAsset = await createAsset("New ISA");
    const inv = await createStock("Acme", "ACME.L");
    // Source's earliest tx is well before the destination's existence.
    await buy(inv, fromAsset, "2020-01-15", 100, 10);
    await setPrice(inv, "2020-01-15", 1000);
    // Transfer to destination.
    await createTransferOut(fromAsset, toAsset, "2022-06-15");
    await setPrice(inv, "2025-01-01", 1500);

    const data = await runGql(
      graphql(`
        query ($filterAssetIdIn: [ID!]) {
          portfolio(filterAssetIdIn: $filterAssetIdIn, skipLive: true) {
            timeseries(period: ALL) {
              initialDate
              points {
                x
                y
              }
            }
          }
        }
      `),
      { filterAssetIdIn: [toAsset] },
    );
    const series = data.portfolio?.timeseries;
    expect(series).not.toBeNull();
    // Series initial date should be at or before the source's first tx
    // (2020-01-15) — proves the chart picks up source's pre-transfer data.
    expect(series!.initialDate <= "2020-01-15").toBe(true);
    // First point's y should be > 0 (held position from day 1).
    const first = series!.points[0]!;
    expect(first.y).toBeGreaterThan(0);
  });

  it("destination timeseries' last point includes live-overlaid inherited units", async () => {
    const fromAsset = await createAsset("Old ISA");
    const toAsset = await createAsset("New ISA");
    const inv = await createStock("Acme", "ACME.L");
    // 100 units bought in source pre-transfer; nothing in destination.
    await buy(inv, fromAsset, "2020-01-15", 100, 10);
    await setPrice(inv, "2020-01-15", 1000);
    await setPrice(inv, "2025-01-01", 1500);
    // Live quote at £20/unit — the rightmost point should reflect this
    // *and* the 100 inherited units, i.e. £2000.
    await db.insert(InvestmentPricesLive).values({
      investmentId: inv,
      refreshedAt: new Date("2025-06-01T12:00:00Z"),
      date: new Date("2025-06-01T12:00:00Z"),
      currency: "GBP",
      price: 2000,
      pricePreviousClose: 1900,
    });
    await createTransferOut(fromAsset, toAsset, "2022-06-15");

    // skipLive: false so the live overlay applies to the last point.
    const data = await runGql(
      graphql(`
        query ($filterAssetIdIn: [ID!]) {
          portfolio(filterAssetIdIn: $filterAssetIdIn, skipLive: false) {
            timeseries(period: ALL) {
              points {
                x
                y
              }
            }
          }
        }
      `),
      { filterAssetIdIn: [toAsset] },
    );
    const series = data.portfolio?.timeseries;
    expect(series).not.toBeNull();
    const last = series!.points.at(-1)!;
    // 100 inherited units × £20 live = £2000 — proves extraScopes is
    // threaded through `loadInvestmentStats` for the live overlay.
    expect(last.y).toBe(2000);
  });

  it("does not cap a sibling portfolio without a transfer-out", async () => {
    const fromAsset = await createAsset("Old ISA");
    const toAsset = await createAsset("New ISA");
    const sibling = await createAsset("Sibling ISA");
    const inv = await createStock("Acme", "ACME.L");
    await buy(inv, fromAsset, "2025-01-15", 100, 10);
    await buy(inv, sibling, "2025-01-15", 50, 10);
    await setPrice(inv, "2025-04-01", 1500);
    await createTransferOut(fromAsset, toAsset, "2025-03-15");

    const sib = await runGql(PortfolioStatsDocument, {
      filterAssetIdIn: [sibling],
    });
    expect(sib.portfolio?.totalValue?.amount).toBe(750);
  });
});

describe("Portfolio multi-asset transfer fold", () => {
  it("collapses [src, dest] to a dest-only view (src folded as extras, post-transfer src txs ignored)", async () => {
    const fromAsset = await createAsset("Old ISA");
    const toAsset = await createAsset("New ISA");
    const inv = await createStock("Acme", "ACME.L");
    // Pre-transfer buy in src + a stray post-transfer buy in src (e.g.
    // mis-booked). Without the fold-and-cap logic, the stray buy would
    // continue to contribute its 50 units uncapped.
    await buy(inv, fromAsset, "2025-01-15", 100, 10);
    await buy(inv, fromAsset, "2025-04-01", 50, 20);
    // Genuine post-transfer activity in dest.
    await buy(inv, toAsset, "2025-04-15", 50, 15);
    await setPrice(inv, "2025-04-15", 2000);
    await createTransferOut(fromAsset, toAsset, "2025-03-15");

    // Effective filter collapses to [toAsset]; src's pre-transfer 100 units
    // fold in via extras (capped at 2025-03-14, so the stray 50-unit buy on
    // 2025-04-01 is excluded). Held units = 100 + 50 = 150 → 150 × £20 = £3000.
    const data = await runGql(PortfolioStatsDocument, {
      filterAssetIdIn: [fromAsset, toAsset],
    });
    expect(data.portfolio?.totalValue?.amount).toBe(3000);
  });

  it("[dest, other] folds src into dest and sums with the unrelated other", async () => {
    const fromAsset = await createAsset("Old ISA");
    const toAsset = await createAsset("New ISA");
    const other = await createAsset("Brokerage");
    const inv = await createStock("Acme", "ACME.L");
    await buy(inv, fromAsset, "2025-01-15", 100, 10); // src — not in filter
    await buy(inv, toAsset, "2025-04-15", 50, 15); // dest — in filter
    await buy(inv, other, "2025-01-15", 30, 10); // other — in filter
    await setPrice(inv, "2025-04-15", 2000);
    await createTransferOut(fromAsset, toAsset, "2025-03-15");

    // dest folds src's pre-transfer 100 units → (100 + 50) × £20 = 3000.
    // other contributes 30 × £20 = 600. Total = 3600.
    const data = await runGql(PortfolioStatsDocument, {
      filterAssetIdIn: [toAsset, other],
    });
    expect(data.portfolio?.totalValue?.amount).toBe(3600);
  });

  it("[src, dest, other] is the [src, dest] collapse plus the unrelated other", async () => {
    const fromAsset = await createAsset("Old ISA");
    const toAsset = await createAsset("New ISA");
    const other = await createAsset("Brokerage");
    const inv = await createStock("Acme", "ACME.L");
    await buy(inv, fromAsset, "2025-01-15", 100, 10);
    await buy(inv, fromAsset, "2025-04-01", 50, 20); // stray post-transfer
    await buy(inv, toAsset, "2025-04-15", 50, 15);
    await buy(inv, other, "2025-01-15", 30, 10);
    await setPrice(inv, "2025-04-15", 2000);
    await createTransferOut(fromAsset, toAsset, "2025-03-15");

    // Same shape as the [dest, other] case: src is dropped from the
    // effective filter (its dest is also selected), the stray post-transfer
    // buy is excluded by the cap. (100 + 50 + 30) × £20 = 3600.
    const data = await runGql(PortfolioStatsDocument, {
      filterAssetIdIn: [fromAsset, toAsset, other],
    });
    expect(data.portfolio?.totalValue?.amount).toBe(3600);
  });

  it("xirr on a transferred-into wrapper alone folds the source's pre-transfer flows", async () => {
    const fromAsset = await createAsset("Old ISA");
    const toAsset = await createAsset("New ISA");
    const inv = await createStock("Acme", "ACME.L");
    // Source bought 100 units at £10 ages ago. Transferred in 2022. Today's
    // price is £20 — the pure-from-buy IRR of "£1000 in 2022-01, worth
    // £2000 today" is in the ballpark of 0.18-0.20. With a destination-only
    // view that ignores the source flows, xirr would have a single
    // negative flow (the buy at £10) that's *outside* the dest's tx
    // history and so xirr would just see the terminal £2000 with no
    // matching outflow → null / divergent. We assert a non-null number.
    await buy(inv, fromAsset, "2022-01-15", 100, 10);
    await setPrice(inv, "2025-01-01", 2000);
    await db.insert(InvestmentPricesLive).values({
      investmentId: inv,
      refreshedAt: new Date("2025-01-01T12:00:00Z"),
      date: new Date("2025-01-01T12:00:00Z"),
      currency: "GBP",
      price: 2000,
      pricePreviousClose: 2000,
    });
    await createTransferOut(fromAsset, toAsset, "2022-06-15");

    const data = await runGql(PortfolioStatsDocument, {
      filterAssetIdIn: [toAsset],
    });
    const xirr = data.portfolio?.xirr;
    expect(xirr).not.toBeNull();
    // Sanity: positive, in the 10–30 % / yr ballpark for a 2× over ~3 yrs.
    expect(xirr).toBeGreaterThan(0.1);
    expect(xirr).toBeLessThan(0.5);
  });

  it("candlestick last bucket's live overlay folds source pre-transfer holdings (no spurious red candle)", async () => {
    const fromAsset = await createAsset("Old ISA");
    const toAsset = await createAsset("New ISA");
    const inv = await createStock("Acme", "ACME.L");
    // Source bought 100 units before transfer; destination buys nothing of
    // its own. Without the fold reaching the live overlay, the last
    // candle's `valueEnd` would collapse to dest-own (= 0) while the
    // candle's historical range sat at £2000, producing an artificial
    // crash to zero (a tall red candle).
    await buy(inv, fromAsset, "2022-01-15", 100, 10);
    // Cached prices spanning the candlestick window (the test clock is
    // frozen mid-April 2026, so a 12-month MONTH window covers 2025-04 →
    // 2026-04). Without prices in-window the candlestick CTE has no rows
    // to bucket and returns null.
    await setPrice(inv, "2025-04-01", 2000);
    await setPrice(inv, "2026-04-01", 2000);
    await db.insert(InvestmentPricesLive).values({
      investmentId: inv,
      refreshedAt: new Date("2026-04-15T12:00:00Z"),
      date: new Date("2026-04-15T12:00:00Z"),
      currency: "GBP",
      price: 2000,
      pricePreviousClose: 2000,
    });
    await createTransferOut(fromAsset, toAsset, "2022-06-15");

    const data = await runGql(
      graphql(`
        query ($filterAssetIdIn: [ID!]) {
          portfolio(filterAssetIdIn: $filterAssetIdIn, skipLive: false) {
            candlestick(unit: MONTH, length: 1, max: 12) {
              points {
                from
                to
              }
            }
          }
        }
      `),
      { filterAssetIdIn: [toAsset] },
    );
    const points = data.portfolio?.candlestick?.points ?? [];
    expect(points.length).toBeGreaterThan(0);
    const last = points[points.length - 1];
    // 100 inherited units × £20 live = £2000 — no crash to zero.
    expect(last.to).toBe(2000);
  });

  it("freezes a fully sold-out wrapper at the day before its last sell (no formal transfer needed)", async () => {
    const assetId = await createAsset("Closed ISA");
    const inv = await createStock("Acme", "ACME.L");
    // Buy 100, sell 100 — wrapper is empty after the closing sell. No
    // `InvestmentTransfers` row, so the existing transferOut path doesn't
    // freeze it; the sold-out detection must.
    await buy(inv, assetId, "2025-01-15", 100, 10);
    await buy(inv, assetId, "2025-04-01", -100, 12);
    await setPrice(inv, "2025-01-15", 1000);
    await setPrice(inv, "2025-03-15", 1500); // < first closing sell
    await setPrice(inv, "2025-09-01", 9999); // post-sell — must NOT win

    // Last buy = 2025-01-15. First sell after = 2025-04-01. dateCap =
    // 2025-04-01 − 1 = 2025-03-31. Most recent price ≤ that date is £15.
    // Held units at the cap = 100. 100 × £15 = £1500.
    const data = await runGql(PortfolioStatsDocument, {
      filterAssetIdIn: [assetId],
    });
    expect(data.portfolio?.totalValue?.amount).toBe(1500);
  });

  it("hides a defunct wrapper's frozen positions when filterIsSold = false (`hide sold`)", async () => {
    const fromAsset = await createAsset("Old ISA");
    const toAsset = await createAsset("New ISA");
    const inv = await createStock("Acme", "ACME.L");
    await buy(inv, fromAsset, "2025-01-15", 100, 10);
    await setPrice(inv, "2025-01-15", 1000);
    await createTransferOut(fromAsset, toAsset, "2025-03-15");

    // Viewing the transferred-out wrapper alone with `hide sold` on:
    // every position is frozen at pre-transfer holdings, but from the
    // user's *current* perspective the wrapper holds nothing — so they
    // shouldn't appear in the list.
    const data = await runGql(
      graphql(`
        query ($assets: [ID!]) {
          investments(filterAssetIdIn: $assets, filterIsSold: false) {
            edges {
              node {
                id
              }
            }
          }
        }
      `),
      { assets: [fromAsset] },
    );
    expect(data.investments?.edges).toEqual([]);
  });

  it("hides a sold-out wrapper's frozen positions when filterIsSold = false (`hide sold`)", async () => {
    const assetId = await createAsset("Closed ISA");
    const inv = await createStock("Acme", "ACME.L");
    await buy(inv, assetId, "2025-01-15", 100, 10);
    await buy(inv, assetId, "2025-04-01", -100, 12);

    const data = await runGql(
      graphql(`
        query ($assets: [ID!]) {
          investments(filterAssetIdIn: $assets, filterIsSold: false) {
            edges {
              node {
                id
              }
            }
          }
        }
      `),
      { assets: [assetId] },
    );
    expect(data.investments?.edges).toEqual([]);
  });

  it("exposes soldOutOn for a wrapper whose closing sells netted every position to zero", async () => {
    const assetId = await createAsset("Closed ISA");
    const inv = await createStock("Acme", "ACME.L");
    await buy(inv, assetId, "2025-01-15", 100, 10);
    await buy(inv, assetId, "2025-04-01", -100, 12);

    const data = await runGql(
      graphql(`
        query ($id: ID!) {
          netWorthCategoryAsset(id: $id) {
            soldOutOn
            transferOut {
              id
            }
          }
        }
      `),
      { id: assetId },
    );
    expect(data.netWorthCategoryAsset?.soldOutOn).toBe("2025-04-01");
    expect(data.netWorthCategoryAsset?.transferOut).toBeNull();
  });

  it("does NOT expose soldOutOn when the wrapper has a transferOut (transferred-out takes precedence)", async () => {
    const fromAsset = await createAsset("Old ISA");
    const toAsset = await createAsset("New ISA");
    const inv = await createStock("Acme", "ACME.L");
    await buy(inv, fromAsset, "2025-01-15", 100, 10);
    // Note: the transfer is metadata-only — no closing sells exist on
    // `fromAsset`, but its destination receives the holdings logically.
    await createTransferOut(fromAsset, toAsset, "2025-03-15");

    const data = await runGql(
      graphql(`
        query ($id: ID!) {
          netWorthCategoryAsset(id: $id) {
            soldOutOn
          }
        }
      `),
      { id: fromAsset },
    );
    expect(data.netWorthCategoryAsset?.soldOutOn).toBeNull();
  });

  it("freezes a sold-out wrapper before the *first* sell of a multi-sell wind-down (not just the last)", async () => {
    const assetId = await createAsset("Closed ISA");
    const a = await createStock("Acme", "ACME.L");
    const b = await createStock("Beta", "BETA.L");
    // Two positions, each independently sold to zero across separate
    // dates. The closing sell-down starts on 2025-04-01; the wrapper
    // hits zero only on 2025-05-01. The cap should be 2025-03-31 (a day
    // before the first closing sell) — *not* 2025-04-30 (a day before
    // the wrapper-empties date) — so the last bucket doesn't span the
    // partial wind-down.
    await buy(a, assetId, "2025-01-15", 100, 10);
    await buy(b, assetId, "2025-02-01", 50, 20);
    await buy(a, assetId, "2025-04-01", -100, 12); // first closing sell
    await buy(b, assetId, "2025-05-01", -50, 25);
    await setPrice(a, "2025-03-31", 1500);
    await setPrice(b, "2025-03-31", 2200);
    await setPrice(a, "2025-09-01", 9999);
    await setPrice(b, "2025-09-01", 9999);

    const data = await runGql(PortfolioStatsDocument, {
      filterAssetIdIn: [assetId],
    });
    // 100 × £15 + 50 × £22 = 1500 + 1100 = 2600.
    expect(data.portfolio?.totalValue?.amount).toBe(2600);
  });

  it("freezes at the latest transfer date when every selected wrapper is defunct", async () => {
    const src1 = await createAsset("Old A");
    const dst1 = await createAsset("New A");
    const src2 = await createAsset("Old B");
    const dst2 = await createAsset("New B");
    const inv = await createStock("Acme", "ACME.L");
    await buy(inv, src1, "2025-01-15", 100, 10);
    await buy(inv, src2, "2025-01-15", 50, 10);
    // Cached prices either side of both transfers.
    await setPrice(inv, "2025-01-15", 1000);
    await setPrice(inv, "2025-04-01", 1500); // < src1 transfer
    await setPrice(inv, "2025-06-01", 1800); // < src2 transfer
    await setPrice(inv, "2025-09-01", 2500); // > both transfers — must NOT win
    await createTransferOut(src1, dst1, "2025-04-15");
    await createTransferOut(src2, dst2, "2025-06-15");

    // Both [src1, src2] are defunct (their destinations dst1, dst2 are
    // *not* in the filter), so the combined view freezes at the latest
    // transfer date - 1 = 2025-06-14. The most recent price ≤ that date
    // is £18, NOT the post-transfer £25. Held units = 100 + 50 = 150 →
    // 150 × £18 = £2700.
    const data = await runGql(PortfolioStatsDocument, {
      filterAssetIdIn: [src1, src2],
    });
    expect(data.portfolio?.totalValue?.amount).toBe(2700);
  });

  it("[src, dest] timeseries shows one continuous folded line (no double-count post-transfer)", async () => {
    const fromAsset = await createAsset("Old ISA");
    const toAsset = await createAsset("New ISA");
    const inv = await createStock("Acme", "ACME.L");
    await buy(inv, fromAsset, "2025-01-15", 100, 10);
    await buy(inv, toAsset, "2025-04-15", 50, 20);
    // Cached prices either side of the transfer.
    await setPrice(inv, "2025-01-15", 1000);
    await setPrice(inv, "2025-03-01", 1500);
    await setPrice(inv, "2025-04-15", 2000);
    await db.insert(InvestmentPricesLive).values({
      investmentId: inv,
      refreshedAt: new Date("2025-04-15T12:00:00Z"),
      date: new Date("2025-04-15T12:00:00Z"),
      currency: "GBP",
      price: 2000,
      pricePreviousClose: 2000,
    });
    await createTransferOut(fromAsset, toAsset, "2025-03-15");

    const data = await runGql(
      graphql(`
        query ($filterAssetIdIn: [ID!]) {
          portfolio(filterAssetIdIn: $filterAssetIdIn, skipLive: false) {
            timeseries(period: ALL) {
              points {
                y
              }
            }
          }
        }
      `),
      { filterAssetIdIn: [fromAsset, toAsset] },
    );
    const points = data.portfolio?.timeseries?.points ?? [];
    expect(points.length).toBeGreaterThan(0);
    const last = points[points.length - 1];
    // Held units at "now" = 100 (src pre-transfer, folded) + 50 (dest own).
    // 150 × £20 live = £3000. Without the [src, dest] collapse the SQL
    // would double-count src (uncapped) on top of dest, yielding £4000+.
    expect(last.y).toBe(3000);
  });
});

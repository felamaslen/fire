import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  InvestmentPrices,
  Investments,
  InvestmentStockSplits,
  InvestmentTransactions,
  InvestmentValuePoints,
} from "@/db/schema/investments";
import { NetWorthCategoryAssets } from "@/db/schema/net-worth";

async function createWrapper(name: string): Promise<string> {
  const [row] = await db
    .insert(NetWorthCategoryAssets)
    .values({ name, type: "STOCK" })
    .returning({ id: NetWorthCategoryAssets.id });
  return row.id;
}

async function createInvestment(code: string): Promise<string> {
  const [row] = await db
    .insert(Investments)
    .values({ name: code, stockCode: code, currency: "GBP" })
    .returning({ id: Investments.id });
  return row.id;
}

async function insertTx(
  investmentId: string,
  assetId: string,
  date: string,
  units: number,
  price: number,
): Promise<string> {
  const [row] = await db
    .insert(InvestmentTransactions)
    .values({
      investmentId,
      assetId,
      date: new Date(date),
      units,
      price,
      currency: "GBP",
    })
    .returning({ id: InvestmentTransactions.id });
  return row.id;
}

async function insertPrice(
  investmentId: string,
  date: string,
  price: number,
): Promise<string> {
  const [row] = await db
    .insert(InvestmentPrices)
    .values({
      investmentId,
      date: new Date(date),
      price,
      currency: "GBP",
    })
    .returning({ id: InvestmentPrices.id });
  return row.id;
}

/** Project IVP into a stable, snapshot-friendly string keyed by `(date, investment-name, wrapper-name)`. The names are stable across test reruns; uuids aren't. Units render with trailing zeros stripped so an integer count reads as `10`, not `10.000000`. */
async function ivpSnapshot(): Promise<string> {
  const rows = await db.execute<{
    date: string;
    investmentName: string;
    wrapperName: string;
    units: number;
    value: string;
    currency: string;
  }>(sql`
    SELECT
      to_char(ivp.date, 'YYYY-MM-DD') AS date,
      i.name AS "investmentName",
      a.name AS "wrapperName",
      ivp.units AS units,
      ivp.value::text AS value,
      ivp.currency
    FROM ${InvestmentValuePoints} ivp
    INNER JOIN ${Investments} i ON i.id = ivp."investmentId"
    INNER JOIN ${NetWorthCategoryAssets} a ON a.id = ivp."assetId"
    ORDER BY ivp.date, i.name, a.name
  `);
  const records = rows.rows ?? rows;
  if (records.length === 0) return "(empty)";
  return records
    .map(
      (r) =>
        `${r.date} ${r.investmentName.padEnd(4)} ${r.wrapperName.padEnd(4)} units=${String(Number(r.units)).padStart(5)} value=${String(r.value).padStart(7)} ${r.currency}`,
    )
    .join("\n");
}

describe("InvestmentValuePoints triggers", () => {
  describe("InvestmentTransactions trigger", () => {
    it("INSERT — creates rows from the tx date through the latest known price", async () => {
      const inv = await createInvestment("AAA");
      const wrap = await createWrapper("ISA");
      await insertPrice(inv, "2026-01-01", 100);
      await insertPrice(inv, "2026-01-03", 110);
      await insertTx(inv, wrap, "2026-01-02", 10, 105);
      expect(await ivpSnapshot()).toMatchInlineSnapshot(`
        "2026-01-02 AAA  ISA  units=   10 value=   1000 GBP
        2026-01-03 AAA  ISA  units=   10 value=   1100 GBP"
      `);
    });

    it("INSERT — value = 0 explicit row when tx nets to zero (sold-out wrapper)", async () => {
      const inv = await createInvestment("BBB");
      const wrap = await createWrapper("ISA");
      await insertPrice(inv, "2026-01-01", 100);
      await insertPrice(inv, "2026-01-05", 100);
      await insertTx(inv, wrap, "2026-01-01", 10, 100);
      await insertTx(inv, wrap, "2026-01-03", -10, 100);
      // Days 2026-01-01..02 have units=10 → value=1000.
      // Days 2026-01-03..05 have units=0 → explicit value=0 (chart drops to
      // zero, doesn't forward-fill the last non-zero value).
      expect(await ivpSnapshot()).toMatchInlineSnapshot(`
        "2026-01-01 BBB  ISA  units=   10 value=   1000 GBP
        2026-01-02 BBB  ISA  units=   10 value=   1000 GBP
        2026-01-03 BBB  ISA  units=    0 value=      0 GBP
        2026-01-04 BBB  ISA  units=    0 value=      0 GBP
        2026-01-05 BBB  ISA  units=    0 value=      0 GBP"
      `);
    });

    it("INSERT — skips days where units != 0 but no price ≤ that day exists", async () => {
      const inv = await createInvestment("CCC");
      const wrap = await createWrapper("ISA");
      await insertTx(inv, wrap, "2026-01-01", 10, 100);
      await insertPrice(inv, "2026-01-03", 50);
      // 2026-01-01 and 2026-01-02 have units=10 but no price ≤ those days
      // → no rows. 2026-01-03 onwards has price → row exists.
      expect(await ivpSnapshot()).toMatchInlineSnapshot(
        `"2026-01-03 CCC  ISA  units=   10 value=    500 GBP"`,
      );
    });

    it("UPDATE — moving a tx earlier extends the IVP series back", async () => {
      const inv = await createInvestment("DDD");
      const wrap = await createWrapper("ISA");
      await insertPrice(inv, "2026-01-01", 100);
      await insertPrice(inv, "2026-01-05", 100);
      const txId = await insertTx(inv, wrap, "2026-01-04", 5, 100);
      // Before: days 04..05 covered.
      await db
        .update(InvestmentTransactions)
        .set({ date: new Date("2026-01-02") })
        .where(eq(InvestmentTransactions.id, txId));
      // After: days 02..05 covered (the moved-earlier date pulls in 02 and 03).
      expect(await ivpSnapshot()).toMatchInlineSnapshot(`
        "2026-01-02 DDD  ISA  units=    5 value=    500 GBP
        2026-01-03 DDD  ISA  units=    5 value=    500 GBP
        2026-01-04 DDD  ISA  units=    5 value=    500 GBP
        2026-01-05 DDD  ISA  units=    5 value=    500 GBP"
      `);
    });

    it("DELETE — the only tx for a wrapper removes every IVP row for that (investment, wrapper)", async () => {
      const inv = await createInvestment("EEE");
      const wrap1 = await createWrapper("ISA");
      const wrap2 = await createWrapper("SIPP");
      await insertPrice(inv, "2026-01-01", 100);
      const tx1 = await insertTx(inv, wrap1, "2026-01-01", 5, 100);
      await insertTx(inv, wrap2, "2026-01-01", 3, 100);
      await db
        .delete(InvestmentTransactions)
        .where(eq(InvestmentTransactions.id, tx1));
      // Only the SIPP slice remains.
      expect(await ivpSnapshot()).toMatchInlineSnapshot(
        `"2026-01-01 EEE  SIPP units=    3 value=    300 GBP"`,
      );
    });
  });

  describe("InvestmentPrices trigger", () => {
    it("INSERT — extends the series to the new latest price date and fills in the days between (forward-filled from the previous price)", async () => {
      const inv = await createInvestment("FFF");
      const wrap = await createWrapper("ISA");
      await insertPrice(inv, "2026-01-01", 100);
      await insertTx(inv, wrap, "2026-01-01", 10, 100);
      // First snapshot: only 2026-01-01 has a row (last price).
      expect(await ivpSnapshot()).toMatchInlineSnapshot(
        `"2026-01-01 FFF  ISA  units=   10 value=   1000 GBP"`,
      );
      // Insert a later price → the series extends to 2026-01-04, and the
      // gap days 2026-01-02 / 2026-01-03 are filled with rows that reuse
      // the 2026-01-01 price (the latest price ≤ each of those days).
      await insertPrice(inv, "2026-01-04", 120);
      expect(await ivpSnapshot()).toMatchInlineSnapshot(`
        "2026-01-01 FFF  ISA  units=   10 value=   1000 GBP
        2026-01-02 FFF  ISA  units=   10 value=   1000 GBP
        2026-01-03 FFF  ISA  units=   10 value=   1000 GBP
        2026-01-04 FFF  ISA  units=   10 value=   1200 GBP"
      `);
    });

    it("UPDATE — changing a price's value updates affected IVP rows", async () => {
      const inv = await createInvestment("GGG");
      const wrap = await createWrapper("ISA");
      await insertTx(inv, wrap, "2026-01-01", 10, 100);
      const priceId = await insertPrice(inv, "2026-01-02", 200);
      expect(await ivpSnapshot()).toMatchInlineSnapshot(
        `"2026-01-02 GGG  ISA  units=   10 value=   2000 GBP"`,
      );
      await db
        .update(InvestmentPrices)
        .set({ price: 300 })
        .where(eq(InvestmentPrices.id, priceId));
      expect(await ivpSnapshot()).toMatchInlineSnapshot(
        `"2026-01-02 GGG  ISA  units=   10 value=   3000 GBP"`,
      );
    });

    it("DELETE — affected days fall back to the previous price ≤ the date", async () => {
      const inv = await createInvestment("HHH");
      const wrap = await createWrapper("ISA");
      await insertTx(inv, wrap, "2026-01-01", 10, 100);
      await insertPrice(inv, "2026-01-01", 100);
      const newer = await insertPrice(inv, "2026-01-03", 200);
      expect(await ivpSnapshot()).toMatchInlineSnapshot(`
        "2026-01-01 HHH  ISA  units=   10 value=   1000 GBP
        2026-01-02 HHH  ISA  units=   10 value=   1000 GBP
        2026-01-03 HHH  ISA  units=   10 value=   2000 GBP"
      `);
      // Removing the newer price drops the right edge — the latest known
      // event date is now 2026-01-01.
      await db.delete(InvestmentPrices).where(eq(InvestmentPrices.id, newer));
      expect(await ivpSnapshot()).toMatchInlineSnapshot(`
        "2026-01-01 HHH  ISA  units=   10 value=   1000 GBP
        2026-01-02 HHH  ISA  units=   10 value=   1000 GBP"
      `);
    });
  });

  describe("InvestmentStockSplits trigger", () => {
    it("INSERT — full-refreshes affected investment with split-adjusted units and prices", async () => {
      const inv = await createInvestment("III");
      const wrap = await createWrapper("ISA");
      // Pre-split: bought 10 units at £100, price drifts to £100 on day 5.
      await insertTx(inv, wrap, "2026-01-01", 10, 100);
      await insertPrice(inv, "2026-01-05", 100);
      expect(await ivpSnapshot()).toMatchInlineSnapshot(
        `"2026-01-05 III  ISA  units=   10 value=   1000 GBP"`,
      );
      // 2-for-1 split on day 3: pre-split prices and units are scaled to
      // post-split equivalents (units × 2, priceAdjusted ÷ 2). Total value
      // is invariant when the split sits between any tx and any price.
      await db.insert(InvestmentStockSplits).values({
        investmentId: inv,
        date: new Date("2026-01-03"),
        ratio: "2",
      });
      expect(await ivpSnapshot()).toMatchInlineSnapshot(
        `"2026-01-05 III  ISA  units=   20 value=   2000 GBP"`,
      );
    });

    it("DELETE — removing a split reverts the value-points to pre-split units and prices", async () => {
      const inv = await createInvestment("JJJ");
      const wrap = await createWrapper("ISA");
      await insertTx(inv, wrap, "2026-01-01", 10, 100);
      await insertPrice(inv, "2026-01-02", 100);
      const [split] = await db
        .insert(InvestmentStockSplits)
        .values({ investmentId: inv, date: new Date("2026-01-02"), ratio: "2" })
        .returning({ id: InvestmentStockSplits.id });
      expect(await ivpSnapshot()).toMatchInlineSnapshot(
        `"2026-01-02 JJJ  ISA  units=   20 value=   2000 GBP"`,
      );
      await db
        .delete(InvestmentStockSplits)
        .where(eq(InvestmentStockSplits.id, split.id));
      expect(await ivpSnapshot()).toMatchInlineSnapshot(
        `"2026-01-02 JJJ  ISA  units=   10 value=   1000 GBP"`,
      );
    });
  });

  describe("multi-wrapper / multi-investment", () => {
    it("aggregates per (investment, wrapper) — same investment in two wrappers gets two rows per day", async () => {
      const inv = await createInvestment("KKK");
      const isa = await createWrapper("ISA");
      const sipp = await createWrapper("SIPP");
      await insertPrice(inv, "2026-01-01", 100);
      await insertTx(inv, isa, "2026-01-01", 10, 100);
      await insertTx(inv, sipp, "2026-01-01", 5, 100);
      expect(await ivpSnapshot()).toMatchInlineSnapshot(`
        "2026-01-01 KKK  ISA  units=   10 value=   1000 GBP
        2026-01-01 KKK  SIPP units=    5 value=    500 GBP"
      `);
    });

    it("supports negative units when a wrapper has more sells than buys (unrecorded transfer)", async () => {
      // The user might rebalance by selling in one wrapper and buying the
      // same units in another, without a formal InvestmentTransfers row.
      // Each slice's IVP carries its actual signed units; the resolver sums
      // across slices to a correct portfolio total.
      const inv = await createInvestment("LLL");
      const isa = await createWrapper("ISA");
      const sipp = await createWrapper("SIPP");
      await insertPrice(inv, "2026-01-01", 100);
      // Net portfolio: +10 (ISA) − 10 (SIPP, manual sell down) = 0 across
      // the portfolio, but each slice retains its directional contribution.
      await insertTx(inv, isa, "2026-01-01", 10, 100);
      await insertTx(inv, sipp, "2026-01-01", -10, 100);
      expect(await ivpSnapshot()).toMatchInlineSnapshot(`
        "2026-01-01 LLL  ISA  units=   10 value=   1000 GBP
        2026-01-01 LLL  SIPP units=  -10 value=  -1000 GBP"
      `);
    });
  });

  describe("backfill via InvestmentValuePoints_refresh_fn", () => {
    it("idempotent — calling refresh_fn(NULL) on the same investments produces the same rows", async () => {
      const inv = await createInvestment("MMM");
      const wrap = await createWrapper("ISA");
      await insertPrice(inv, "2026-01-01", 100);
      await insertTx(inv, wrap, "2026-01-01", 10, 100);
      const before = await ivpSnapshot();
      // Re-run the helper directly with NULL fromDate (full refresh).
      await db.execute(sql`
        SELECT "InvestmentValuePoints_refresh_fn"(ARRAY[${inv}::uuid], NULL::date)
      `);
      expect(await ivpSnapshot()).toBe(before);
    });

    it("incremental — refresh_fn(p_from_date) only touches rows on/after that date", async () => {
      const inv = await createInvestment("NNN");
      const wrap = await createWrapper("ISA");
      await insertPrice(inv, "2026-01-01", 100);
      await insertPrice(inv, "2026-01-04", 100);
      await insertTx(inv, wrap, "2026-01-01", 10, 100);
      // Sanity: full series.
      expect(await ivpSnapshot()).toMatchInlineSnapshot(`
        "2026-01-01 NNN  ISA  units=   10 value=   1000 GBP
        2026-01-02 NNN  ISA  units=   10 value=   1000 GBP
        2026-01-03 NNN  ISA  units=   10 value=   1000 GBP
        2026-01-04 NNN  ISA  units=   10 value=   1000 GBP"
      `);
      // Manually corrupt a date < cutoff to verify the refresh leaves it alone.
      await db.execute(sql`
        UPDATE "InvestmentValuePoints"
        SET value = 99999
        WHERE date = '2026-01-01' AND "investmentId" = ${inv}::uuid
      `);
      // Refresh only from 2026-01-03 onward — the corrupted 2026-01-01 row
      // must survive.
      await db.execute(sql`
        SELECT "InvestmentValuePoints_refresh_fn"(ARRAY[${inv}::uuid], '2026-01-03'::date)
      `);
      expect(await ivpSnapshot()).toMatchInlineSnapshot(`
        "2026-01-01 NNN  ISA  units=   10 value=  99999 GBP
        2026-01-02 NNN  ISA  units=   10 value=   1000 GBP
        2026-01-03 NNN  ISA  units=   10 value=   1000 GBP
        2026-01-04 NNN  ISA  units=   10 value=   1000 GBP"
      `);
    });
  });
});

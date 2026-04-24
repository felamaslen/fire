import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { InvestmentPrices, Investments } from "@/db/schema/investments";

async function createInvestment(code: string): Promise<string> {
  const [row] = await db
    .insert(Investments)
    .values({ name: code, stockCode: code, currency: "GBP" })
    .returning({ id: Investments.id });
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

async function latestIdFor(investmentId: string): Promise<string | null> {
  const rows = await db
    .select({ id: InvestmentPrices.id })
    .from(InvestmentPrices)
    .where(
      sql`${InvestmentPrices.investmentId} = ${investmentId} AND ${InvestmentPrices.isLatest} IS NOT NULL`,
    );
  if (rows.length > 1) throw new Error("more than one isLatest=true row");
  return rows[0]?.id ?? null;
}

describe("InvestmentPrices.isLatest trigger", () => {
  it("marks the greatest-date row as latest on insert", async () => {
    const inv = await createInvestment("AAA");
    const older = await insertPrice(inv, "2026-01-01", 100);
    const newer = await insertPrice(inv, "2026-02-01", 200);
    expect(await latestIdFor(inv)).toBe(newer);

    // Inserting an older row mustn't steal latest.
    await insertPrice(inv, "2025-01-01", 50);
    expect(await latestIdFor(inv)).toBe(newer);
    // Sanity: the older row is not the latest.
    void older;
  });

  it("flips latest when a newer row arrives", async () => {
    const inv = await createInvestment("BBB");
    const a = await insertPrice(inv, "2026-01-01", 100);
    expect(await latestIdFor(inv)).toBe(a);
    const b = await insertPrice(inv, "2026-06-01", 150);
    expect(await latestIdFor(inv)).toBe(b);
  });

  it("re-picks the latest when the currently-latest row is deleted", async () => {
    const inv = await createInvestment("CCC");
    const a = await insertPrice(inv, "2026-01-01", 100);
    const b = await insertPrice(inv, "2026-02-01", 200);
    expect(await latestIdFor(inv)).toBe(b);
    await db.delete(InvestmentPrices).where(eq(InvestmentPrices.id, b));
    expect(await latestIdFor(inv)).toBe(a);
  });

  it("re-picks the latest when a row's date is updated past the current leader", async () => {
    const inv = await createInvestment("DDD");
    const a = await insertPrice(inv, "2026-01-01", 100);
    const b = await insertPrice(inv, "2026-02-01", 200);
    expect(await latestIdFor(inv)).toBe(b);

    // Move `a` past `b` — the trigger must clear `b.isLatest` before setting `a.isLatest`
    // or the partial unique index would reject the update.
    await db
      .update(InvestmentPrices)
      .set({ date: new Date("2026-03-01") })
      .where(eq(InvestmentPrices.id, a));
    expect(await latestIdFor(inv)).toBe(a);
  });

  it("keeps separate latest rows per investment", async () => {
    const x = await createInvestment("XXX");
    const y = await createInvestment("YYY");
    const xLatest = await insertPrice(x, "2026-01-01", 100);
    const yLatest = await insertPrice(y, "2026-01-01", 50);
    expect(await latestIdFor(x)).toBe(xLatest);
    expect(await latestIdFor(y)).toBe(yLatest);
  });

  it("leaves `isLatest` null when no rows exist", async () => {
    const inv = await createInvestment("ZZZ");
    expect(await latestIdFor(inv)).toBeNull();
  });

  it("flags only the max-date row when many rows insert in one statement", async () => {
    const inv = await createInvestment("BULK");
    const rows = await db
      .insert(InvestmentPrices)
      .values(
        [
          "2026-01-01",
          "2026-04-01",
          "2026-06-01",
          "2026-03-01",
          "2026-05-01",
        ].map((d) => ({
          investmentId: inv,
          date: new Date(d),
          price: 100,
          currency: "GBP" as const,
        })),
      )
      .returning({ id: InvestmentPrices.id, date: InvestmentPrices.date });
    const maxId = rows.reduce((a, b) => (a.date > b.date ? a : b)).id;
    expect(await latestIdFor(inv)).toBe(maxId);
  });

  it("isolates `isLatest` per investment inside a mixed bulk insert", async () => {
    const a = await createInvestment("BULKA");
    const b = await createInvestment("BULKB");
    const rows = await db
      .insert(InvestmentPrices)
      .values([
        {
          investmentId: a,
          date: new Date("2026-01-01"),
          price: 10,
          currency: "GBP",
        },
        {
          investmentId: a,
          date: new Date("2026-06-01"),
          price: 20,
          currency: "GBP",
        },
        {
          investmentId: b,
          date: new Date("2026-03-01"),
          price: 30,
          currency: "GBP",
        },
        {
          investmentId: b,
          date: new Date("2026-02-01"),
          price: 40,
          currency: "GBP",
        },
      ])
      .returning({
        id: InvestmentPrices.id,
        investmentId: InvestmentPrices.investmentId,
        date: InvestmentPrices.date,
      });
    const maxFor = (inv: string) =>
      rows
        .filter((r) => r.investmentId === inv)
        .reduce((x, y) => (x.date > y.date ? x : y)).id;
    expect(await latestIdFor(a)).toBe(maxFor(a));
    expect(await latestIdFor(b)).toBe(maxFor(b));
  });

  it("handles a bulk delete that removes the current latest", async () => {
    const inv = await createInvestment("BULKDEL");
    await db.insert(InvestmentPrices).values(
      ["2026-01-01", "2026-02-01", "2026-06-01"].map((d) => ({
        investmentId: inv,
        date: new Date(d),
        price: 100,
        currency: "GBP" as const,
      })),
    );
    // Drop the two newest rows in one statement.
    await db
      .delete(InvestmentPrices)
      .where(
        sql`${InvestmentPrices.investmentId} = ${inv} AND ${InvestmentPrices.date} > '2026-01-01'`,
      );
    const [[surviving]] = [
      await db
        .select({ id: InvestmentPrices.id })
        .from(InvestmentPrices)
        .where(eq(InvestmentPrices.investmentId, inv)),
    ];
    expect(await latestIdFor(inv)).toBe(surviving.id);
  });
});

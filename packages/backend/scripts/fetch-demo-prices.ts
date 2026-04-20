/**
 * One-shot fetcher for the demo-seed stock-history catalog. Pulls ~10 years of **daily** closes from Yahoo for every ticker in `DEMO_TICKERS`, writes the result to `src/auth/demo-seeds/stock-history.data.json`, and commits. The seed module reads from that JSON at runtime so demo sessions get real historic prices without ever hitting Yahoo at request time.
 *
 * Run manually:
 *   pnpm tsx scripts/fetch-demo-prices.ts
 *
 * Re-run whenever the catalog changes or the stored history needs refreshing.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YahooFinance from "yahoo-finance2";

const yahoo = new YahooFinance({
  suppressNotices: ["yahooSurvey", "ripHistorical"],
});

const DEMO_TICKERS: {
  ticker: string;
  name: string;
  theme: "growth" | "dividend" | "broad" | "crypto" | "cannabis";
}[] = [
  {
    ticker: "SMT.L",
    name: "Scottish Mortgage Investment Trust",
    theme: "growth",
  },
  { ticker: "ATT.L", name: "Allianz Technology Trust", theme: "growth" },
  {
    ticker: "CTY.L",
    name: "City of London Investment Trust",
    theme: "dividend",
  },
  { ticker: "BNKR.L", name: "Bankers Investment Trust", theme: "dividend" },
  { ticker: "MYI.L", name: "Murray International Trust", theme: "dividend" },
  { ticker: "CSP1.L", name: "iShares Core S&P 500 UCITS ETF", theme: "broad" },
  {
    ticker: "EQQQ.L",
    name: "Invesco EQQQ Nasdaq-100 UCITS ETF",
    theme: "broad",
  },
  { ticker: "BTCW.L", name: "WisdomTree Physical Bitcoin", theme: "crypto" },
  // Cannabis — US-listed because LSE cannabis ETFs are short-lived
  // (Rize / HANetf products were delisted in 2023). Prices come back in
  // USD cents; the fetcher treats them as pence regardless — for a demo
  // fake-portfolio we don't care about accurate GBP conversion, just that
  // the shape of the series is real.
  { ticker: "TLRY", name: "Tilray Brands", theme: "cannabis" },
  { ticker: "CGC", name: "Canopy Growth", theme: "cannabis" },
];

type Point = { date: string; price: number };

async function fetchDaily(ticker: string): Promise<Point[]> {
  const tenYearsAgo = new Date();
  tenYearsAgo.setFullYear(tenYearsAgo.getFullYear() - 10);
  const result = await yahoo.chart(ticker, {
    period1: tenYearsAgo,
    period2: new Date(),
    interval: "1d",
  });
  // Yahoo reports LSE equities in `GBp` / `GBX` (pence, already minor units)
  // and `GBP` / `USD` in major units (pounds / dollars, needs ×100 to get
  // minor units). We treat USD cents as pence — the catalog is a fake
  // demo portfolio, so per-currency accuracy doesn't matter, only the
  // realistic *shape* of each price series.
  const cur = String(result.meta.currency);
  const alreadyPence = cur === "GBp" || cur === "GBX";
  const out: Point[] = [];
  for (const q of result.quotes) {
    if (q.close == null || q.close <= 0) continue;
    const d = q.date;
    const iso = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    const pence = alreadyPence ? q.close : q.close * 100;
    out.push({ date: iso, price: Math.max(1, Math.round(pence)) });
  }
  // Dedupe days (Yahoo occasionally returns 2 rows for the same calendar day
  // around exchange timezone boundaries).
  const byIso = new Map<string, number>();
  for (const p of out) byIso.set(p.date, p.price);
  return [...byIso.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, price]) => ({ date, price }));
}

async function main() {
  const catalog: {
    ticker: string;
    name: string;
    theme: string;
    points: Point[];
  }[] = [];
  for (const spec of DEMO_TICKERS) {
    process.stdout.write(`fetching ${spec.ticker}… `);
    try {
      const points = await fetchDaily(spec.ticker);
      process.stdout.write(`${points.length} days\n`);
      catalog.push({ ...spec, points });
    } catch (err) {
      process.stderr.write(`FAILED: ${String(err)}\n`);
      throw err;
    }
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const outPath = path.resolve(
    here,
    "../src/auth/demo-seeds/stock-history.csv",
  );
  // CSV layout: one row per (ticker, date). Header: ticker,date,price.
  // Keeping the full tall shape (vs. one column per ticker) means new tickers
  // can be added without rewriting existing rows, and missing days for a
  // given ticker don't force null cells across the grid.
  const lines: string[] = ["ticker,name,theme,date,price"];
  for (const entry of catalog) {
    // Escape names with commas by double-quoting; tickers / themes / prices
    // are known-safe.
    const safeName = entry.name.includes(",")
      ? `"${entry.name.replace(/"/gu, '""')}"`
      : entry.name;
    for (const p of entry.points) {
      lines.push(
        `${entry.ticker},${safeName},${entry.theme},${p.date},${p.price}`,
      );
    }
  }
  await writeFile(outPath, `${lines.join("\n")}\n`, "utf8");
  process.stdout.write(`\nWrote ${outPath} (${lines.length - 1} rows)\n`);
}

await main();

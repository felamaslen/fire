import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Demo-session stock catalog. The price data is actual historical closes pulled from Yahoo once via `pnpm demo:fetch-prices` and committed as `stock-history.csv`; this module parses it on first access so demo seeds get real market history without ever making a network call at request time.
 *
 * Prices are in pence throughout (the fetch script normalises `GBp` / `GBX` / `GBP` to pence before writing).
 */

export type StockTheme =
  | "growth"
  | "dividend"
  | "broad"
  | "crypto"
  | "cannabis";

export type DemoStock = {
  /** Ticker on LSE; used as `Investments.stockCode`. */
  ticker: string;
  name: string;
  theme: StockTheme;
};

export type PricePoint = {
  /** `YYYY-MM-DD`. */
  date: string;
  /** Close price in pence. */
  price: number;
};

type CatalogEntry = DemoStock & { points: PricePoint[] };

let loaded: {
  byTicker: Map<string, CatalogEntry>;
  stocks: DemoStock[];
} | null = null;

function load(): NonNullable<typeof loaded> {
  if (loaded) return loaded;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const csvPath = path.resolve(here, "stock-history.csv");
  const raw = readFileSync(csvPath, "utf8");
  const lines = raw.split("\n").filter(Boolean);
  // Drop header row. Expected columns: ticker,name,theme,date,price.
  const [, ...rows] = lines;
  const byTicker = new Map<string, CatalogEntry>();
  for (const line of rows) {
    const cols = parseCsvRow(line);
    if (cols.length !== 5) continue;
    const [ticker, name, theme, date, priceStr] = cols;
    const price = Number(priceStr);
    if (!Number.isFinite(price)) continue;
    let entry = byTicker.get(ticker);
    if (!entry) {
      entry = {
        ticker,
        name,
        theme: theme as StockTheme,
        points: [],
      };
      byTicker.set(ticker, entry);
    }
    entry.points.push({ date, price });
  }
  // Rows were written sorted by date per ticker, but defence-in-depth: sort.
  for (const entry of byTicker.values()) {
    entry.points.sort((a, b) => a.date.localeCompare(b.date));
  }
  const stocks = [...byTicker.values()].map(({ ticker, name, theme }) => ({
    ticker,
    name,
    theme,
  }));
  loaded = { byTicker, stocks };
  return loaded;
}

/** Handles the one edge case the fetcher inserts: double-quoted names whose content contains a comma (e.g. `"iShares Core S&P 500 UCITS ETF"`). Everything else is plain-ASCII comma-separated. */
function parseCsvRow(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

export function demoStocks(): DemoStock[] {
  return load().stocks;
}

export function demoStock(ticker: string): DemoStock | undefined {
  const entry = load().byTicker.get(ticker);
  if (!entry) return undefined;
  return { ticker: entry.ticker, name: entry.name, theme: entry.theme };
}

/**
 * Daily closing prices for `ticker` on or after `fromDate`, ordered oldest → newest. Dates are normalised to UTC midnight; prices are in pence. If the stored catalog doesn't cover all of `fromDate → today` (e.g. BTCW.L was only listed recently), the result is whatever's available — the caller's expected to handle a short history gracefully.
 */
export function dailyPrices(
  ticker: string,
  fromDate: Date,
): { date: Date; price: number }[] {
  const entry = load().byTicker.get(ticker);
  if (!entry) return [];
  const fromIso = `${fromDate.getUTCFullYear()}-${String(fromDate.getUTCMonth() + 1).padStart(2, "0")}-${String(fromDate.getUTCDate()).padStart(2, "0")}`;
  return entry.points
    .filter((p) => p.date >= fromIso)
    .map((p) => {
      const [y, m, d] = p.date.split("-").map(Number);
      return { date: new Date(Date.UTC(y, m - 1, d)), price: p.price };
    });
}

/** Latest known close for a ticker, in pence. Used to size monthly buys so a wrapper's units land close to the stated end-of-history target value. */
export function latestPrice(ticker: string): number | null {
  const entry = load().byTicker.get(ticker);
  if (!entry || entry.points.length === 0) return null;
  return entry.points[entry.points.length - 1].price;
}

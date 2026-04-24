import { addMonths, startOfMonth } from "date-fns";

import type { DB } from "@/db";
import {
  InvestmentPrices,
  Investments,
  InvestmentTransactions,
} from "@/db/schema/investments";
import {
  NetWorthCategoryAssets,
  NetWorthCategoryLiabilities,
  NetWorthEntries,
  NetWorthValueAmounts,
  NetWorthValues,
} from "@/db/schema/net-worth";
import {
  PlanningAccounts,
  PlanningBills,
  PlanningEarnings,
  PlanningMonths,
  PlanningYears,
  PlanningYearUKTaxRates,
} from "@/db/schema/planning";

import {
  dailyPrices,
  demoStock,
  latestPrice,
  type StockTheme,
} from "./stock-history";

/** Deterministic seeded PRNG (Mulberry32). Seeded from the flavour name so two demo logins on the same flavour get identical data, which makes screenshots / tests stable across reseeds. */
export function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Pence, as stored in the DB's `bigint` money columns. */
export type Pence = number;

export type AssetSpec = {
  name: string;
  type:
    | "CASH"
    | "STOCK"
    | "PENSION"
    | "PROPERTY"
    | "VEHICLE"
    | "MISC"
    | "OPTION";
  /** Starting value in pence at `startOffsetMonths` months before today. */
  startValue: Pence;
  /** Current value in pence as of `today`. Linearly interpolated per month between start and today. Small PRNG-driven jitter is applied per month. */
  endValue: Pence;
  /** Treat this asset as a planning account (CASH only). Earnings / bills will fall back to this if no explicit account is given. */
  planningAccount?: boolean;
  /**
   * For STOCK / PENSION wrappers: how the wrapper's value is split across real LSE tickers (from `DEMO_STOCKS`). Weights are relative — they're normalised, so callers don't need them to sum to exactly 1. Falls back to an even split across one or two themed instruments (see `THEME_DEFAULTS`) if omitted.
   */
  holdings?: { ticker: string; weight: number }[];
  /** Shorthand for a themed default basket (used when `holdings` is omitted). */
  holdingsTheme?: StockTheme;
};

export type LiabilitySpec = {
  name: string;
  type: "CREDIT_CARD" | "LOAN" | "MISC";
  /** Positive pence, stored as positive amount on a liability row. */
  startValue: Pence;
  endValue: Pence;
  /** APR percent (e.g. 5.25 for 5.25%). Required for `LOAN`. */
  interestRate?: number;
};

export type BillSpec = {
  name: string;
  /** Monthly amount in pence. */
  amount: Pence;
  /** Day-of-month the bill collects. 1-28 safe range. */
  dayOfMonth: number;
};

export type EarningsSpec = {
  name: string;
  /** Gross annual pay in pence. `PlanningEarnings.amountGross` is per-year, not per-pay-period. */
  yearly: Pence;
};

export type FlavourSpec = {
  /** How many months of history to populate, counting backwards from the month of `today`. */
  historyMonths: number;
  assets: AssetSpec[];
  liabilities: LiabilitySpec[];
  bills: BillSpec[];
  earnings: EarningsSpec[];
};

/** UK tax parameters — reasonable defaults for FY25/26 style numbers. Values in fractional pence. */
const DEFAULT_UK_TAX_RATES = {
  rateBasic: 0.2,
  rateHigher: 0.4,
  rateAdditional: 0.45,
  thresholdBasic: 3750000, // £37,500
  thresholdHigher: 12527000, // £125,270
  thresholdAdditional: 12527000,
  rateNicMain: 0.08,
  rateNicAdditional: 0.02,
  thresholdNicPrimary: 1257000,
  thresholdNicUpperEarnings: 5027000,
  rateStudentLoanPlan2: 0.09,
  thresholdStudentLoanPlan2: 2729500,
  thresholdPersonalAllowanceTaper: 10000000,
};

/** Compute the UK financial-year start year for `today`. FY runs 6 April → 5 April. */
function ukFinancialYear(today: Date): number {
  const y = today.getUTCFullYear();
  const apr6 = Date.UTC(y, 3, 6);
  return today.getTime() >= apr6 ? y : y - 1;
}

/** Insert seed data for a flavour. Runs inside `db`'s active schema (the demo schema). */
export async function applyFlavour(
  db: DB,
  today: Date,
  spec: FlavourSpec,
  /** Receives milestone pings as the pipeline walks through the sections below — the client uses these to drive the login progress bar. */
  onProgress: (step: string, progress: number) => void = () => {},
): Promise<void> {
  const rand = prng(hashSeed(JSON.stringify(spec)));

  // ── Planning year + UK tax rates ──────────────────────────────────────────
  onProgress("Preparing planning years", 0.2);
  const fy = ukFinancialYear(today);
  await db.insert(PlanningYears).values({ year: fy });
  await db.insert(PlanningYears).values({ year: fy + 1 });
  await db
    .insert(PlanningYearUKTaxRates)
    .values({ year: fy, ...DEFAULT_UK_TAX_RATES });
  await db
    .insert(PlanningYearUKTaxRates)
    .values({ year: fy + 1, ...DEFAULT_UK_TAX_RATES });

  for (const year of [fy, fy + 1]) {
    const months = Array.from({ length: 12 }, (_, i) => {
      // UK FY month 0 = April (month 3 in JS Date).
      const m = (3 + i) % 12;
      const yy = m < 3 ? year + 1 : year;
      return { year, date: new Date(Date.UTC(yy, m, 1)) };
    });
    await db.insert(PlanningMonths).values(months);
  }

  // ── Assets ────────────────────────────────────────────────────────────────
  onProgress("Seeding assets & liabilities", 0.3);
  const assetIdByName = new Map<string, string>();
  for (const asset of spec.assets) {
    const [row] = await db
      .insert(NetWorthCategoryAssets)
      .values({ name: asset.name, type: asset.type })
      .returning({ id: NetWorthCategoryAssets.id });
    assetIdByName.set(asset.name, row.id);
  }
  const planningAssetNames = spec.assets
    .filter((a) => a.planningAccount)
    .map((a) => a.name);
  for (const [sortOrder, name] of planningAssetNames.entries()) {
    await db
      .insert(PlanningAccounts)
      .values({ accountId: assetIdByName.get(name)!, sortOrder });
  }
  const defaultPlanningAsset = planningAssetNames[0];
  if (!defaultPlanningAsset) {
    throw new Error(`Flavour has no planning account: ${JSON.stringify(spec)}`);
  }
  const defaultPlanningAccountId = assetIdByName.get(defaultPlanningAsset)!;

  // ── Liabilities ───────────────────────────────────────────────────────────
  const liabilityIdByName = new Map<string, string>();
  for (const liab of spec.liabilities) {
    const [row] = await db
      .insert(NetWorthCategoryLiabilities)
      .values({
        name: liab.name,
        type: liab.type,
        interestRate:
          liab.type === "LOAN" && liab.interestRate != null
            ? liab.interestRate.toFixed(4)
            : null,
      })
      .returning({ id: NetWorthCategoryLiabilities.id });
    liabilityIdByName.set(liab.name, row.id);
  }

  // ── Net-worth entries (monthly history + current month) ───────────────────
  onProgress("Generating net-worth history", 0.4);
  const firstMonth = startOfMonth(addMonths(today, -(spec.historyMonths - 1)));
  const totalMonths = spec.historyMonths;
  for (let i = 0; i < totalMonths; i++) {
    const monthDate = addMonths(firstMonth, i);
    const [entry] = await db
      .insert(NetWorthEntries)
      .values({ date: monthDate })
      .returning({ id: NetWorthEntries.id });
    const progress = totalMonths === 1 ? 1 : i / (totalMonths - 1);

    for (const asset of spec.assets) {
      const linear =
        asset.startValue + (asset.endValue - asset.startValue) * progress;
      const jitter = 1 + (rand() - 0.5) * 0.04;
      const amount = Math.round(linear * jitter);
      const [value] = await db
        .insert(NetWorthValues)
        .values({
          entryId: entry.id,
          categoryAssetId: assetIdByName.get(asset.name)!,
        })
        .returning({ id: NetWorthValues.id });
      await db
        .insert(NetWorthValueAmounts)
        .values({ valueId: value.id, amount, currency: "GBP" });
    }

    for (const liab of spec.liabilities) {
      const linear =
        liab.startValue + (liab.endValue - liab.startValue) * progress;
      const jitter = 1 + (rand() - 0.5) * 0.02;
      const amount = Math.round(linear * jitter);
      const [value] = await db
        .insert(NetWorthValues)
        .values({
          entryId: entry.id,
          categoryLiabilityId: liabilityIdByName.get(liab.name)!,
        })
        .returning({ id: NetWorthValues.id });
      await db
        .insert(NetWorthValueAmounts)
        .values({ valueId: value.id, amount, currency: "GBP" });
    }
  }

  // ── Recurring bills ───────────────────────────────────────────────────────
  onProgress("Seeding bills & earnings", 0.55);
  for (const bill of spec.bills) {
    await db.insert(PlanningBills).values({
      name: bill.name,
      start: addMonths(today, -12),
      frequency: "MONTHLY",
      collectionDate: String(bill.dayOfMonth),
      amount: bill.amount,
      currency: "GBP",
      fromAccountId: defaultPlanningAccountId,
    });
  }

  // ── Earnings streams ─────────────────────────────────────────────────────
  for (const e of spec.earnings) {
    await db.insert(PlanningEarnings).values({
      name: e.name,
      start: addMonths(today, -24),
      amountGross: e.yearly,
      currency: "GBP",
      countryCode: "GB",
      toAccountId: defaultPlanningAccountId,
    });
  }

  // ── Investments (real LSE tickers, one row per ticker) ──────────────────
  // Each STOCK / PENSION wrapper holds one or more instruments from the
  // catalog (`stock-history.csv`, populated by `pnpm demo:fetch-prices`).
  // The table convention is *one* `Investments` row per ticker; per-wrapper
  // holdings are expressed as `InvestmentTransactions` rows whose `assetId`
  // points at the wrapper — so a ticker held in both the ISA and the SIPP
  // shares the same `Investments.id` and price series. Daily closes feed
  // `InvestmentPrices` so the portfolio chart shows genuine market
  // volatility; monthly buys simulate a DCA pattern on top. Yahoo is gated
  // off for demo sessions (`tasks/yahoo.ts`) so no live network call is
  // ever made against these tickers at request time.
  const INVESTMENT_WRAPPER_TYPES = new Set(["STOCK", "PENSION"] as const);
  const firstMonthForInvestments = startOfMonth(
    addMonths(today, -(spec.historyMonths - 1)),
  );

  // Collapse every wrapper's holdings into a map keyed by ticker. Each
  // ticker entry carries one or more `(assetId, targetEndValuePence)`
  // positions — one per wrapper holding that ticker.
  type Position = { assetId: string; targetEndValuePence: number };
  const positionsByTicker = new Map<string, Position[]>();
  for (const asset of spec.assets) {
    if (!INVESTMENT_WRAPPER_TYPES.has(asset.type as "STOCK" | "PENSION")) {
      continue;
    }
    if (asset.endValue <= 0) continue;
    const holdings = resolveHoldings(asset);
    const totalWeight = holdings.reduce((a, b) => a + b.weight, 0);
    if (totalWeight <= 0) continue;
    const assetId = assetIdByName.get(asset.name)!;
    for (const holding of holdings) {
      const share = holding.weight / totalWeight;
      const targetEndValuePence = Math.round(asset.endValue * share);
      if (targetEndValuePence <= 0) continue;
      const list = positionsByTicker.get(holding.ticker) ?? [];
      list.push({ assetId, targetEndValuePence });
      positionsByTicker.set(holding.ticker, list);
    }
  }

  const tickerCount = positionsByTicker.size;
  let tickerIndex = 0;
  for (const [ticker, positions] of positionsByTicker) {
    onProgress(
      `Building investment positions (${tickerIndex + 1}/${tickerCount})`,
      0.6 + (0.35 * tickerIndex) / Math.max(1, tickerCount),
    );
    tickerIndex++;
    const stock = demoStock(ticker);
    if (!stock) continue;
    const priceSeries = dailyPrices(ticker, firstMonthForInvestments);
    if (priceSeries.length === 0) continue;
    const endPrice = Math.max(1, latestPrice(ticker) ?? 1);

    const [inv] = await db
      .insert(Investments)
      .values({ name: stock.name, stockCode: stock.ticker, currency: "GBP" })
      .returning({ id: Investments.id });

    // Daily price rows — shared across every wrapper that holds this
    // ticker (they all read from the same `Investments.id`).
    const priceRows = priceSeries.map((p) => ({
      investmentId: inv.id,
      date: p.date,
      price: p.price,
      currency: "GBP" as const,
    }));

    const firstTradingPriceOnOrAfter = (
      target: Date,
    ): { date: Date; price: number } | null => {
      for (const p of priceSeries) {
        if (p.date.getTime() >= target.getTime()) return p;
      }
      return null;
    };
    const lastTick = priceSeries[priceSeries.length - 1];

    // Monthly DCA transactions per wrapper. The per-wrapper unit counts are
    // independent (each wrapper targets its own `targetEndValuePence`) but
    // they all reference the same `Investments.id` — which is the whole
    // point of this refactor.
    const txRows: (typeof InvestmentTransactions.$inferInsert)[] = [];
    for (const pos of positions) {
      const targetUnits = Math.max(
        1,
        Math.round(pos.targetEndValuePence / endPrice),
      );
      const unitsPerMonth = Math.max(
        1,
        Math.floor(targetUnits / spec.historyMonths),
      );
      let unitsBought = 0;
      for (let i = 0; i < spec.historyMonths; i++) {
        const monthStart = addMonths(firstMonthForInvestments, i);
        const tick = firstTradingPriceOnOrAfter(monthStart);
        if (!tick) continue;
        if (i < spec.historyMonths - 1) {
          txRows.push({
            investmentId: inv.id,
            assetId: pos.assetId,
            units: unitsPerMonth,
            price: tick.price,
            currency: "GBP",
            date: tick.date,
          });
          unitsBought += unitsPerMonth;
        }
      }
      // Final top-up so the wrapper's position lands on `targetUnits`.
      const remaining = targetUnits - unitsBought;
      if (remaining > 0 && lastTick) {
        txRows.push({
          investmentId: inv.id,
          assetId: pos.assetId,
          units: remaining,
          price: lastTick.price,
          currency: "GBP",
          date: lastTick.date,
        });
      }
    }

    // Bulk-insert daily prices in chunks; Postgres has a limit on
    // parameter count per prepared statement (~32k) and a 10-year daily
    // series is ~2500 rows × 4 columns = 10k params — safely under the
    // cap, but chunk anyway so future longer histories don't trip it.
    const CHUNK = 1000;
    for (let i = 0; i < priceRows.length; i += CHUNK) {
      await db.insert(InvestmentPrices).values(priceRows.slice(i, i + CHUNK));
    }
    if (txRows.length > 0)
      await db.insert(InvestmentTransactions).values(txRows);
  }
}

/** Default baskets used when an asset spec doesn't list `holdings` explicitly. Each theme names the instruments from `DEMO_STOCKS` that best represent it; weights are equal. */
const THEME_DEFAULTS: Record<StockTheme, string[]> = {
  growth: ["SMT.L", "ATT.L"],
  dividend: ["CTY.L", "BNKR.L", "MYI.L"],
  broad: ["CSP1.L", "EQQQ.L"],
  crypto: ["BTCW.L"],
  cannabis: ["TLRY", "CGC"],
};

function resolveHoldings(
  asset: AssetSpec,
): { ticker: string; weight: number }[] {
  if (asset.holdings && asset.holdings.length > 0) return asset.holdings;
  const theme: StockTheme = asset.holdingsTheme ?? "broad";
  const tickers = THEME_DEFAULTS[theme];
  return tickers.map((ticker) => ({ ticker, weight: 1 }));
}

/** Re-export so flavour files can reference the catalog without another import path. */
export { demoStocks } from "./stock-history";

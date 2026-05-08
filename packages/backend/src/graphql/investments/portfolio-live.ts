import { and, eq, sql } from "drizzle-orm";
import { GraphQLError } from "graphql";
import type { ID } from "grats";

import { HOME_CURRENCY } from "@/config";
import { db } from "@/db";
import {
  InvestmentPrices,
  InvestmentPricesLive,
  Investments,
} from "@/db/schema/investments";

import type { Context } from "../context";
import { Investment } from "./index";
import { Portfolio } from "./portfolio";
import { clearInvestmentStatsLoader, loadInvestmentStats } from "./stats";

const TICK_MS = 30_000;

/** Maximum proportional swing applied to the previous live (or seeded cached) price on each demo tick. ±0.5 % per 30 s tick keeps the headline visibly lively without drifting unrealistically far from the seeded close over a typical session. */
const DEMO_JITTER_FRACTION = 0.005;

/**
 * One push of live values for the investments page: the aggregated `Portfolio` the headline reads from, plus every currently-held investment matching the same filter (sold-out positions are excluded — their per-row figures don't change between ticks). Streamed by the `portfolioLive` subscription.
 *
 * @gqlType
 */
export class PortfolioLiveTick {
  constructor(
    /** Aggregated portfolio (live-overlaid) for the subscription's filter. @gqlField */
    public readonly portfolio: Portfolio,
    /** Currently-held investments matching the filter, with refreshed price + position fields. @gqlField */
    public readonly investments: Investment[],
  ) {}
}

/**
 * Live stream of portfolio + per-investment price updates. Emits the first tick immediately and a fresh one every 30 s while the client stays connected. Each tick clears the request's stats loader so resolvers recompute against the latest Yahoo quote overlay; clients normalise per-investment fields by id, so the row table updates in place without its own poll.
 *
 * @gqlSubscriptionField
 */
export async function* portfolioLive(
  ctx: Context,
  filterAssetIdIn?: ID[] | null,
): AsyncIterable<PortfolioLiveTick> {
  if (ctx.session.kind === "anon") {
    throw new GraphQLError(
      "Unauthenticated: portfolioLive requires authentication",
      {
        extensions: { code: "UNAUTHENTICATED" },
      },
    );
  }
  const assets = filterAssetIdIn ? (filterAssetIdIn as string[]) : null;
  while (true) {
    if (ctx.session.kind === "demo") {
      await jitterDemoLiveQuotes();
    }
    clearInvestmentStatsLoader(ctx);
    const portfolio = new Portfolio(HOME_CURRENCY, assets, null, false);
    const investments = await loadHeldInvestments(ctx, assets);
    yield new PortfolioLiveTick(portfolio, investments);
    await new Promise((resolve) => setTimeout(resolve, TICK_MS));
  }
}

async function loadHeldInvestments(
  ctx: Context,
  filterAssetIdIn: string[] | null,
): Promise<Investment[]> {
  const rows = await db.select().from(Investments);
  if (rows.length === 0) return [];
  const stats = await Promise.all(
    rows.map((r) =>
      loadInvestmentStats(ctx, {
        investmentId: r.id,
        assetIds: filterAssetIdIn ?? undefined,
      }),
    ),
  );
  return rows
    .map((row, i) => ({ row, s: stats[i] }))
    .filter(({ s }) => s.unitsHeld !== 0)
    .map(({ row }) => Investment.load(row));
}

/**
 * Demo-session-only: advance each investment's `InvestmentPricesLive` by one random-walk step. The next price is the previous *live* price (or the latest cached close if no live row exists yet, seeding the walk) multiplied by `1 ± DEMO_JITTER_FRACTION`. `pricePreviousClose` is anchored to the latest cached close so the displayed `dailyGain` reflects how far the walk has drifted from yesterday's close — exactly how a real intraday quote behaves.
 *
 * Demo sessions never reach Yahoo (`fetchQuote` short-circuits on `isDemoSession()`), so without this every tick would re-emit the same frozen cached value (or, worse, no live row at all and the headline would never animate).
 */
async function jitterDemoLiveQuotes(): Promise<void> {
  const rows = await db
    .select({
      id: Investments.id,
      currency: Investments.currency,
      cachedPrice: InvestmentPrices.priceAdjusted,
      livePrice: InvestmentPricesLive.price,
    })
    .from(Investments)
    .leftJoin(
      InvestmentPrices,
      and(
        eq(InvestmentPrices.investmentId, Investments.id),
        eq(InvestmentPrices.isLatest, true),
      ),
    )
    .leftJoin(
      InvestmentPricesLive,
      eq(InvestmentPricesLive.investmentId, Investments.id),
    );
  if (rows.length === 0) return;
  const now = new Date();
  const values = rows
    .map((r) => {
      // Walk anchor: previous live price if we've already drawn one this
      // session; otherwise the latest cached close seeds the walk. With
      // neither, there's nothing to jitter from — skip.
      const base = r.livePrice ?? r.cachedPrice;
      if (base === null) return null;
      const factor = 1 + (Math.random() * 2 - 1) * DEMO_JITTER_FRACTION;
      return {
        investmentId: r.id,
        refreshedAt: now,
        date: now,
        currency: r.currency,
        price: Math.max(0, base * factor),
        // `pricePreviousClose` stays anchored to the cached close (yesterday)
        // so `dailyGain = live - prevClose` accumulates as the walk drifts.
        // Falls back to the seeded base on the (rare) path where a live row
        // exists without a corresponding cached close.
        pricePreviousClose: base ?? r.cachedPrice,
        data: null,
        updatedAt: now,
      };
    })
    .filter((v): v is NonNullable<typeof v> => v !== null);
  if (values.length === 0) return;
  await db
    .insert(InvestmentPricesLive)
    .values(values)
    .onConflictDoUpdate({
      target: InvestmentPricesLive.investmentId,
      set: {
        refreshedAt: sql`excluded.${sql.identifier("refreshedAt")}`,
        date: sql`excluded.${sql.identifier("date")}`,
        currency: sql`excluded.${sql.identifier("currency")}`,
        price: sql`excluded.${sql.identifier("price")}`,
        pricePreviousClose: sql`excluded.${sql.identifier("pricePreviousClose")}`,
        updatedAt: sql`excluded.${sql.identifier("updatedAt")}`,
      },
    });
}

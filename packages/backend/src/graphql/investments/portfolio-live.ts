import { GraphQLError } from "graphql";
import type { ID } from "grats";

import { HOME_CURRENCY } from "@/config";
import { db } from "@/db";
import { Investments } from "@/db/schema/investments";

import type { Context } from "../context";
import { Investment } from "./index";
import { Portfolio } from "./portfolio";
import { clearInvestmentStatsLoader, loadInvestmentStats } from "./stats";

const TICK_MS = 30_000;

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

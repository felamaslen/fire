/**
 * GraphQL surface for the net-worth forecast. Accepts `years` (horizon) and `limit` (number of evenly-spaced points to return) so the server does monthly projection internally but thins the output down for the chart. Surfaces the engine's per-category "workings" so clients can show how the final number was produced rather than trusting a black box.
 */

import { strict as assert } from "node:assert";

import type { Float, Int } from "grats";

import { HOME_CURRENCY } from "@/config";
import { runForecast } from "@/forecast/engine";
import { loadForecastInputs } from "@/forecast/inputs";

import type { Date as CalendarDate } from "../date";
import { Money } from "../money";
import {
  type NetWorthCategory,
  NetWorthCategoryAsset,
  NetWorthCategoryLiability,
  NetWorthCategoryOption,
} from "./categories";
import {
  type NetWorthHistoryAssetBucket,
  type NetWorthHistoryPoint,
} from "./history";

/** Projection for a `PROPERTY` / `VEHICLE` asset with an assumed growth rate. The balance compounds monthly at `growthRate`. @gqlType */
export class NetWorthForecastGrowthAsset {
  readonly __typename = "NetWorthForecastGrowthAsset" as const;
  constructor(
    /** @gqlField */
    public readonly category: NetWorthCategoryAsset,
    /** Balance at the forecast's starting point. @gqlField */
    public readonly startingBalance: Money,
    /** Annual growth rate (percent). Negative for depreciating assets (e.g. vehicles). @gqlField */
    public readonly growthRate: Float,
    /** Projected balance at each returned forecast point (inclusive of the starting point). @gqlField */
    public readonly projectedBalance: Money[],
  ) {}
}

/** Projection for a `STOCK` / `PENSION` portfolio wrapper. The balance compounds at `(1 + xirr)^(1/12)` each month and gains `monthlyContribution` in new deposits. @gqlType */
export class NetWorthForecastPortfolio {
  readonly __typename = "NetWorthForecastPortfolio" as const;
  constructor(
    /** @gqlField */
    public readonly category: NetWorthCategoryAsset,
    /** Balance at the forecast's starting point. @gqlField */
    public readonly startingBalance: Money,
    /** Annualised internal rate of return as a decimal (e.g. `0.08` = 8%/yr). Derived from the portfolio's transaction history; a portfolio with no computable XIRR is exposed as a `NetWorthForecastFlatAsset` instead. @gqlField */
    public readonly xirr: Float,
    /** EWMA of the portfolio's monthly cash contribution over the past three years. @gqlField */
    public readonly monthlyContribution: Money,
    /** Projected balance at each returned forecast point (inclusive of the starting point). @gqlField */
    public readonly projectedBalance: Money[],
  ) {}
}

/** Projection for an asset category that's held flat across the horizon — `CASH`, `OPTION`, `MISC`, and any `PROPERTY` / `VEHICLE` / `STOCK` / `PENSION` category without a growth rate or computable XIRR. The balance stays at today's value for the whole forecast. @gqlType */
export class NetWorthForecastFlatAsset {
  readonly __typename = "NetWorthForecastFlatAsset" as const;
  constructor(
    /** @gqlField */
    public readonly category: NetWorthCategoryAsset,
    /** Balance at the forecast's starting point. @gqlField */
    public readonly startingBalance: Money,
    /** Projected balance at each returned forecast point (inclusive of the starting point). @gqlField */
    public readonly projectedBalance: Money[],
  ) {}
}

/** Projection for a `LOAN` liability. The balance compounds monthly at `interestRate` and drops by `monthlyRepayment`, clamped at zero. @gqlType */
export class NetWorthForecastLoan {
  readonly __typename = "NetWorthForecastLoan" as const;
  constructor(
    /** @gqlField */
    public readonly category: NetWorthCategoryLiability,
    /** Balance at the forecast's starting point (positive magnitude). @gqlField */
    public readonly startingBalance: Money,
    /** EWMA of the past ten months' actual repayments (or scheduled bill amounts when no transactions land that month). @gqlField */
    public readonly monthlyRepayment: Money,
    /** Annual interest rate (percent). @gqlField */
    public readonly interestRate: Float,
    /** Projected balance at each returned forecast point (inclusive of the starting point). @gqlField */
    public readonly projectedBalance: Money[],
  ) {}
}

/** Projection for a liability held flat across the horizon: `MISC`, every `CREDIT_CARD`, and any `LOAN` without enough history to derive a monthly repayment. @gqlType */
export class NetWorthForecastFlatLiability {
  readonly __typename = "NetWorthForecastFlatLiability" as const;
  constructor(
    /** @gqlField */
    public readonly category: NetWorthCategoryLiability,
    /** Balance at the forecast's starting point (positive magnitude). @gqlField */
    public readonly startingBalance: Money,
    /** Projected balance at each returned forecast point (inclusive of the starting point). @gqlField */
    public readonly projectedBalance: Money[],
  ) {}
}

/** Projection for an equity-option category. Options are held flat — the forecast doesn't model vesting or price movement. @gqlType */
export class NetWorthForecastOptionCategory {
  readonly __typename = "NetWorthForecastOptionCategory" as const;
  constructor(
    /** @gqlField */
    public readonly category: NetWorthCategoryOption,
    /** Balance at the forecast's starting point. @gqlField */
    public readonly startingBalance: Money,
    /** Projected balance at each returned forecast point (inclusive of the starting point). @gqlField */
    public readonly projectedBalance: Money[],
  ) {}
}

/** Per-category projection, discriminated by how the engine evolves the balance. @gqlUnion */
export type NetWorthForecastCategory =
  | NetWorthForecastGrowthAsset
  | NetWorthForecastPortfolio
  | NetWorthForecastFlatAsset
  | NetWorthForecastLoan
  | NetWorthForecastFlatLiability
  | NetWorthForecastOptionCategory;

/** Engine workings exposed so the client can show how the forecast was derived. @gqlType */
export type NetWorthForecastWorkings = {
  /** Per-category projection. Skipped liabilities drop out entirely. @gqlField */
  categories: NetWorthForecastCategory[];
};

/** Monthly net-worth forecast over the requested horizon. `points` matches the shape of `netWorthHistory` so the two can be concatenated on the client. @gqlType */
export type NetWorthForecast = {
  /** Projected net-worth points, same shape as `netWorthHistory` entries. @gqlField */
  points: NetWorthHistoryPoint[];
  /** Per-component derivation of the projection, for "show the workings" visualisations. @gqlField */
  workings: NetWorthForecastWorkings;
};

type AssetBucketType = NetWorthHistoryAssetBucket["type"];

/**
 * Projected monthly net worth for the next `years` years, thinned to `limit` evenly-spaced points. The engine always projects monthly internally; at `years = 10, limit = 20`, callers see one point every six months. The forecast always starts at today (the latest recorded snapshot) and ends at exactly `years` from today.
 *
 * @gqlQueryField
 * @gqlAnnotate semanticNonNull
 */
export async function netWorthForecast(
  /** Forecast horizon in years (integer; 1–50). */
  years: Int,
  /**
   * Number of forecast points to return — evenly spaced between now and `years` years from now.
   * @gqlAnnotate constraint(min: 5, max: 20)
   */
  limit: Int = 10,
): Promise<NetWorthForecast | null> {
  // `years` doesn't strictly need a @constraint because there's no upper
  // bound a reasonable client would trip — but we still sanity-check it
  // so a pathological value doesn't spin up a 500-year monthly loop.
  assert(years >= 1 && years <= 50, "years must be between 1 and 50");

  const months = years * 12;
  const inputs = await loadForecastInputs(new Date(), months);
  const { points, workings } = runForecast(inputs);

  // Thin the monthly series to `limit` evenly-spaced points, always
  // landing on the last month so the chart ends at exactly `years`.
  const sampledIndices = sampleIndices(points.length - 1, limit);
  const sampledPoints = sampledIndices.map<NetWorthHistoryPoint>((i) => ({
    date: points[i].date as CalendarDate,
    assetsByType: points[i].assetsByType.map((b) => ({
      type: b.type as AssetBucketType,
      amount: Money.fromMinorDenomination(b.amount, HOME_CURRENCY),
    })),
    assets: Money.fromMinorDenomination(points[i].assets, HOME_CURRENCY),
    liabilities: Money.fromMinorDenomination(
      points[i].liabilities,
      HOME_CURRENCY,
    ),
    net: Money.fromMinorDenomination(points[i].net, HOME_CURRENCY),
  }));

  const loadedCategories = await loadCategoriesByIds(
    workings.categories.map((w) => w.categoryId),
  );
  const projectedCategories: NetWorthForecastCategory[] = [];
  for (const w of workings.categories) {
    const loaded = loadedCategories.get(w.categoryId);
    if (!loaded) continue;
    const startingBalance = Money.fromMinorDenomination(
      w.startingBalance,
      HOME_CURRENCY,
    );
    const projectedBalance = sampledIndices.map((i) =>
      Money.fromMinorDenomination(w.projectedBalance[i], HOME_CURRENCY),
    );
    if (loaded instanceof NetWorthCategoryAsset) {
      const type = await loaded.type();
      if ((type === "PROPERTY" || type === "VEHICLE") && w.growthRate != null) {
        projectedCategories.push(
          new NetWorthForecastGrowthAsset(
            loaded,
            startingBalance,
            w.growthRate,
            projectedBalance,
          ),
        );
      } else if ((type === "STOCK" || type === "PENSION") && w.xirr != null) {
        projectedCategories.push(
          new NetWorthForecastPortfolio(
            loaded,
            startingBalance,
            w.xirr,
            Money.fromMinorDenomination(w.monthlyContribution, HOME_CURRENCY),
            projectedBalance,
          ),
        );
      } else {
        projectedCategories.push(
          new NetWorthForecastFlatAsset(
            loaded,
            startingBalance,
            projectedBalance,
          ),
        );
      }
    } else if (loaded instanceof NetWorthCategoryLiability) {
      const type = await loaded.type();
      if (type === "LOAN" && w.interestRate != null) {
        projectedCategories.push(
          new NetWorthForecastLoan(
            loaded,
            startingBalance,
            Money.fromMinorDenomination(w.monthlyRepayment, HOME_CURRENCY),
            w.interestRate,
            projectedBalance,
          ),
        );
      } else {
        // CREDIT_CARD + MISC + unqualified LOAN → held flat.
        projectedCategories.push(
          new NetWorthForecastFlatLiability(
            loaded,
            startingBalance,
            projectedBalance,
          ),
        );
      }
    } else if (loaded instanceof NetWorthCategoryOption) {
      projectedCategories.push(
        new NetWorthForecastOptionCategory(
          loaded,
          startingBalance,
          projectedBalance,
        ),
      );
    }
  }

  return {
    points: sampledPoints,
    workings: {
      categories: projectedCategories,
    },
  };
}

/**
 * Evenly sample indices into `[0 .. max]` so the first returned index is always 0 and the last is always `max`. We return exactly `limit` values when `limit >= 2`; otherwise we fall back to the boundary indices.
 */
function sampleIndices(max: number, limit: number): number[] {
  if (max <= 0 || limit <= 0) return [0];
  if (limit === 1) return [max];
  const out: number[] = [];
  for (let i = 0; i < limit; i++) {
    out.push(Math.round((i * max) / (limit - 1)));
  }
  return out;
}

async function loadCategoriesByIds(
  ids: string[],
): Promise<Map<string, NetWorthCategory>> {
  if (ids.length === 0) return new Map();
  const { db } = await import("@/db");
  const {
    NetWorthCategoryAssets,
    NetWorthCategoryLiabilities,
    NetWorthCategoryOptions,
  } = await import("@/db/schema/net-worth");
  const { inArray } = await import("drizzle-orm");
  const [assetRows, liabilityRows, optionRows] = await Promise.all([
    db
      .select()
      .from(NetWorthCategoryAssets)
      .where(inArray(NetWorthCategoryAssets.id, ids)),
    db
      .select()
      .from(NetWorthCategoryLiabilities)
      .where(inArray(NetWorthCategoryLiabilities.id, ids)),
    db
      .select()
      .from(NetWorthCategoryOptions)
      .where(inArray(NetWorthCategoryOptions.id, ids)),
  ]);
  const out = new Map<string, NetWorthCategory>();
  for (const r of assetRows) out.set(r.id, NetWorthCategoryAsset.load(r));
  for (const r of liabilityRows)
    out.set(r.id, NetWorthCategoryLiability.load(r));
  for (const r of optionRows) out.set(r.id, NetWorthCategoryOption.load(r));
  return out;
}

/**
 * Retirement-planning settings and configured constants. The retirement year, when set, drives the post-retirement section of `netWorthForecast`: income drops to zero, portfolios begin drawdown, and spending continues with annual inflation.
 */

import type { Float, Int } from "grats";

import { ANNUAL_INFLATION_RATE, RETIREMENT_DRAWDOWN_RATE } from "@/config";
import { model } from "@/db/drizzle-model";
import { AppSettings } from "@/db/schema/settings";

/** Retirement-planning configuration. The retirement year is the single user-settable input; the drawdown and inflation rates are server-configured constants that the client can surface in its explainer. @gqlType */
export type RetirementSettings = {
  /** Calendar year the user plans to retire in. Null when no retirement year has been set — the forecast then runs without a retirement transition. @gqlField */
  retirementYear: Int | null;
  /** Server-assumed annual inflation rate applied to post-retirement spending, as a decimal. @gqlField */
  inflationRate: Float;
  /** Server-assumed annual safe-withdrawal rate applied to the portfolio after retirement, as a decimal. @gqlField */
  drawdownRate: Float;
};

/**
 * Current retirement-planning settings. Returns server-configured constants even when the user has not set a retirement year yet.
 *
 * @gqlQueryField
 * @gqlAnnotate semanticNonNull
 */
export async function retirementSettings(): Promise<RetirementSettings | null> {
  const row = await model("AppSettings").findByIdOrNull(true);
  return {
    retirementYear: row?.retirementYear ?? null,
    inflationRate: ANNUAL_INFLATION_RATE,
    drawdownRate: RETIREMENT_DRAWDOWN_RATE,
  };
}

/** Set (or clear) the user's planned retirement year. Pass `null` to clear — the forecast then runs without a retirement transition. @gqlMutationField */
export async function retirementSettingsUpdate(
  /** Calendar year of planned retirement, or `null` to clear. Valid range is 1900–2200. */
  retirementYear: Int | null,
): Promise<RetirementSettings> {
  await model("AppSettings")
    .insert({ singleton: true, retirementYear })
    .onConflictDoUpdate({
      target: AppSettings.singleton,
      set: { retirementYear, updatedAt: new Date() },
    });
  model("AppSettings").clearCache(true);
  return {
    retirementYear,
    inflationRate: ANNUAL_INFLATION_RATE,
    drawdownRate: RETIREMENT_DRAWDOWN_RATE,
  };
}

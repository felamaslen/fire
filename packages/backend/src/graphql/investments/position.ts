import DataLoader from "dataloader";
import { inArray } from "drizzle-orm";
import type { Float } from "grats";

import { currentScope } from "@/auth/session-als";
import { db } from "@/db";
import { model } from "@/db/drizzle-model";
import { InvestmentTransactions } from "@/db/schema/investments";

import type { Context } from "../context";
import { Money } from "../money";
import { NetWorthCategoryAsset } from "../net-worth/categories";
import { effectiveAssetFilter } from "./effective-filter";
import { loadInvestmentLots } from "./lots";
import {
  dailyGainPercent,
  InvestmentStats,
  loadInvestmentStats,
  percentGainPosition,
  reinvestedValue,
  totalCostPosition,
  totalGainPosition,
  totalValuePosition,
} from "./stats";

/** Summary of DRIP (dividend-reinvestment) activity for one `InvestmentPosition`. @gqlType */
export class InvestmentReinvested {
  constructor(
    /** Units acquired via dividend reinvestments. @gqlField */
    public readonly units: Float,
    private readonly costMinor: number,
    private readonly valueMinor: number | null,
    private readonly currency: string,
  ) {}

  /** Total cost of DRIP units (sum of `units × price` for drip transactions). @gqlField */
  cost(): Money {
    return Money.fromMinorDenomination(this.costMinor, this.currency);
  }

  /** Current market value of the reinvested units. `null` until at least one price is known. @gqlField */
  value(): Money | null {
    if (this.valueMinor === null) return null;
    return Money.fromMinorDenomination(this.valueMinor, this.currency);
  }
}

function maybeMoney(minor: number | null, currency: string): Money | null {
  return minor === null ? null : Money.fromMinorDenomination(minor, currency);
}

/**
 * Holdings, cost basis, and gain/loss for an `Investment` — either the aggregate across every wrapper (`Investment.position`) or filtered to a single wrapper (`InvestmentWrapper.position`). Same shape in both cases.
 *
 * All money values are in the parent investment's currency.
 *
 * @gqlType
 */
export class InvestmentPosition {
  constructor(
    /** Stats at the chart-flavoured cap — drives the "headline" view (`units`, `costBasis*`, `totalValue`, `dailyGain*`, `reinvested`). For a wound-down wrapper this freezes at the pre-sell-off peak so the headline matches the chart's right edge. */
    private readonly s: InvestmentStats,
    /** Loader scope for "today"-flavoured numbers — drives the gain breakdown (`realisedValue`, `realisedGain`, `unrealisedGain`, `totalCost`, `totalGain`, `percentGain`, `feesAndTaxes`). Uses the transfer-out cap only, so wind-down sells flow through realised gain rather than being silently dropped by the chart cap. `null` when the position was built without a `Context` (e.g. internal aggregations) — gain fields then fall back to the headline stats and FIFO-less approximations.
     *
     * `chartDateCap` may be set in addition to `transferDateCap` when a sold-out cap also applies; it's used to load the FIFO-cost-of-remaining for `costBasis*` so the per-share basis matches the headline-frozen units.
     */
    private readonly todayScope: {
      ctx: Context;
      investmentId: string;
      assetIds?: string[];
      transferDateCap?: string;
      chartDateCap?: string;
      extraScopes?: ReadonlyArray<{ assetId: string; dateCap: string }>;
    } | null = null,
  ) {}

  private async sToday(): Promise<InvestmentStats> {
    if (!this.todayScope) return this.s;
    return loadInvestmentStats(this.todayScope.ctx, {
      investmentId: this.todayScope.investmentId,
      currency: this.currency,
      ...(this.todayScope.assetIds
        ? { assetIds: this.todayScope.assetIds }
        : {}),
      ...(this.todayScope.transferDateCap
        ? { dateCap: this.todayScope.transferDateCap }
        : {}),
      ...(this.todayScope.extraScopes
        ? { extraScopes: this.todayScope.extraScopes }
        : {}),
    });
  }

  /** Lots at the transfer cap — drives the gain breakdown. */
  private async lots(): Promise<{
    costOfRemainingMinor: number;
    realisedGainMinor: number;
  }> {
    if (!this.todayScope) {
      // Fallback: no FIFO context — approximate with the non-lot aggregates.
      // `costOfRemainingMinor` falls back to `unitsPriceSum − reinvestedCostSum`
      // (gross capital-in for the slice less DRIP cost), which agrees with FIFO
      // only when there have been no sells.
      return {
        costOfRemainingMinor: this.s.unitsPriceSum - this.s.reinvestedCostSum,
        realisedGainMinor: 0,
      };
    }
    return loadInvestmentLots(this.todayScope.ctx, {
      investmentId: this.todayScope.investmentId,
      ...(this.todayScope.assetIds
        ? { assetIds: this.todayScope.assetIds }
        : {}),
      ...(this.todayScope.transferDateCap
        ? { dateCap: this.todayScope.transferDateCap }
        : {}),
      ...(this.todayScope.extraScopes
        ? { extraScopes: this.todayScope.extraScopes }
        : {}),
    });
  }

  /** Lots at the chart cap — drives `costBasis*`, where the per-share basis must match the chart-frozen `units`. For positions with no sold-out cap, this is identical to `lots()` (DataLoader caches it as the same key). */
  private async chartLots(): Promise<{ costOfRemainingMinor: number }> {
    if (!this.todayScope) {
      return {
        costOfRemainingMinor: this.s.unitsPriceSum - this.s.reinvestedCostSum,
      };
    }
    const cap = this.todayScope.chartDateCap ?? this.todayScope.transferDateCap;
    return loadInvestmentLots(this.todayScope.ctx, {
      investmentId: this.todayScope.investmentId,
      ...(this.todayScope.assetIds
        ? { assetIds: this.todayScope.assetIds }
        : {}),
      ...(cap ? { dateCap: cap } : {}),
      ...(this.todayScope.extraScopes
        ? { extraScopes: this.todayScope.extraScopes }
        : {}),
    });
  }

  /** `currency` is known to be non-null here — this resolver is only ever constructed from a single-investment stats slice. */
  private get currency(): string {
    if (this.s.currency === null) {
      throw new Error("InvestmentPosition built from a multi-investment slice");
    }
    return this.s.currency;
  }

  /** Net units held. @gqlField */
  get units(): Float {
    return this.s.unitsHeld as Float;
  }

  /** Average price paid per share currently held under FIFO lot accounting (oldest buys consumed first by sells). DRIP buys carry zero cost — the dividend was already income, so reinvested shares contribute their full market value to total return rather than appearing as new capital. Computed against the chart-frozen units (so for a wound-down wrapper this reports the per-share basis at the pre-sell-off peak). `null` when no units are held at the chart cap. @gqlField */
  async costBasis(): Promise<Money | null> {
    if (this.s.unitsHeld === 0) return null;
    const { costOfRemainingMinor } = await this.chartLots();
    return Money.fromMinorDenomination(
      costOfRemainingMinor / this.s.unitsHeld,
      this.currency,
    );
  }

  /** `costBasis` plus a flat `(taxes + fees) / unitsHeld` charge per held unit. Fees and taxes are not lot-tracked, so this approximation overstates fees per remaining unit when there have been sells. `null` when no units are held. @gqlField */
  async costBasisWithFees(): Promise<Money | null> {
    if (this.s.unitsHeld === 0) return null;
    const { costOfRemainingMinor } = await this.chartLots();
    return Money.fromMinorDenomination(
      (costOfRemainingMinor + this.s.taxesSum + this.s.feesSum) /
        this.s.unitsHeld,
      this.currency,
    );
  }

  /** Current market value of units held — or, for a fully-sold position, the realised sell proceeds. For a wound-down wrapper viewed via the chart cap this freezes at the pre-sell-off peak. `null` until at least one price is known for the investment. @gqlField */
  totalValue(): Money | null {
    return maybeMoney(totalValuePosition(this.s), this.currency);
  }

  /** Cumulative realised proceeds from sells (sum of `|units| × price` over every sell tx in the today-flavoured slice, in pre-future-split currency). Surfaced beneath `totalValue` so a position that's been trimmed shows both what's still in the market and what's already been taken out. @gqlField */
  async realisedValue(): Promise<Money> {
    const today = await this.sToday();
    return Money.fromMinorDenomination(today.sellValueSum, this.currency);
  }

  /** Total fees and taxes paid across every transaction in the today-flavoured slice. Detracts from `totalGain`: the breakdown `unrealisedGain + realisedGain − feesAndTaxes` reconciles to `totalGain`. @gqlField */
  async feesAndTaxes(): Promise<Money> {
    const today = await this.sToday();
    return Money.fromMinorDenomination(
      today.feesSum + today.taxesSum,
      this.currency,
    );
  }

  /** Gross capital deployed — cumulative buy cost excluding DRIP (DRIP buys are reinvested dividends, not new capital), plus paid fees and taxes. Independent of how much has subsequently been sold; never goes negative even when realised proceeds exceed deployed capital. @gqlField */
  async totalCost(): Promise<Money> {
    const today = await this.sToday();
    return Money.fromMinorDenomination(totalCostPosition(today), this.currency);
  }

  /** Total return (realised + unrealised) on the position. Equivalent to `marketValueOfHeld + realisedValue − totalCost` evaluated at "today" (transfer cap only). `null` until a price is known for a still-held position. @gqlField */
  async totalGain(): Promise<Money | null> {
    const today = await this.sToday();
    return maybeMoney(totalGainPosition(today), this.currency);
  }

  /** Realised P&L from sells under FIFO accounting: each sell's proceeds minus the cost of the lots it consumed (DRIP lots at zero cost). Cumulative across all sells in the today-flavoured slice; `0` when no sells have happened. @gqlField */
  async realisedGain(): Promise<Money> {
    const { realisedGainMinor } = await this.lots();
    return Money.fromMinorDenomination(realisedGainMinor, this.currency);
  }

  /** Unrealised P&L on currently-held units: `marketValueOfHeld − costOfRemainingLots` (FIFO, DRIP at zero cost) at "today". For a wound-down wrapper this is `0` even though the headline `totalValue` is frozen at peak — the breakdown answers "what's still on the table", which post-wind-down is nothing. `null` when held units have no known price. @gqlField */
  async unrealisedGain(): Promise<Money | null> {
    const today = await this.sToday();
    if (today.unitsHeld === 0) {
      return Money.fromMinorDenomination(0, this.currency);
    }
    if (today.priceLatest === null) return null;
    const { costOfRemainingMinor } = await this.lots();
    return Money.fromMinorDenomination(
      today.unitsHeld * today.priceLatest - costOfRemainingMinor,
      this.currency,
    );
  }

  /** Total return as a fraction of `totalCost` (gross deployed capital, DRIP excluded). `null` until at least one price is known, or when `totalCost` is zero. @gqlField */
  async percentGain(): Promise<Float | null> {
    const today = await this.sToday();
    return percentGainPosition(today) as Float | null;
  }

  /** Change in market value of the held position over the most recent pricing interval, sourced exclusively from the live Yahoo quote's `previousClose`. `null` when no live quote is available, when the position is fully sold, or when the caller asked to skip live prices. @gqlField */
  dailyGainValue(): Money | null {
    return maybeMoney(this.s.dailyGainValueMinor, this.currency);
  }

  /** Fractional change in market value over the most recent pricing interval. Same sourcing + null conditions as `dailyGainValue`. @gqlField */
  dailyGainPercent(): Float | null {
    return dailyGainPercent(this.s) as Float | null;
  }

  /** DRIP (dividend-reinvestment) activity on this position. @gqlField */
  reinvested(): InvestmentReinvested {
    return new InvestmentReinvested(
      this.s.reinvestedUnits as Float,
      this.s.reinvestedCostSum,
      reinvestedValue(this.s),
      this.currency,
    );
  }
}

/** One wrapper's slice of an `Investment`. Holdings and stats are on `position`; the wrapper itself is on `asset`. @gqlType */
export class InvestmentWrapper {
  constructor(
    private readonly investmentId: string,
    private readonly assetId: string,
  ) {}

  /** The wrapper (a `STOCK` or `PENSION` net-worth asset) this slice belongs to. @gqlField */
  async asset(): Promise<NetWorthCategoryAsset> {
    const row = await model("NetWorthCategoryAssets").findById(this.assetId);
    return NetWorthCategoryAsset.load(row);
  }

  /** Holdings, cost basis, and gain/loss filtered to this wrapper. Folds in the wrapper's own `transfersIn` (each source's pre-transfer history of this investment) and respects its `transferOut` cap, so the unit count agrees with `Investment.position(filterAssetIdIn: [this.assetId])` — e.g. on a transferred-into wrapper a transferred-then-sold investment correctly nets to zero rather than reading negative. @gqlField */
  async position(ctx: Context): Promise<InvestmentPosition> {
    const { extraScopes, transferDateCap, dateCap } =
      await effectiveAssetFilter(ctx, [this.assetId]);
    const s = await loadInvestmentStats(ctx, {
      investmentId: this.investmentId,
      assetIds: [this.assetId],
      ...(dateCap ? { dateCap } : {}),
      ...(extraScopes.length > 0 ? { extraScopes } : {}),
    });
    return new InvestmentPosition(s, {
      ctx,
      investmentId: this.investmentId,
      assetIds: [this.assetId],
      ...(transferDateCap ? { transferDateCap } : {}),
      ...(dateCap ? { chartDateCap: dateCap } : {}),
      ...(extraScopes.length > 0 ? { extraScopes } : {}),
    });
  }
}

/**
 * Batches `InvestmentWrapper` lookups across investments: a page of N investments fires one `GROUP BY (investmentId, assetId)` instead of N separate queries. Caches results across requests since the backend owns every `InvestmentTransactions` write. One DataLoader per session data-scope so demo and real sessions don't share cached rows.
 */
const wrappersByInvestmentLoaders = new Map<
  string,
  DataLoader<string, InvestmentWrapper[]>
>();

function wrappersLoader(): DataLoader<string, InvestmentWrapper[]> {
  const scope = currentScope();
  let loader = wrappersByInvestmentLoaders.get(scope);
  if (loader) return loader;
  loader = new DataLoader<string, InvestmentWrapper[]>(
    async (investmentIds) => {
      const rows = await db
        .select({
          investmentId: InvestmentTransactions.investmentId,
          assetId: InvestmentTransactions.assetId,
        })
        .from(InvestmentTransactions)
        .where(
          inArray(
            InvestmentTransactions.investmentId,
            investmentIds as string[],
          ),
        )
        .groupBy(
          InvestmentTransactions.investmentId,
          InvestmentTransactions.assetId,
        );
      const byInvestment = new Map<string, InvestmentWrapper[]>();
      for (const row of rows) {
        const list = byInvestment.get(row.investmentId) ?? [];
        list.push(new InvestmentWrapper(row.investmentId, row.assetId));
        byInvestment.set(row.investmentId, list);
      }
      return investmentIds.map((id) => byInvestment.get(id) ?? []);
    },
  );
  wrappersByInvestmentLoaders.set(scope, loader);
  return loader;
}

/**
 * Load every wrapper in which an investment has any recorded transactions (including ones where units have net-zero after sells, so callers can see historically-held positions).
 */
export async function loadInvestmentWrappers(
  investmentId: string,
): Promise<InvestmentWrapper[]> {
  return wrappersLoader().load(investmentId);
}

export function invalidateInvestmentWrappers(investmentId: string): void {
  wrappersLoader().clear(investmentId);
}

/** Tests only. */
export function TEST__clearWrapperCache(): void {
  for (const l of wrappersByInvestmentLoaders.values()) l.clearAll();
  wrappersByInvestmentLoaders.clear();
}

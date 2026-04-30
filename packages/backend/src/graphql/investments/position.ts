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
import {
  costBasis,
  costBasisWithFees,
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
  constructor(private readonly s: InvestmentStats) {}

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

  /** Average price paid per share currently held, excluding fees and taxes. `null` when no units are held. @gqlField */
  costBasis(): Money | null {
    return maybeMoney(costBasis(this.s), this.currency);
  }

  /** Average price paid per share currently held, including fees and taxes. `null` when no units are held. @gqlField */
  costBasisWithFees(): Money | null {
    return maybeMoney(costBasisWithFees(this.s), this.currency);
  }

  /** Current market value of units held — or, for a fully-sold position, the realised sell proceeds. `null` until at least one price is known for the investment. @gqlField */
  totalValue(): Money | null {
    return maybeMoney(totalValuePosition(this.s), this.currency);
  }

  /** Net capital-in for the units currently held (excluding fees and taxes): each buy adds its consideration, each sell subtracts it. For a fully-sold position this is gross buy cost. @gqlField */
  totalCost(): Money {
    return Money.fromMinorDenomination(
      totalCostPosition(this.s),
      this.currency,
    );
  }

  /** Total return (realised + unrealised) on the position — `totalValue - totalCost`. `null` until at least one price is known. @gqlField */
  totalGain(): Money | null {
    return maybeMoney(totalGainPosition(this.s), this.currency);
  }

  /** Total return as a fraction of `totalCost`. `null` until at least one price is known, or when `totalCost` is zero. @gqlField */
  percentGain(): Float | null {
    return percentGainPosition(this.s) as Float | null;
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

  /** Holdings, cost basis, and gain/loss filtered to this wrapper. @gqlField */
  async position(ctx: Context): Promise<InvestmentPosition> {
    const s = await loadInvestmentStats(ctx, {
      investmentId: this.investmentId,
      assetIds: [this.assetId],
    });
    return new InvestmentPosition(s);
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

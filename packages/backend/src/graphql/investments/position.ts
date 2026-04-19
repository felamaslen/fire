import { strict as assert } from "node:assert";

import { eq, sql } from "drizzle-orm";
import type { Float, Int } from "grats";

import { db } from "@/db";
import { InvestmentTransactions } from "@/db/schema/investments";
import { NetWorthCategoryAssets } from "@/db/schema/net-worth";

import type { Context } from "../context";
import { Money } from "../money";
import { NetWorthCategoryAsset } from "../net-worth/categories";
import {
  costBasis,
  costBasisWithFees,
  dailyGainPercent,
  dailyGainValue,
  InvestmentStats,
  loadInvestmentStats,
  percentGain,
  reinvestedValue,
  totalCost,
  totalGain,
  totalValue,
} from "./stats";

/** Summary of DRIP (dividend-reinvestment) activity for one `InvestmentPosition`. @gqlType */
export class InvestmentReinvested {
  constructor(
    /** Units acquired via dividend reinvestments. @gqlField */
    public readonly units: Int,
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

  /** Net units held. @gqlField */
  get units(): Int {
    return this.s.unitsHeld as Int;
  }

  /** Average price paid per share currently held, excluding fees and taxes. `null` when no units are held. @gqlField */
  costBasis(): Money | null {
    return maybeMoney(costBasis(this.s), this.s.currency);
  }

  /** Average price paid per share currently held, including fees and taxes. `null` when no units are held. @gqlField */
  costBasisWithFees(): Money | null {
    return maybeMoney(costBasisWithFees(this.s), this.s.currency);
  }

  /** Current market value of units held. `null` until at least one price is known for the investment. @gqlField */
  totalValue(): Money | null {
    return maybeMoney(totalValue(this.s), this.s.currency);
  }

  /** Net capital-in for the units currently held (excluding fees and taxes): each buy adds its consideration, each sell subtracts it. @gqlField */
  totalCost(): Money {
    return Money.fromMinorDenomination(totalCost(this.s), this.s.currency);
  }

  /** Unrealised gain on the held position — `totalValue - totalCost`. `null` until at least one price is known. @gqlField */
  totalGain(): Money | null {
    return maybeMoney(totalGain(this.s), this.s.currency);
  }

  /** Unrealised gain as a fraction of `totalCost`. `null` until at least one price is known, or when `totalCost` is zero. @gqlField */
  percentGain(): Float | null {
    return percentGain(this.s) as Float | null;
  }

  /** Change in market value of the held position over the most recent pricing interval. When a live quote is available, compares it against yesterday's close; otherwise compares the two most recent cached closes. `null` until enough price history exists to compute it. @gqlField */
  dailyGainValue(): Money | null {
    return maybeMoney(dailyGainValue(this.s), this.s.currency);
  }

  /** Fractional change in unit price over the most recent pricing interval. `null` until enough price history exists to compute it. @gqlField */
  dailyGainPercent(): Float | null {
    return dailyGainPercent(this.s) as Float | null;
  }

  /** DRIP (dividend-reinvestment) activity on this position. @gqlField */
  reinvested(): InvestmentReinvested {
    return new InvestmentReinvested(
      this.s.reinvestedUnits as Int,
      this.s.reinvestedCostSum,
      reinvestedValue(this.s),
      this.s.currency,
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
    const [row] = await db
      .select()
      .from(NetWorthCategoryAssets)
      .where(eq(NetWorthCategoryAssets.id, this.assetId));
    assert(row, `NetWorthCategoryAsset ${this.assetId} missing`);
    return NetWorthCategoryAsset.load(row);
  }

  /** Holdings, cost basis, and gain/loss filtered to this wrapper. @gqlField */
  async position(ctx: Context): Promise<InvestmentPosition> {
    const s = await loadInvestmentStats(ctx, this.investmentId, this.assetId);
    return new InvestmentPosition(s);
  }
}

/**
 * Load every wrapper in which an investment has any recorded transactions (including ones where units have net-zero after sells, so callers can see historically-held positions).
 */
export async function loadInvestmentWrappers(
  investmentId: string,
): Promise<InvestmentWrapper[]> {
  const rows = await db
    .select({
      assetId: InvestmentTransactions.assetId,
      units: sql<number>`SUM(${InvestmentTransactions.units})`.as("units"),
    })
    .from(InvestmentTransactions)
    .where(eq(InvestmentTransactions.investmentId, investmentId))
    .groupBy(InvestmentTransactions.assetId);
  return rows.map((r) => new InvestmentWrapper(investmentId, r.assetId));
}

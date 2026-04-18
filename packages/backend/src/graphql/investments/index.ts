import { strict as assert } from "node:assert";

import { desc, eq } from "drizzle-orm";
import { GraphQLError } from "graphql";
import type { ID } from "grats";

import { db } from "@/db";
import { Investments } from "@/db/schema/investments";

import { assertCurrencyCode, Money } from "../money";
import { VOID, type Void } from "../void";
import {
  InvestmentPosition,
  InvestmentWrapper,
  loadInvestmentWrappers,
} from "./position";
import { loadInvestmentStats } from "./stats";
import {
  InvestmentStockSplit,
  loadInvestmentStockSplits,
} from "./stock-splits";
import {
  InvestmentTransaction,
  loadInvestmentTransactions,
} from "./transactions";

/** A listed security identified by its ticker on the relevant exchange. @gqlType */
export class InvestmentStock {
  readonly __typename = "InvestmentStock" as const;
  constructor(
    /** Ticker on the relevant exchange (e.g. `SMT.L`, `AAPL`). @gqlField */
    public readonly code: string,
  ) {}
}

/** A fund identified by a URL to its product page (e.g. a fund platform's page). @gqlType */
export class InvestmentFund {
  readonly __typename = "InvestmentFund" as const;
  constructor(
    /** Link to the fund's product page. @gqlField */
    public readonly url: string,
  ) {}
}

/** The underlying instrument an `Investment` represents: a listed stock or a fund. @gqlUnion */
export type InvestmentAsset = InvestmentStock | InvestmentFund;

/** A tradable holding — either a listed stock or a fund. `position` gives the aggregate across every wrapper that holds this investment; per-wrapper numbers live on each `wrappers[].position`. @gqlType */
export class Investment {
  constructor(
    /** @gqlField */
    public readonly id: ID,
    /** @gqlField */
    public readonly name: string,
    /** What kind of instrument this investment represents. @gqlField */
    public readonly asset: InvestmentAsset,
    /** ISO-4217 code of the currency every price and transaction for this investment is quoted in. @gqlField */
    public readonly currency: string,
  ) {}

  static load(row: typeof Investments.$inferSelect): Investment {
    const asset: InvestmentAsset =
      row.stockCode !== null
        ? new InvestmentStock(row.stockCode)
        : (assert(
            row.fundLink !== null,
            "Investment missing stockCode and fundLink",
          ),
          new InvestmentFund(row.fundLink));
    return new Investment(row.id as ID, row.name, asset, row.currency);
  }

  /** Transactions booked against this investment, oldest-first.
   *
   * @gqlField
   * @gqlAnnotate semanticNonNull
   */
  async transactions(): Promise<InvestmentTransaction[] | null> {
    return loadInvestmentTransactions(this.id);
  }

  /** Stock-split events on this investment, oldest-first.
   *
   * @gqlField
   * @gqlAnnotate semanticNonNull
   */
  async stockSplits(): Promise<InvestmentStockSplit[] | null> {
    return loadInvestmentStockSplits(this.id);
  }

  /** Most recent split-adjusted unit price known for this investment. `null` if no prices have been recorded yet. @gqlField */
  async unitPriceCached(): Promise<Money | null> {
    const s = await loadInvestmentStats(this.id);
    if (s.priceLatest === null) return null;
    return Money.fromMinorDenomination(s.priceLatest, s.currency);
  }

  /** Holdings, cost basis, and gain/loss aggregated across every wrapper. @gqlField */
  async position(): Promise<InvestmentPosition> {
    const s = await loadInvestmentStats(this.id);
    return new InvestmentPosition(s);
  }

  /** Per-wrapper breakdown of the investment. One entry per `(investment, asset)` pairing with at least one recorded transaction.
   *
   * @gqlField
   * @gqlAnnotate semanticNonNull
   */
  async wrappers(): Promise<InvestmentWrapper[] | null> {
    return loadInvestmentWrappers(this.id);
  }
}

/** Identifies the underlying instrument when creating or updating an `Investment`. Exactly one field must be set. @gqlInput */
export type InvestmentAssetInput =
  | { stock: InvestmentStockInput }
  | { fund: InvestmentFundInput };

/** @gqlInput */
export type InvestmentStockInput = {
  /** Ticker on the relevant exchange (e.g. `SMT.L`, `AAPL`). */
  code: string;
};

/** @gqlInput */
export type InvestmentFundInput = {
  /** Link to the fund's product page. */
  url: string;
};

function assetInputToColumns(input: InvestmentAssetInput): {
  stockCode: string | null;
  fundLink: string | null;
} {
  if ("stock" in input) {
    return { stockCode: input.stock.code, fundLink: null };
  }
  return { stockCode: null, fundLink: input.fund.url };
}

/** Create a new investment. @gqlMutationField */
export async function investmentCreate(
  name: string,
  /** ISO-4217 currency code every price and transaction for this investment will be quoted in. */
  currency: string,
  /** What kind of instrument this investment represents. */
  asset: InvestmentAssetInput,
): Promise<Investment> {
  assertCurrencyCode(currency);
  const columns = assetInputToColumns(asset);
  const [row] = await db
    .insert(Investments)
    .values({ name, currency, ...columns })
    .returning();
  return Investment.load(row);
}

/** Partially update an investment. Omitted (or `null`) fields are left unchanged. @gqlMutationField */
export async function investmentUpdate(
  id: ID,
  name?: string | null,
  /** New underlying instrument. When set, the supplied variant fully replaces the previous one (e.g. switching from a stock to a fund). */
  asset?: InvestmentAssetInput | null,
): Promise<Investment> {
  const patch: Partial<typeof Investments.$inferInsert> = {};
  if (name != null) patch.name = name;
  if (asset != null) Object.assign(patch, assetInputToColumns(asset));
  if (Object.keys(patch).length === 0) {
    const [row] = await db
      .select()
      .from(Investments)
      .where(eq(Investments.id, id));
    if (!row) throw new GraphQLError(`Investment ${id} not found`);
    return Investment.load(row);
  }
  const [row] = await db
    .update(Investments)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(Investments.id, id))
    .returning();
  if (!row) throw new GraphQLError(`Investment ${id} not found`);
  return Investment.load(row);
}

/** Delete an investment and all its transactions, stock splits, and prices. @gqlMutationField */
export async function investmentDelete(id: ID): Promise<Void> {
  await db.delete(Investments).where(eq(Investments.id, id));
  return VOID;
}

/** All investments recorded on the server, most-recently-created first.
 *
 * @gqlQueryField
 * @gqlAnnotate semanticNonNull
 */
export async function investments(): Promise<Investment[] | null> {
  const rows = await db
    .select()
    .from(Investments)
    .orderBy(desc(Investments.createdAt));
  return rows.map(Investment.load);
}

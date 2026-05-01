import { strict as assert } from "node:assert";

import DataLoader from "dataloader";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  lt,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { GraphQLError } from "graphql";
import type { Float, ID, Int } from "grats";
import type { IsEqual } from "type-fest";

import { db } from "@/db";
import { InvestmentTransactions } from "@/db/schema/investments";
import {
  NetWorthCategoryAssets,
  netWorthCategoryAssetType,
  NetWorthCategoryLiabilities,
  netWorthCategoryLiabilityType,
  NetWorthCategoryOptions,
  NetWorthEntries,
  NetWorthValueAmounts,
  NetWorthValues,
} from "@/db/schema/net-worth";

import { type Context, contextAwareDataLoader } from "../context";
import type { Date as CalendarDate } from "../date";
import {
  type CashContribution,
  loadAssetCashContributionsConnection,
} from "../investments/cash-planning-transactions";
import {
  type InvestmentTransfer,
  loadInvestmentTransferOutForAsset,
  loadInvestmentTransfersInForAsset,
} from "../investments/transfers";
import { buildConnection, type Connection } from "../pagination";
import { PlanningAccount } from "../planning/index";
import { VOID, type Void } from "../void";

/** Kind of asset a category represents. @gqlEnum */
export type NetWorthAssetType =
  | "CASH"
  | "STOCK"
  | "OPTION"
  | "PENSION"
  | "PROPERTY"
  | "VEHICLE"
  | "MISC";

/** Kind of liability a category represents. @gqlEnum */
export type NetWorthLiabilityType = "CREDIT_CARD" | "LOAN" | "MISC";

/** Top-level discriminator for `NetWorthCategory` — picks which subtype (asset, liability, or equity-option) is being addressed. @gqlEnum */
export type NetWorthCategoryKind = "ASSET" | "LIABILITY" | "OPTION";

/** Combined type filter for `Query.netWorthCategories` — covers every value of `NetWorthAssetType` and `NetWorthLiabilityType` so a single `filterTypeIn` argument works regardless of category kind. Equity-option categories have no `type` column, so they're excluded whenever this filter is set. @gqlEnum */
export type NetWorthCategoryType =
  | "CASH"
  | "STOCK"
  | "OPTION"
  | "PENSION"
  | "PROPERTY"
  | "VEHICLE"
  | "MISC"
  | "CREDIT_CARD"
  | "LOAN";

// Grats requires literal-union @gqlEnum members, so the GraphQL types above
// are duplicated from the `pgEnum` definitions. These compile-time assertions
// fail the build if the two ever drift out of sync.
const _assertAssetTypeMatchesDb: IsEqual<
  NetWorthAssetType,
  (typeof netWorthCategoryAssetType.enumValues)[number]
> = true;
const _assertLiabilityTypeMatchesDb: IsEqual<
  NetWorthLiabilityType,
  (typeof netWorthCategoryLiabilityType.enumValues)[number]
> = true;
const _assertCategoryTypeMatchesDb: IsEqual<
  NetWorthCategoryType,
  NetWorthAssetType | NetWorthLiabilityType
> = true;
void _assertAssetTypeMatchesDb;
void _assertLiabilityTypeMatchesDb;
void _assertCategoryTypeMatchesDb;

const ASSET_TYPES: ReadonlySet<NetWorthCategoryType> = new Set(
  netWorthCategoryAssetType.enumValues,
);
const LIABILITY_TYPES: ReadonlySet<NetWorthCategoryType> = new Set(
  netWorthCategoryLiabilityType.enumValues,
);

/** A reusable bucket used to classify NetWorthValues (assets, liabilities, or options). @gqlInterface */
export interface NetWorthCategory {
  /** @gqlField */
  id: ID;
  /** @gqlField */
  name(): Promise<string>;
}

type AssetRow = typeof NetWorthCategoryAssets.$inferSelect;
type LiabilityRow = typeof NetWorthCategoryLiabilities.$inferSelect;

/** A reusable bucket for assets (current account, pension pot, property, ...). @gqlType */
export class NetWorthCategoryAsset implements NetWorthCategory {
  readonly __typename = "NetWorthCategoryAsset" as const;

  private rowCache: AssetRow | null = null;
  private rowPromise: Promise<AssetRow> | null = null;

  constructor(
    /** @gqlField */
    public readonly id: ID,
    /** A thunk that returns the full DB row. Only invoked on the first access
     * of a non-`id` field so `{ id }` selections don't trigger any DB work. */
    private readonly rowLoader: () => Promise<AssetRow>,
  ) {}

  static load(row: AssetRow): NetWorthCategoryAsset {
    const inst = new NetWorthCategoryAsset(row.id as ID, () =>
      Promise.resolve(row),
    );
    inst.rowCache = row;
    return inst;
  }

  static fromId(id: string): NetWorthCategoryAsset {
    return new NetWorthCategoryAsset(id as ID, async () => {
      const [row] = await db
        .select()
        .from(NetWorthCategoryAssets)
        .where(eq(NetWorthCategoryAssets.id, id));
      assert(row, `NetWorthCategoryAsset ${id} not found`);
      return row;
    });
  }

  private async row(): Promise<AssetRow> {
    if (this.rowCache) return this.rowCache;
    this.rowPromise ??= this.rowLoader().then((r) => (this.rowCache = r));
    return this.rowPromise;
  }

  /** @gqlField */
  async name(): Promise<string> {
    return (await this.row()).name;
  }

  /** @gqlField */
  async type(): Promise<NetWorthAssetType> {
    return (await this.row()).type;
  }

  /** Assumed annual growth rate as a percentage (e.g. 3 for +3%/year). Negative for depreciation. Used by the net-worth forecast. Only set on `PROPERTY` and `VEHICLE`; null means no extrapolation. @gqlField */
  async growthRate(): Promise<Float | null> {
    const g = (await this.row()).growthRate;
    return g === null ? null : (Number(g) as Float);
  }

  /** Calendar date from which the pot can be drawn down (e.g. UK pension access age). Only meaningful for `PENSION` assets; null means "accessible now". The retirement forecast skips drawdown on this pot until the date is reached. @gqlField */
  async accessibleFrom(): Promise<CalendarDate | null> {
    return (await this.row()).accessibleFrom;
  }

  /** Paginated, date-desc list of every cash contribution for this wrapper — both external `InvestmentDeposit`s (dividends, tax relief, …) and `AssetCashPlanningTransaction`s originating in a planning cash account, interleaved by date and used to back the "Manage cash deposits" dialog on the investments page.
   *
   * @gqlField
   * @gqlAnnotate semanticNonNull
   */
  async cashContributions(
    first?: Int | null,
    after?: ID | null,
  ): Promise<Connection<CashContribution> | null> {
    return loadAssetCashContributionsConnection(this.id, first, after);
  }

  /** True when the wrapper has been recorded in some past `NetWorthEntries` but is missing (or zero) in the latest one — same gate the cash-float computation uses to surface zero "available to invest". A wrapper that's never been recorded yet (e.g. just created) is not defunct. @gqlField */
  async isDefunct(ctx: Context): Promise<boolean> {
    return defunctnessLoader(ctx).load(this.id);
  }

  /** The outgoing transfer for this wrapper, if any — at most one. When set, this wrapper's holdings and cash are treated as fully migrated into the destination wrapper on the transfer date. @gqlField */
  async transferOut(ctx: Context): Promise<InvestmentTransfer | null> {
    return loadInvestmentTransferOutForAsset(ctx, this.id);
  }

  /** Incoming transfers into this wrapper. Each contributes its source wrapper's full transaction and cash history into this one's portfolio aggregation from its `date`. @gqlField */
  async transfersIn(ctx: Context): Promise<InvestmentTransfer[]> {
    return loadInvestmentTransfersInForAsset(ctx, this.id);
  }

  /** Date the wrapper was fully sold out — every position's net split-adjusted units is zero, the wrapper has at least one transaction, and there is no `transferOut` (otherwise that takes precedence as the "defunct" reason). The date is the last transaction in the wrapper, i.e. the closing sell that brought everything to zero. `null` for any wrapper that still holds units, has no transactions, or has been transferred out. @gqlField */
  async soldOutOn(ctx: Context): Promise<CalendarDate | null> {
    return soldOutOnLoader(ctx).load(this.id);
  }
}

/** Per-request batched loader for `NetWorthCategoryAsset.soldOutOn`. One SQL groups every requested asset's transactions by `(assetId, investmentId)`, computes the split-adjusted net per position, and reports `MAX(date)` for assets where every net is zero AND there's no `InvestmentTransfers` row out. */
const soldOutOnLoader = contextAwareDataLoader(
  () =>
    new DataLoader<string, CalendarDate | null>(async (assetIds) => {
      const ids = [...assetIds];
      const rows = await db.execute<{
        assetId: string;
        soldOutOn: string | null;
      }>(sql`
        WITH tx_adj AS (
          SELECT
            "InvestmentTransactions"."assetId",
            "InvestmentTransactions"."investmentId",
            "InvestmentTransactions".date,
            "InvestmentTransactions".units * COALESCE(EXP((
              SELECT SUM(LN(s.ratio))
              FROM "InvestmentStockSplits" s
              WHERE s."investmentId" = "InvestmentTransactions"."investmentId"
                AND s.date > "InvestmentTransactions".date
            )), 1) AS adj_units
          FROM "InvestmentTransactions"
          WHERE ${inArray(InvestmentTransactions.assetId, ids)}
        ),
        per_pos AS (
          SELECT
            "assetId",
            "investmentId",
            SUM(adj_units) AS net,
            MAX(date) AS last_date
          FROM tx_adj
          GROUP BY "assetId", "investmentId"
        )
        SELECT
          per_pos."assetId" AS "assetId",
          MAX(per_pos.last_date)::text AS "soldOutOn"
        FROM per_pos
        LEFT JOIN "InvestmentTransfers"
          ON "InvestmentTransfers"."assetIdFrom" = per_pos."assetId"
        WHERE "InvestmentTransfers"."assetIdFrom" IS NULL
        GROUP BY per_pos."assetId"
        HAVING BOOL_AND(ABS(per_pos.net) < 1e-9)
      `);
      const byId = new Map<string, CalendarDate>();
      for (const r of rows.rows ?? rows) {
        if (r.soldOutOn) byId.set(r.assetId, new Date(r.soldOutOn));
      }
      return ids.map((id) => byId.get(id) ?? null);
    }),
);

/** Per-request batched loader for `NetWorthCategoryAsset.isDefunct`. One SQL groups by `categoryAssetId` and reports `(everRecorded, activeInLatest)`; an asset only flips to defunct when it was ever recorded but the latest entry no longer carries a positive value for it. */
const defunctnessLoader = contextAwareDataLoader(
  () =>
    new DataLoader<string, boolean>(async (assetIds) => {
      const ids = [...assetIds];
      const rows = await db
        .select({
          assetId: sql<string>`${NetWorthValues.categoryAssetId}`.as("assetId"),
          ever: sql<boolean>`bool_or(true)`.as("ever"),
          activeInLatest:
            sql<boolean>`bool_or(${NetWorthEntries.date} = (SELECT MAX(date) FROM "NetWorthEntries") AND ${NetWorthValueAmounts.amount} > 0)`.as(
              "activeInLatest",
            ),
        })
        .from(NetWorthValues)
        .innerJoin(
          NetWorthEntries,
          eq(NetWorthEntries.id, NetWorthValues.entryId),
        )
        .innerJoin(
          NetWorthValueAmounts,
          eq(NetWorthValueAmounts.valueId, NetWorthValues.id),
        )
        .where(inArray(NetWorthValues.categoryAssetId, ids))
        .groupBy(NetWorthValues.categoryAssetId);
      const byId = new Map(rows.map((r) => [r.assetId, r]));
      return ids.map((id) => {
        const r = byId.get(id);
        if (!r) return false; // never recorded → not defunct (just unrecorded)
        return r.ever && !r.activeInLatest;
      });
    }),
);

/** Look up an asset category by id. Returns `null` when no row matches.
 *
 * @gqlQueryField
 */
export async function netWorthCategoryAsset(
  id: ID,
): Promise<NetWorthCategoryAsset | null> {
  const [row] = await db
    .select()
    .from(NetWorthCategoryAssets)
    .where(eq(NetWorthCategoryAssets.id, id));
  if (!row) return null;
  return NetWorthCategoryAsset.load(row);
}

/** A reusable bucket for liabilities (credit card, mortgage, personal loan, ...). @gqlType */
export class NetWorthCategoryLiability implements NetWorthCategory {
  readonly __typename = "NetWorthCategoryLiability" as const;

  private rowCache: LiabilityRow | null = null;
  private rowPromise: Promise<LiabilityRow> | null = null;

  constructor(
    /** @gqlField */
    public readonly id: ID,
    /** A thunk that returns the full DB row. Only invoked on the first access
     * of a non-`id` field so `{ id }` selections don't trigger any DB work. */
    private readonly rowLoader: () => Promise<LiabilityRow>,
  ) {}

  static load(row: LiabilityRow): NetWorthCategoryLiability {
    const inst = new NetWorthCategoryLiability(row.id as ID, () =>
      Promise.resolve(row),
    );
    inst.rowCache = row;
    return inst;
  }

  static fromId(id: string): NetWorthCategoryLiability {
    return new NetWorthCategoryLiability(id as ID, async () => {
      const [row] = await db
        .select()
        .from(NetWorthCategoryLiabilities)
        .where(eq(NetWorthCategoryLiabilities.id, id));
      assert(row, `NetWorthCategoryLiability ${id} not found`);
      return row;
    });
  }

  private async row(): Promise<LiabilityRow> {
    if (this.rowCache) return this.rowCache;
    this.rowPromise ??= this.rowLoader().then((r) => (this.rowCache = r));
    return this.rowPromise;
  }

  /** @gqlField */
  async name(): Promise<string> {
    return (await this.row()).name;
  }

  /** @gqlField */
  async type(): Promise<NetWorthLiabilityType> {
    return (await this.row()).type;
  }

  /** Annual interest rate as a percentage (e.g. 5.25 for 5.25%). Present iff type is LOAN. @gqlField */
  async interestRate(): Promise<Float | null> {
    const i = (await this.row()).interestRate;
    return i === null ? null : (Number(i) as Float);
  }

  /** When true, the liability is hidden from aggregate totals. @gqlField */
  async skip(): Promise<boolean> {
    return (await this.row()).skip;
  }

  /** The asset this liability is funding (for LTV calcs), if any. @gqlField */
  async asset(): Promise<NetWorthCategoryAsset | null> {
    const assetId = (await this.row()).categoryAssetId;
    return assetId == null ? null : NetWorthCategoryAsset.fromId(assetId);
  }

  /** Planning account this liability is billed from (credit cards only). When set, the planner emits predicted monthly payment transactions on that account. @gqlField */
  async billedFromAccount(): Promise<PlanningAccount | null> {
    const accountId = (await this.row()).billedFromAccountId;
    return accountId == null ? null : PlanningAccount.fromId(accountId);
  }
}

/** A reusable bucket for equity options (e.g. "My company shares"). @gqlType */
export class NetWorthCategoryOption implements NetWorthCategory {
  readonly __typename = "NetWorthCategoryOption" as const;

  constructor(
    /** @gqlField */
    public readonly id: ID,
    private readonly nameValue: string,
  ) {}

  static load(
    row: typeof NetWorthCategoryOptions.$inferSelect,
  ): NetWorthCategoryOption {
    return new NetWorthCategoryOption(row.id as ID, row.name);
  }

  /** @gqlField */
  async name(): Promise<string> {
    return this.nameValue;
  }
}

type CategoryCursor = { c: string; i: string };
const DEFAULT_PAGE_SIZE = 20;

function encodeCategoryCursor(row: {
  createdAt: Date | string;
  id: string;
}): ID {
  const c =
    row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt;
  const payload: CategoryCursor = { c, i: row.id };
  return Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  ) as ID;
}

function decodeCategoryCursor(raw: string): CategoryCursor {
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as CategoryCursor;
    if (typeof parsed.c !== "string" || typeof parsed.i !== "string") {
      throw new Error("invalid cursor");
    }
    return parsed;
  } catch {
    throw new Error("invalid cursor");
  }
}

/**
 * Paginated list of all net-worth categories (assets, liabilities, options), newest first.
 *
 * @gqlQueryField
 * @gqlAnnotate semanticNonNull
 */
export async function netWorthCategories(
  first?: Int | null,
  after?: ID | null,
  last?: Int | null,
  before?: ID | null,
  /** When set and non-empty, only categories whose kind is in this list are returned. Omitted / null / empty includes every kind. */
  filterKindIn?: NetWorthCategoryKind[] | null,
  /** When set and non-empty, only categories whose `type` is in this list are returned. Asset and liability rows are filtered against their respective `type` columns; equity-option categories have no `type` and are excluded whenever this filter is set. Omitted / null / empty applies no type filter. */
  filterTypeIn?: NetWorthCategoryType[] | null,
): Promise<Connection<NetWorthCategory> | null> {
  assert(
    first == null || last == null,
    "Pass either `first` or `last`, not both.",
  );
  assert(
    after == null || before == null,
    "Pass either `after` or `before`, not both.",
  );

  const forward = last == null;
  const limit = forward
    ? (first ?? DEFAULT_PAGE_SIZE)
    : (last ?? DEFAULT_PAGE_SIZE);
  const cursorRaw = forward ? after : before;
  const cursor = cursorRaw ? decodeCategoryCursor(cursorRaw) : null;

  type Fetched = NetWorthCategory & { createdAtDate: Date };

  const kindFilter =
    filterKindIn && filterKindIn.length > 0 ? new Set(filterKindIn) : null;
  const typeFilter =
    filterTypeIn && filterTypeIn.length > 0 ? new Set(filterTypeIn) : null;
  const includeAssets = !kindFilter || kindFilter.has("ASSET");
  const includeLiabilities = !kindFilter || kindFilter.has("LIABILITY");
  // Options have no `type` column, so a non-empty `typeFilter` excludes them.
  const includeOptions =
    (!kindFilter || kindFilter.has("OPTION")) && !typeFilter;

  const assetTypeWhere = typeFilter
    ? (() => {
        const matches = [...typeFilter].filter((t): t is NetWorthAssetType =>
          ASSET_TYPES.has(t),
        );
        return matches.length > 0
          ? inArray(NetWorthCategoryAssets.type, matches)
          : null;
      })()
    : undefined;
  const liabilityTypeWhere = typeFilter
    ? (() => {
        const matches = [...typeFilter].filter(
          (t): t is NetWorthLiabilityType => LIABILITY_TYPES.has(t),
        );
        return matches.length > 0
          ? inArray(NetWorthCategoryLiabilities.type, matches)
          : null;
      })()
    : undefined;

  const runPaged = async <T extends { createdAt: Date; id: string }>(
    table:
      | typeof NetWorthCategoryAssets
      | typeof NetWorthCategoryLiabilities
      | typeof NetWorthCategoryOptions,
    map: (row: T) => NetWorthCategory,
    extraWhere?: SQL,
  ): Promise<Fetched[]> => {
    const cursorWhere: SQL | undefined = cursor
      ? forward
        ? or(
            lt(table.createdAt, new Date(cursor.c)),
            and(
              eq(table.createdAt, new Date(cursor.c)),
              lt(table.id, cursor.i),
            ),
          )
        : or(
            gt(table.createdAt, new Date(cursor.c)),
            and(
              eq(table.createdAt, new Date(cursor.c)),
              gt(table.id, cursor.i),
            ),
          )
      : undefined;

    const rows = (await db
      .select()
      .from(table)
      .where(extraWhere ? and(cursorWhere, extraWhere) : cursorWhere)
      .orderBy(
        forward ? desc(table.createdAt) : asc(table.createdAt),
        forward ? desc(table.id) : asc(table.id),
      )
      .limit(limit + 1)) as T[];

    // Attach `createdAtDate` onto the mapped instance in place so class
    // methods on the NetWorth*Category types (e.g. `asset()` /
    // `billedFromAccount()`) survive — a plain-object spread would drop
    // prototype methods and the corresponding fields would resolve to null.
    return rows.map(
      (row) =>
        Object.assign(map(row), { createdAtDate: row.createdAt }) as Fetched,
    );
  };

  const [assets, liabilities, options] = await Promise.all([
    includeAssets && assetTypeWhere !== null
      ? runPaged(
          NetWorthCategoryAssets,
          (row) =>
            NetWorthCategoryAsset.load(
              row as typeof NetWorthCategoryAssets.$inferSelect,
            ),
          assetTypeWhere,
        )
      : Promise.resolve([] as Fetched[]),
    includeLiabilities && liabilityTypeWhere !== null
      ? runPaged(
          NetWorthCategoryLiabilities,
          (row) =>
            NetWorthCategoryLiability.load(
              row as typeof NetWorthCategoryLiabilities.$inferSelect,
            ),
          liabilityTypeWhere,
        )
      : Promise.resolve([] as Fetched[]),
    includeOptions
      ? runPaged(NetWorthCategoryOptions, (row) =>
          NetWorthCategoryOption.load(
            row as typeof NetWorthCategoryOptions.$inferSelect,
          ),
        )
      : Promise.resolve([] as Fetched[]),
  ]);

  const merged = [...assets, ...liabilities, ...options].sort((a, b) => {
    const dt = b.createdAtDate.getTime() - a.createdAtDate.getTime();
    if (dt !== 0) return forward ? dt : -dt;
    const cmp = a.id.localeCompare(b.id);
    return forward ? -cmp : cmp;
  });

  const windowed = merged.slice(0, limit + 1);
  const hasExtra = windowed.length > limit;
  const page = hasExtra ? windowed.slice(0, limit) : windowed;
  const ordered = forward ? page : [...page].reverse();

  return buildConnection<NetWorthCategory>(
    ordered,
    (node) => {
      const src = ordered.find((r) => r.id === node.id)!;
      return encodeCategoryCursor({
        createdAt: src.createdAtDate,
        id: node.id,
      });
    },
    {
      hasNextPage: forward ? hasExtra : cursor != null,
      hasPreviousPage: forward ? cursor != null : hasExtra,
    },
  );
}

/** Create payload for an asset category. @gqlInput */
export type NetWorthCategoryAssetInput = {
  name: string;
  type: NetWorthAssetType;
  /** Decimal-fraction assumed annual growth rate (e.g. 0.03 for +3%/year, -0.15 for a vehicle depreciating 15%/year). Only valid for `PROPERTY` and `VEHICLE`. Omit for other types. */
  growthRate?: Float | null;
  /** Calendar date from which the pot can be drawn down. Only valid for `PENSION`. Omit for other types. */
  accessibleFrom?: CalendarDate | null;
};

/** Create payload for a liability category. @gqlInput */
export type NetWorthCategoryLiabilityInput = {
  name: string;
  type: NetWorthLiabilityType;
  /** Optional link to the asset this liability funds. */
  assetId?: ID | null;
  /** Annual interest rate as a percentage (e.g. 5.25 for 5.25%). Required iff type is LOAN. */
  interestRate?: Float | null;
  /** `PlanningAccount.id` this liability is billed from — only valid when `type` is `CREDIT_CARD`. */
  billedFromAccountId?: ID | null;
  /** Hide this liability from aggregate totals. Defaults to false. */
  skip?: boolean | null;
};

/** Create payload for an equity-option category. @gqlInput */
export type NetWorthCategoryOptionInput = {
  name: string;
};

/** Category create payload; exactly one of `asset`, `liability`, `option` must be set. @gqlInput */
export type NetWorthCategoryInput =
  | {
      /** Payload for creating an asset category. */
      asset: NetWorthCategoryAssetInput;
    }
  | {
      /** Payload for creating a liability category. */
      liability: NetWorthCategoryLiabilityInput;
    }
  | {
      /** Payload for creating an equity-option category. */
      option: NetWorthCategoryOptionInput;
    };

/** Partial update for an asset category; unset fields are left unchanged. @gqlInput */
export type NetWorthCategoryAssetPatch = {
  name?: string | null;
  type?: NetWorthAssetType | null;
  /** Decimal-fraction assumed annual growth rate. Pass null explicitly to clear. Only valid for `PROPERTY` and `VEHICLE`. */
  growthRate?: Float | null;
  /** Calendar date from which the pot can be drawn down. Pass null explicitly to clear. Only valid for `PENSION`. */
  accessibleFrom?: CalendarDate | null;
};

/** Partial update for a liability category; unset fields are left unchanged. @gqlInput */
export type NetWorthCategoryLiabilityPatch = {
  name?: string | null;
  type?: NetWorthLiabilityType | null;
  /** Link to the asset this liability funds. */
  assetId?: ID | null;
  /** Annual interest rate as a percentage (e.g. 5.25 for 5.25%). */
  interestRate?: Float | null;
  /** `PlanningAccount.id` this liability is billed from — only valid when the liability is a credit card. Pass null explicitly to clear. */
  billedFromAccountId?: ID | null;
  /** Hide this liability from aggregate totals. */
  skip?: boolean | null;
};

/** Partial update for an equity-option category; unset fields are left unchanged. @gqlInput */
export type NetWorthCategoryOptionPatch = {
  name?: string | null;
};

/** Category patch; exactly one of `asset`, `liability`, `option` must be set. @gqlInput */
export type NetWorthCategoryPatch =
  | {
      /** Partial update for an asset category. */
      asset: NetWorthCategoryAssetPatch;
    }
  | {
      /** Partial update for a liability category. */
      liability: NetWorthCategoryLiabilityPatch;
    }
  | {
      /** Partial update for an equity-option category. */
      option: NetWorthCategoryOptionPatch;
    };

/** Category reference; exactly one of `asset`, `liability`, `option` must be set. @gqlInput */
export type NetWorthCategoryRef =
  | {
      /** ID of an asset category. */
      asset: ID;
    }
  | {
      /** ID of a liability category. */
      liability: ID;
    }
  | {
      /** ID of an equity-option category. */
      option: ID;
    };

function validateAssetGrowthRate(
  type: NetWorthAssetType,
  growthRate: Float | null | undefined,
): void {
  if (growthRate == null) return;
  assert(
    type === "PROPERTY" || type === "VEHICLE",
    "growthRate is only valid when type is PROPERTY or VEHICLE",
  );
}

function validateAssetAccessibleFrom(
  type: NetWorthAssetType,
  accessibleFrom: CalendarDate | null | undefined,
): void {
  if (accessibleFrom == null) return;
  assert(
    type === "PENSION",
    "accessibleFrom is only valid when type is PENSION",
  );
}

function validateLiabilityInput(input: NetWorthCategoryLiabilityInput): void {
  const isLoan = input.type === "LOAN";
  const hasRate =
    input.interestRate !== null && input.interestRate !== undefined;
  assert(!isLoan || hasRate, "interestRate is required when type is LOAN");
  assert(isLoan || !hasRate, "interestRate must be null when type is not LOAN");
  const hasBilledFrom = input.billedFromAccountId != null;
  assert(
    !hasBilledFrom || input.type === "CREDIT_CARD",
    "billedFromAccountId is only valid when type is CREDIT_CARD",
  );
}

/** Create a new category (asset, liability, or option). @gqlMutationField */
export async function netWorthCategoryCreate(
  input: NetWorthCategoryInput,
  ctx: Context,
): Promise<NetWorthCategory> {
  if ("asset" in input) {
    validateAssetGrowthRate(input.asset.type, input.asset.growthRate);
    validateAssetAccessibleFrom(input.asset.type, input.asset.accessibleFrom);
    const [row] = await db
      .insert(NetWorthCategoryAssets)
      .values({
        name: input.asset.name,
        type: input.asset.type,
        growthRate:
          input.asset.growthRate == null
            ? null
            : String(input.asset.growthRate),
        accessibleFrom: input.asset.accessibleFrom ?? null,
      })
      .returning();
    ctx.invalidate({ typename: "NetWorthCategoryAsset", id: null });
    return NetWorthCategoryAsset.load(row);
  }
  if ("liability" in input) {
    validateLiabilityInput(input.liability);
    const [row] = await db
      .insert(NetWorthCategoryLiabilities)
      .values({
        name: input.liability.name,
        type: input.liability.type,
        categoryAssetId: input.liability.assetId ?? null,
        interestRate:
          input.liability.interestRate == null
            ? null
            : String(input.liability.interestRate),
        billedFromAccountId: input.liability.billedFromAccountId ?? null,
        skip: input.liability.skip ?? false,
      })
      .returning();
    ctx.invalidate({ typename: "NetWorthCategoryLiability", id: null });
    return NetWorthCategoryLiability.load(row);
  }
  const [row] = await db
    .insert(NetWorthCategoryOptions)
    .values({ name: input.option.name })
    .returning();
  ctx.invalidate({ typename: "NetWorthCategoryOption", id: null });
  return NetWorthCategoryOption.load(row);
}

/**
 * Partially update an existing category. Only fields present on the matching variant are changed.
 * The variant of `patch` picks which kind to update.
 * @gqlMutationField
 */
export async function netWorthCategoryUpdate(
  id: ID,
  patch: NetWorthCategoryPatch,
  ctx: Context,
): Promise<NetWorthCategory> {
  if ("asset" in patch) {
    if (
      patch.asset.growthRate !== undefined &&
      patch.asset.growthRate != null
    ) {
      // Only enforce the type constraint when a rate is actually being set;
      // the DB's CHECK covers all combinations once the row is updated.
      const nextType = patch.asset.type;
      if (nextType != null)
        validateAssetGrowthRate(nextType, patch.asset.growthRate);
    }
    if (
      patch.asset.accessibleFrom !== undefined &&
      patch.asset.accessibleFrom != null
    ) {
      const nextType = patch.asset.type;
      if (nextType != null)
        validateAssetAccessibleFrom(nextType, patch.asset.accessibleFrom);
    }
    const [row] = await db
      .update(NetWorthCategoryAssets)
      .set({
        ...(patch.asset.name != null && { name: patch.asset.name }),
        ...(patch.asset.type != null && { type: patch.asset.type }),
        ...(patch.asset.growthRate !== undefined && {
          growthRate:
            patch.asset.growthRate == null
              ? null
              : String(patch.asset.growthRate),
        }),
        ...(patch.asset.accessibleFrom !== undefined && {
          accessibleFrom: patch.asset.accessibleFrom,
        }),
        updatedAt: new Date(),
      })
      .where(eq(NetWorthCategoryAssets.id, id))
      .returning();
    assert(row, `NetWorthCategoryAsset ${id} not found`);
    return NetWorthCategoryAsset.load(row);
  }
  if ("liability" in patch) {
    const [row] = await db
      .update(NetWorthCategoryLiabilities)
      .set({
        ...(patch.liability.name != null && { name: patch.liability.name }),
        ...(patch.liability.type != null && { type: patch.liability.type }),
        ...(patch.liability.assetId !== undefined && {
          categoryAssetId: patch.liability.assetId,
        }),
        ...(patch.liability.interestRate !== undefined && {
          interestRate:
            patch.liability.interestRate == null
              ? null
              : String(patch.liability.interestRate),
        }),
        ...(patch.liability.billedFromAccountId !== undefined && {
          billedFromAccountId: patch.liability.billedFromAccountId,
        }),
        ...(patch.liability.skip != null && { skip: patch.liability.skip }),
        updatedAt: new Date(),
      })
      .where(eq(NetWorthCategoryLiabilities.id, id))
      .returning();
    assert(row, `NetWorthCategoryLiability ${id} not found`);
    const isLoan = row.type === "LOAN";
    assert(
      !isLoan === (row.interestRate === null),
      "interestRate must be non-null iff type is LOAN",
    );
    assert(
      row.billedFromAccountId === null || row.type === "CREDIT_CARD",
      "billedFromAccountId is only valid when type is CREDIT_CARD",
    );
    if (patch.liability.skip != null) {
      // Toggling `skip` flips this liability in or out of two computed
      // aggregates that the mutation's response shape can't carry: every
      // `NetWorthEntry`'s `totalLiabilities` / `totalNet`, and every
      // `NetWorthHistoryPoint`'s `liabilities` / `net`. Each lives on a
      // different parent type, so we invalidate both — the schema-derived
      // map handles the typename → `Query` field lookup.
      ctx.invalidate({ typename: "NetWorthEntry", id: null });
      ctx.invalidate({ typename: "NetWorthHistoryPoint", id: null });
    }
    return NetWorthCategoryLiability.load(row);
  }
  const [row] = await db
    .update(NetWorthCategoryOptions)
    .set({
      ...(patch.option.name != null && { name: patch.option.name }),
      updatedAt: new Date(),
    })
    .where(eq(NetWorthCategoryOptions.id, id))
    .returning();
  assert(row, `NetWorthCategoryOption ${id} not found`);
  return NetWorthCategoryOption.load(row);
}

/** Delete a category. Fails with a human-readable error if any net-worth value still references it. @gqlMutationField */
export async function netWorthCategoryDelete(
  ref: NetWorthCategoryRef,
  ctx: Context,
): Promise<Void> {
  if ("asset" in ref) {
    await assertNoDependentValues(
      NetWorthValues.categoryAssetId,
      ref.asset,
      "asset",
    );
    await db
      .delete(NetWorthCategoryAssets)
      .where(eq(NetWorthCategoryAssets.id, ref.asset));
    ctx.invalidate({ typename: "NetWorthCategoryAsset", id: ref.asset });
  } else if ("liability" in ref) {
    await assertNoDependentValues(
      NetWorthValues.categoryLiabilityId,
      ref.liability,
      "liability",
    );
    await db
      .delete(NetWorthCategoryLiabilities)
      .where(eq(NetWorthCategoryLiabilities.id, ref.liability));
    ctx.invalidate({
      typename: "NetWorthCategoryLiability",
      id: ref.liability,
    });
  } else {
    await assertNoDependentValues(
      NetWorthValues.categoryOptionId,
      ref.option,
      "option",
    );
    await db
      .delete(NetWorthCategoryOptions)
      .where(eq(NetWorthCategoryOptions.id, ref.option));
    ctx.invalidate({ typename: "NetWorthCategoryOption", id: ref.option });
  }
  return VOID;
}

async function assertNoDependentValues(
  column: AnyPgColumn,
  id: string,
  kind: "asset" | "liability" | "option",
): Promise<void> {
  const [row] = await db
    .select({ n: count() })
    .from(NetWorthValues)
    .where(eq(column, id));
  const n = row?.n ?? 0;
  if (n === 0) return;
  throw new GraphQLError(
    `Cannot delete ${kind} category: ${n} net-worth value${n === 1 ? "" : "s"} still reference${n === 1 ? "s" : ""} it. Remove those values first.`,
    { extensions: { code: "CATEGORY_IN_USE", referencingValues: n } },
  );
}

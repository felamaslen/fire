import { strict as assert } from "node:assert";

import { and, asc, count, desc, eq, gt, lt, or, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { GraphQLError } from "graphql";
import type { Float, ID, Int } from "grats";

import { db } from "@/db";
import {
  NetWorthCategoryAssets,
  NetWorthCategoryLiabilities,
  NetWorthCategoryOptions,
  NetWorthValues,
} from "@/db/schema/net-worth";
import { PlanningAccounts } from "@/db/schema/planning";

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

/** A reusable bucket used to classify NetWorthValues (assets, liabilities, or options). @gqlInterface */
export interface NetWorthCategory {
  /** @gqlField */
  id: ID;
  /** @gqlField */
  name: string;
}

/** A reusable bucket for assets (current account, pension pot, property, ...). @gqlType */
export class NetWorthCategoryAsset implements NetWorthCategory {
  readonly __typename = "NetWorthCategoryAsset" as const;

  constructor(
    /** @gqlField */
    public readonly id: ID,
    /** @gqlField */
    public readonly name: string,
    /** @gqlField */
    public readonly type: NetWorthAssetType,
    /** Assumed annual growth rate as a percentage (e.g. 3 for +3%/year). Negative for depreciation. Used by the net-worth forecast. Only set on `PROPERTY` and `VEHICLE`; null means no extrapolation. @gqlField */
    public readonly growthRate: Float | null,
    private readonly createdAt: Date,
  ) {}

  static load(
    row: typeof NetWorthCategoryAssets.$inferSelect,
  ): NetWorthCategoryAsset {
    return new NetWorthCategoryAsset(
      row.id as ID,
      row.name,
      row.type,
      row.growthRate === null ? null : (Number(row.growthRate) as Float),
      row.createdAt,
    );
  }
}

/** A reusable bucket for liabilities (credit card, mortgage, personal loan, ...). @gqlType */
export class NetWorthCategoryLiability implements NetWorthCategory {
  readonly __typename = "NetWorthCategoryLiability" as const;

  constructor(
    /** @gqlField */
    public readonly id: ID,
    /** @gqlField */
    public readonly name: string,
    /** @gqlField */
    public readonly type: NetWorthLiabilityType,
    /** Annual interest rate as a percentage (e.g. 5.25 for 5.25%). Present iff type is LOAN. @gqlField */
    public readonly interestRate: Float | null,
    /** When true, the liability is hidden from aggregate totals. @gqlField */
    public readonly skip: boolean,
    private readonly assetId: string | null,
    private readonly billedFromAccountId: string | null,
    private readonly createdAt: Date,
  ) {}

  static load(
    row: typeof NetWorthCategoryLiabilities.$inferSelect,
  ): NetWorthCategoryLiability {
    return new NetWorthCategoryLiability(
      row.id as ID,
      row.name,
      row.type,
      row.interestRate === null ? null : (Number(row.interestRate) as Float),
      row.skip,
      row.categoryAssetId,
      row.billedFromAccountId,
      row.createdAt,
    );
  }

  /** The asset this liability is funding (for LTV calcs), if any. @gqlField */
  async asset(): Promise<NetWorthCategoryAsset | null> {
    if (!this.assetId) return null;
    const [row] = await db
      .select()
      .from(NetWorthCategoryAssets)
      .where(eq(NetWorthCategoryAssets.id, this.assetId));
    assert(
      row,
      `NetWorthCategoryAsset ${this.assetId} referenced by NetWorthCategoryLiability ${this.id} is missing`,
    );
    return NetWorthCategoryAsset.load(row);
  }

  /** Planning account this liability is billed from (credit cards only). When set, the planner emits predicted monthly payment transactions on that account. @gqlField */
  async billedFromAccount(): Promise<PlanningAccount | null> {
    if (!this.billedFromAccountId) return null;
    const [row] = await db
      .select({
        account: PlanningAccounts,
        asset: NetWorthCategoryAssets,
      })
      .from(PlanningAccounts)
      .innerJoin(
        NetWorthCategoryAssets,
        eq(PlanningAccounts.accountId, NetWorthCategoryAssets.id),
      )
      .where(eq(PlanningAccounts.accountId, this.billedFromAccountId));
    assert(
      row,
      `PlanningAccount ${this.billedFromAccountId} referenced by NetWorthCategoryLiability ${this.id} is missing`,
    );
    return new PlanningAccount({
      assetId: row.account.accountId,
      alias: row.account.alias,
      asset: NetWorthCategoryAsset.load(row.asset),
    });
  }
}

/** A reusable bucket for equity options (e.g. "My company shares"). @gqlType */
export class NetWorthCategoryOption implements NetWorthCategory {
  readonly __typename = "NetWorthCategoryOption" as const;

  constructor(
    /** @gqlField */
    public readonly id: ID,
    /** @gqlField */
    public readonly name: string,
    private readonly createdAt: Date,
  ) {}

  static load(
    row: typeof NetWorthCategoryOptions.$inferSelect,
  ): NetWorthCategoryOption {
    return new NetWorthCategoryOption(row.id as ID, row.name, row.createdAt);
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

  const runPaged = async <T extends { createdAt: Date; id: string }>(
    table:
      | typeof NetWorthCategoryAssets
      | typeof NetWorthCategoryLiabilities
      | typeof NetWorthCategoryOptions,
    map: (row: T) => NetWorthCategory,
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
      .where(cursorWhere)
      .orderBy(
        forward ? desc(table.createdAt) : asc(table.createdAt),
        forward ? desc(table.id) : asc(table.id),
      )
      .limit(limit + 1)) as unknown as T[];

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
    runPaged(NetWorthCategoryAssets, (row) =>
      NetWorthCategoryAsset.load(
        row as typeof NetWorthCategoryAssets.$inferSelect,
      ),
    ),
    runPaged(NetWorthCategoryLiabilities, (row) =>
      NetWorthCategoryLiability.load(
        row as typeof NetWorthCategoryLiabilities.$inferSelect,
      ),
    ),
    runPaged(NetWorthCategoryOptions, (row) =>
      NetWorthCategoryOption.load(
        row as typeof NetWorthCategoryOptions.$inferSelect,
      ),
    ),
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
): Promise<NetWorthCategory> {
  if ("asset" in input) {
    validateAssetGrowthRate(input.asset.type, input.asset.growthRate);
    const [row] = await db
      .insert(NetWorthCategoryAssets)
      .values({
        name: input.asset.name,
        type: input.asset.type,
        growthRate:
          input.asset.growthRate == null
            ? null
            : String(input.asset.growthRate),
      })
      .returning();
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
    return NetWorthCategoryLiability.load(row);
  }
  const [row] = await db
    .insert(NetWorthCategoryOptions)
    .values({ name: input.option.name })
    .returning();
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
  } else if ("liability" in ref) {
    await assertNoDependentValues(
      NetWorthValues.categoryLiabilityId,
      ref.liability,
      "liability",
    );
    await db
      .delete(NetWorthCategoryLiabilities)
      .where(eq(NetWorthCategoryLiabilities.id, ref.liability));
  } else {
    await assertNoDependentValues(
      NetWorthValues.categoryOptionId,
      ref.option,
      "option",
    );
    await db
      .delete(NetWorthCategoryOptions)
      .where(eq(NetWorthCategoryOptions.id, ref.option));
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

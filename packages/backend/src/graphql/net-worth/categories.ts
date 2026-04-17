import { strict as assert } from "node:assert";

import { and, asc, desc, eq, gt, lt, or, type SQL } from "drizzle-orm";
import type { ID, Int } from "grats";

import { db } from "@/db";
import {
  NetWorthCategoryAssets,
  NetWorthCategoryLiabilities,
  NetWorthCategoryOptions,
} from "@/db/schema/net-worth";

import { VOID, type Void } from "../void";
import type { PageInfo } from "./index";

/** Kind of asset a category represents. @gqlEnum */
export type NetWorthAssetType =
  | "CASH"
  | "STOCK"
  | "OPTION"
  | "PENSION"
  | "PROPERTY"
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
  /** @gqlField */
  id!: ID;
  /** @gqlField */
  name!: string;
  /** @gqlField */
  type!: NetWorthAssetType;
  createdAt!: Date;

  constructor(data: Omit<NetWorthCategoryAsset, "__typename">) {
    Object.assign(this, data);
  }
}

/** A reusable bucket for liabilities (credit card, mortgage, personal loan, ...). @gqlType */
export class NetWorthCategoryLiability implements NetWorthCategory {
  readonly __typename = "NetWorthCategoryLiability" as const;
  /** @gqlField */
  id!: ID;
  /** @gqlField */
  name!: string;
  /** @gqlField */
  type!: NetWorthLiabilityType;
  /** Annual rate as a decimal string (e.g. "0.0525" = 5.25%). Present iff type is LOAN. @gqlField */
  interestRate!: string | null;
  assetId!: string | null;
  createdAt!: Date;

  constructor(data: Omit<NetWorthCategoryLiability, "__typename" | "asset">) {
    Object.assign(this, data);
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
    return toNetWorthCategoryAsset(row);
  }
}

/** A reusable bucket for equity options (e.g. "My company shares"). @gqlType */
export class NetWorthCategoryOption implements NetWorthCategory {
  readonly __typename = "NetWorthCategoryOption" as const;
  /** @gqlField */
  id!: ID;
  /** @gqlField */
  name!: string;
  createdAt!: Date;

  constructor(data: Omit<NetWorthCategoryOption, "__typename">) {
    Object.assign(this, data);
  }
}

export function toNetWorthCategoryAsset(
  row: typeof NetWorthCategoryAssets.$inferSelect,
): NetWorthCategoryAsset {
  return new NetWorthCategoryAsset({
    id: row.id,
    name: row.name,
    type: row.type,
    createdAt: row.createdAt,
  });
}

export function toNetWorthCategoryLiability(
  row: typeof NetWorthCategoryLiabilities.$inferSelect,
): NetWorthCategoryLiability {
  return new NetWorthCategoryLiability({
    id: row.id,
    name: row.name,
    type: row.type,
    interestRate: row.interestRate,
    assetId: row.categoryAssetId,
    createdAt: row.createdAt,
  });
}

export function toNetWorthCategoryOption(
  row: typeof NetWorthCategoryOptions.$inferSelect,
): NetWorthCategoryOption {
  return new NetWorthCategoryOption({
    id: row.id,
    name: row.name,
    createdAt: row.createdAt,
  });
}

/** An edge within a NetWorthCategoryConnection. @gqlType */
export type NetWorthCategoryEdge = {
  /** @gqlField */
  cursor: ID;
  /** @gqlField */
  node: NetWorthCategory;
};

/** A cursor-paginated list of NetWorthCategory, newest first. @gqlType */
export type NetWorthCategoryConnection = {
  /** @gqlField */
  edges: NetWorthCategoryEdge[];
  /** @gqlField */
  pageInfo: PageInfo;
};

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
): Promise<NetWorthCategoryConnection | null> {
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

    return rows.map((row) => ({
      ...map(row),
      createdAtDate: row.createdAt,
    }));
  };

  const [assets, liabilities, options] = await Promise.all([
    runPaged(NetWorthCategoryAssets, (row) =>
      toNetWorthCategoryAsset(
        row as typeof NetWorthCategoryAssets.$inferSelect,
      ),
    ),
    runPaged(NetWorthCategoryLiabilities, (row) =>
      toNetWorthCategoryLiability(
        row as typeof NetWorthCategoryLiabilities.$inferSelect,
      ),
    ),
    runPaged(NetWorthCategoryOptions, (row) =>
      toNetWorthCategoryOption(
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

  const edges: NetWorthCategoryEdge[] = ordered.map((row) => ({
    cursor: encodeCategoryCursor({
      createdAt: row.createdAtDate,
      id: row.id,
    }),
    node: row,
  }));

  const pageInfo: PageInfo = {
    hasNextPage: forward ? hasExtra : cursor != null,
    hasPreviousPage: forward ? cursor != null : hasExtra,
    startCursor: edges.length > 0 ? edges[0].cursor : null,
    endCursor: edges.length > 0 ? edges[edges.length - 1].cursor : null,
  };

  return { edges, pageInfo };
}

/** Create payload for an asset category. @gqlInput */
export type NetWorthCategoryAssetInput = {
  name: string;
  type: NetWorthAssetType;
};

/** Create payload for a liability category. @gqlInput */
export type NetWorthCategoryLiabilityInput = {
  name: string;
  type: NetWorthLiabilityType;
  /** Optional link to the asset this liability funds. */
  assetId?: ID | null;
  /** Decimal-string annual rate (e.g. "0.0525"). Required iff type is LOAN. */
  interestRate?: string | null;
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
};

/** Partial update for a liability category; unset fields are left unchanged. @gqlInput */
export type NetWorthCategoryLiabilityPatch = {
  name?: string | null;
  type?: NetWorthLiabilityType | null;
  /** Link to the asset this liability funds. */
  assetId?: ID | null;
  /** Decimal-string annual rate (e.g. "0.0525"). */
  interestRate?: string | null;
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

function validateLiabilityInput(input: NetWorthCategoryLiabilityInput): void {
  const isLoan = input.type === "LOAN";
  const hasRate =
    input.interestRate !== null && input.interestRate !== undefined;
  assert(!isLoan || hasRate, "interestRate is required when type is LOAN");
  assert(isLoan || !hasRate, "interestRate must be null when type is not LOAN");
}

/** Create a new category (asset, liability, or option). @gqlMutationField */
export async function netWorthCategoryCreate(
  input: NetWorthCategoryInput,
): Promise<NetWorthCategory> {
  if ("asset" in input) {
    const [row] = await db
      .insert(NetWorthCategoryAssets)
      .values({ name: input.asset.name, type: input.asset.type })
      .returning();
    return toNetWorthCategoryAsset(row);
  }
  if ("liability" in input) {
    validateLiabilityInput(input.liability);
    const [row] = await db
      .insert(NetWorthCategoryLiabilities)
      .values({
        name: input.liability.name,
        type: input.liability.type,
        categoryAssetId: input.liability.assetId ?? null,
        interestRate: input.liability.interestRate ?? null,
      })
      .returning();
    return toNetWorthCategoryLiability(row);
  }
  const [row] = await db
    .insert(NetWorthCategoryOptions)
    .values({ name: input.option.name })
    .returning();
  return toNetWorthCategoryOption(row);
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
    const [row] = await db
      .update(NetWorthCategoryAssets)
      .set({
        ...(patch.asset.name != null && { name: patch.asset.name }),
        ...(patch.asset.type != null && { type: patch.asset.type }),
        updatedAt: new Date(),
      })
      .where(eq(NetWorthCategoryAssets.id, id))
      .returning();
    assert(row, `NetWorthCategoryAsset ${id} not found`);
    return toNetWorthCategoryAsset(row);
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
          interestRate: patch.liability.interestRate,
        }),
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
    return toNetWorthCategoryLiability(row);
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
  return toNetWorthCategoryOption(row);
}

/** Delete a category. Fails if any value still references it. @gqlMutationField */
export async function netWorthCategoryDelete(
  ref: NetWorthCategoryRef,
): Promise<Void> {
  if ("asset" in ref) {
    await db
      .delete(NetWorthCategoryAssets)
      .where(eq(NetWorthCategoryAssets.id, ref.asset));
  } else if ("liability" in ref) {
    await db
      .delete(NetWorthCategoryLiabilities)
      .where(eq(NetWorthCategoryLiabilities.id, ref.liability));
  } else {
    await db
      .delete(NetWorthCategoryOptions)
      .where(eq(NetWorthCategoryOptions.id, ref.option));
  }
  return VOID;
}

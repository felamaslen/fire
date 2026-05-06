import { strict as assert } from "node:assert";

import DataLoader from "dataloader";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  lt,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { GraphQLError } from "graphql";
import type { Float, ID, Int } from "grats";

import { HOME_CURRENCY } from "@/config";
import { db } from "@/db";
import { model } from "@/db/drizzle-model";
import {
  NetWorthCategoryLiabilities,
  NetWorthCurrencyRates,
  NetWorthEntries,
  NetWorthValueAmounts,
  NetWorthValues,
} from "@/db/schema/net-worth";

import { type Context, contextAwareDataLoader } from "../context";
import type { Date as CalendarDate } from "../date";
import {
  assertCurrencyCode,
  CURRENCIES,
  getMoneyInputFractionalAmount,
  Money,
  type MoneyInput,
} from "../money";
import { VOID, type Void } from "../void";
import {
  NetWorthCategoryAsset,
  NetWorthCategoryLiability,
  NetWorthCategoryOption,
} from "./categories";

/** One net-worth snapshot for a single month. @gqlType */
export class NetWorthEntry {
  constructor(
    /** @gqlField */
    public readonly id: ID,
    /** Any calendar date inside the target month. @gqlField */
    public readonly date: CalendarDate,
  ) {}

  static load(row: typeof NetWorthEntries.$inferSelect): NetWorthEntry {
    return new NetWorthEntry(row.id as ID, row.date);
  }
}

/** Exchange rate captured alongside a net-worth entry; converts one unit of `currency` into `base`. @gqlType */
export type NetWorthCurrencyRate = {
  /** ISO-4217 code the rate resolves into (e.g. "GBP" for a GBP/USD quote). @gqlField */
  base: string;
  /** ISO-4217 code being priced (e.g. "USD" for a GBP/USD quote). @gqlField */
  currency: string;
  /** Units of `base` per one unit of `currency` (e.g. 0.77 for GBP/USD: 1 USD = 0.77 GBP). @gqlField */
  rate: Float;
};

/** A single line item inside a NetWorthEntry. Exactly one of asset / liability / option is populated. @gqlType */
export type NetWorthValue = {
  /** @gqlField */
  id: ID;
  /** Parent `NetWorthEntry.id`. Used by resolvers that need to load entry-scoped state (e.g. currency rates) without re-querying. */
  entryId: string;
  categoryAssetId: string | null;
  categoryLiabilityId: string | null;
  categoryOptionId: string | null;
};

function toNetWorthValue(
  row: typeof NetWorthValues.$inferSelect,
): NetWorthValue {
  return {
    id: row.id,
    entryId: row.entryId,
    categoryAssetId: row.categoryAssetId,
    categoryLiabilityId: row.categoryLiabilityId,
    categoryOptionId: row.categoryOptionId,
  };
}

import {
  buildConnection,
  type Connection,
  decodeCursor,
  encodeCursor,
} from "../pagination";

function entryCursor(entry: { date: Date | string; id: string }): ID {
  const c =
    entry.date instanceof Date
      ? entry.date.toISOString().slice(0, 10)
      : entry.date;
  return encodeCursor(c, entry.id);
}

/** Exchange rates captured for this entry. @gqlField */
export async function currencyRates(
  entry: NetWorthEntry,
): Promise<NetWorthCurrencyRate[]> {
  const rows = await db
    .select()
    .from(NetWorthCurrencyRates)
    .where(eq(NetWorthCurrencyRates.entryId, entry.id));
  return rows.map((r) => ({
    base: r.base,
    currency: r.currency,
    rate: Number(r.rate),
  }));
}

/** The line-item values recorded for this entry. @gqlField */
export async function values(
  entry: NetWorthEntry,
  ctx: Context,
): Promise<NetWorthValue[]> {
  return valuesByEntryLoader(ctx).load(entry.id);
}

/** Per-request batched loader for `NetWorthEntry.values`. One SQL fetches every value across the requested entries with `entryId IN (…)`, then partitions back per entry. Crucially, returning `values()` for all entries in a single tick keeps downstream loaders (`amountHome`'s rate-map / amounts) in one batch — otherwise per-entry timing offsets would split them. */
const valuesByEntryLoader = contextAwareDataLoader(
  () =>
    new DataLoader<string, NetWorthValue[]>(async (entryIds) => {
      const ids = [...entryIds];
      const rows = await db
        .select()
        .from(NetWorthValues)
        .where(inArray(NetWorthValues.entryId, ids));
      const byEntry = new Map<string, NetWorthValue[]>();
      for (const r of rows) {
        const v = toNetWorthValue(r);
        const list = byEntry.get(v.entryId);
        if (list) list.push(v);
        else byEntry.set(v.entryId, [v]);
      }
      return ids.map((id) => byEntry.get(id) ?? []);
    }),
);

/** Subset of `values` whose `liability` is a `LOAN` — the line items that contribute to the loan-overpayment view. Saves clients from fetching every asset / option line just to filter to loans. @gqlField */
export async function loans(
  entry: NetWorthEntry,
  ctx: Context,
): Promise<NetWorthValue[]> {
  return loansByEntryLoader(ctx).load(entry.id);
}

/** Per-request batched loader for `NetWorthEntry.loans`. One SQL fetches every loan value across the requested entries with `entryId IN (…)`, then partitions back per entry. Collapses the `loans` field on a `netWorth(last:N)` connection from N round-trips to one. */
const loansByEntryLoader = contextAwareDataLoader(
  () =>
    new DataLoader<string, NetWorthValue[]>(async (entryIds) => {
      const ids = [...entryIds];
      const rows = await db
        .select({ value: NetWorthValues })
        .from(NetWorthValues)
        .innerJoin(
          NetWorthCategoryLiabilities,
          eq(
            NetWorthCategoryLiabilities.id,
            NetWorthValues.categoryLiabilityId,
          ),
        )
        .where(
          and(
            inArray(NetWorthValues.entryId, ids),
            eq(NetWorthCategoryLiabilities.type, "LOAN"),
          ),
        );
      const byEntry = new Map<string, NetWorthValue[]>();
      for (const r of rows) {
        const v = toNetWorthValue(r.value);
        const list = byEntry.get(v.entryId);
        if (list) list.push(v);
        else byEntry.set(v.entryId, [v]);
      }
      return ids.map((id) => byEntry.get(id) ?? []);
    }),
);

type EntryTotals = { assetsMinor: number; liabilitiesMinor: number };

export function buildRateToHome(
  rows: (typeof NetWorthCurrencyRates.$inferSelect)[],
): Map<string, number> {
  const map = new Map<string, number>([[HOME_CURRENCY, 1]]);
  for (const row of rows) {
    const r = Number(row.rate);
    if (row.base === HOME_CURRENCY) map.set(row.currency, r);
    else if (row.currency === HOME_CURRENCY) map.set(row.base, 1 / r);
  }
  return map;
}

export function convertToHomeMinor(
  amountMinor: number,
  currency: string,
  rateMap: Map<string, number>,
): number {
  assertCurrencyCode(currency);
  const ratio = rateMap.get(currency);
  if (ratio == null) {
    throw new GraphQLError(
      `No exchange rate stored for ${currency} → ${HOME_CURRENCY} on this entry.`,
    );
  }
  const amountMajor = amountMinor / 10 ** CURRENCIES[currency].scale;
  const homeMajor = amountMajor * ratio;
  return Math.round(homeMajor * 10 ** CURRENCIES[HOME_CURRENCY].scale);
}

/** Per-request batched loader for `(totalAssets, totalLiabilities, totalNet)`. One SQL joins every requested entry's values with their amounts and the parent liability's `skip` flag; rates come from `entryRateMapLoader` (one batched SQL across the same entry ids). Aggregates per-entry totals in JS. */
const computeTotals = contextAwareDataLoader(
  (ctx: Context) =>
    new DataLoader<string, EntryTotals>(async (entryIds) => {
      const ids = [...entryIds];
      const [valueRows, rateMaps] = await Promise.all([
        db
          .select({
            entryId: NetWorthValues.entryId,
            categoryLiabilityId: NetWorthValues.categoryLiabilityId,
            liabilitySkip: NetWorthCategoryLiabilities.skip,
            amount: NetWorthValueAmounts.amount,
            currency: NetWorthValueAmounts.currency,
          })
          .from(NetWorthValues)
          .leftJoin(
            NetWorthValueAmounts,
            eq(NetWorthValueAmounts.valueId, NetWorthValues.id),
          )
          .leftJoin(
            NetWorthCategoryLiabilities,
            eq(
              NetWorthCategoryLiabilities.id,
              NetWorthValues.categoryLiabilityId,
            ),
          )
          .where(inArray(NetWorthValues.entryId, ids)),
        Promise.all(ids.map((id) => entryRateMapLoader(ctx).load(id))),
      ]);
      const rateMapByEntry = new Map<string, Map<string, number>>(
        ids.map((id, i) => [id, rateMaps[i]]),
      );
      const totalsByEntry = new Map<string, EntryTotals>();
      for (const id of ids) {
        totalsByEntry.set(id, { assetsMinor: 0, liabilitiesMinor: 0 });
      }
      for (const row of valueRows) {
        if (row.amount == null || row.currency == null) continue;
        const rateMap = rateMapByEntry.get(row.entryId);
        if (!rateMap) continue;
        const totals = totalsByEntry.get(row.entryId);
        if (!totals) continue;
        const homeMinor = convertToHomeMinor(row.amount, row.currency, rateMap);
        if (row.categoryLiabilityId) {
          if (row.liabilitySkip) continue;
          // Liability value amounts are stored signed (typically negative —
          // "you owe £X" is entered as -X). We surface liabilities as a
          // positive magnitude, so take abs here and subtract in `totalNet`.
          totals.liabilitiesMinor += Math.abs(homeMinor);
        } else {
          totals.assetsMinor += homeMinor;
        }
      }
      return ids.map((id) => totalsByEntry.get(id)!);
    }),
);

/**
 * Sum of all asset and option line items for this entry, converted into GBP via the entry's `currencyRates`.
 *
 * @gqlField
 */
export async function totalAssets(
  entry: NetWorthEntry,
  ctx: Context,
): Promise<Money> {
  const { assetsMinor } = await computeTotals(ctx).load(entry.id);
  return Money.fromMinorDenomination(assetsMinor, HOME_CURRENCY);
}

/**
 * Sum of all liability line items for this entry (positive magnitude), converted into GBP via the entry's `currencyRates`. Liabilities with `skip = true` are excluded.
 *
 * @gqlField
 */
export async function totalLiabilities(
  entry: NetWorthEntry,
  ctx: Context,
): Promise<Money> {
  const { liabilitiesMinor } = await computeTotals(ctx).load(entry.id);
  return Money.fromMinorDenomination(liabilitiesMinor, HOME_CURRENCY);
}

/**
 * Net worth for this entry: `totalAssets − totalLiabilities`, in GBP.
 *
 * @gqlField
 */
export async function totalNet(
  entry: NetWorthEntry,
  ctx: Context,
): Promise<Money> {
  const { assetsMinor, liabilitiesMinor } = await computeTotals(ctx).load(
    entry.id,
  );
  return Money.fromMinorDenomination(
    assetsMinor - liabilitiesMinor,
    HOME_CURRENCY,
  );
}

/** Per-request batched loader for an entry's `currency → home` rate map. One SQL fetches all `NetWorthCurrencyRates` with `entryId IN (…)`, then groups back into one `Map` per entry. Used by `amountHome` (which fires once per loan/asset/option value). */
const entryRateMapLoader = contextAwareDataLoader(
  () =>
    new DataLoader<string, Map<string, number>>(async (entryIds) => {
      const ids = [...entryIds];
      const rows = await db
        .select()
        .from(NetWorthCurrencyRates)
        .where(inArray(NetWorthCurrencyRates.entryId, ids));
      const byEntry = new Map<
        string,
        (typeof NetWorthCurrencyRates.$inferSelect)[]
      >();
      for (const r of rows) {
        const list = byEntry.get(r.entryId);
        if (list) list.push(r);
        else byEntry.set(r.entryId, [r]);
      }
      return ids.map((id) => buildRateToHome(byEntry.get(id) ?? []));
    }),
);

/** Per-request batched loader for a value's `NetWorthValueAmounts` rows. One SQL fetches all amounts with `valueId IN (…)`, then groups back per value. Powers both `amounts` and `amountHome`. */
const amountsByValueLoader = contextAwareDataLoader(
  () =>
    new DataLoader<string, (typeof NetWorthValueAmounts.$inferSelect)[]>(
      async (valueIds) => {
        const ids = [...valueIds];
        const rows = await db
          .select()
          .from(NetWorthValueAmounts)
          .where(inArray(NetWorthValueAmounts.valueId, ids));
        const byValue = new Map<
          string,
          (typeof NetWorthValueAmounts.$inferSelect)[]
        >();
        for (const r of rows) {
          const list = byValue.get(r.valueId);
          if (list) list.push(r);
          else byValue.set(r.valueId, [r]);
        }
        return ids.map((id) => byValue.get(id) ?? []);
      },
    ),
);

/**
 * Sum of this line item's `amounts` converted into the home currency via the entry's captured rates. Returned as a positive magnitude regardless of whether the line is an asset, option, or liability — the sign is implied by which `asset` / `liability` / `option` field is populated. Liabilities marked `skip` still report their magnitude here.
 *
 * @gqlField
 */
export async function amountHome(
  value: NetWorthValue,
  ctx: Context,
): Promise<Money> {
  const [rateMap, rows] = await Promise.all([
    entryRateMapLoader(ctx).load(value.entryId),
    amountsByValueLoader(ctx).load(value.id),
  ]);
  let totalMinor = 0;
  for (const row of rows) {
    totalMinor += convertToHomeMinor(row.amount, row.currency, rateMap);
  }
  return Money.fromMinorDenomination(Math.abs(totalMinor), HOME_CURRENCY);
}

/** Monetary amounts for this line item — at most one per currency. @gqlField */
export async function amounts(
  value: NetWorthValue,
  ctx: Context,
): Promise<Money[]> {
  const rows = await amountsByValueLoader(ctx).load(value.id);
  return rows.map((row) =>
    Money.fromMinorDenomination(row.amount, row.currency),
  );
}

/** The asset category this value is recorded against, if any. @gqlField */
export async function asset(
  value: NetWorthValue,
): Promise<NetWorthCategoryAsset | null> {
  if (!value.categoryAssetId) return null;
  const row = await model("NetWorthCategoryAssets").findById(
    value.categoryAssetId,
  );
  return NetWorthCategoryAsset.load(row);
}

/** The liability category this value is recorded against, if any. @gqlField */
export async function liability(
  value: NetWorthValue,
): Promise<NetWorthCategoryLiability | null> {
  if (!value.categoryLiabilityId) return null;
  const row = await model("NetWorthCategoryLiabilities").findById(
    value.categoryLiabilityId,
  );
  return NetWorthCategoryLiability.load(row);
}

/** The option category this value is recorded against, if any. @gqlField */
export async function option(
  value: NetWorthValue,
): Promise<NetWorthCategoryOption | null> {
  if (!value.categoryOptionId) return null;
  const row = await model("NetWorthCategoryOptions").findById(
    value.categoryOptionId,
  );
  return NetWorthCategoryOption.load(row);
}

/**
 * Look up a single net-worth entry by id.
 *
 * @gqlQueryField
 */
export async function netWorthEntry(id: ID): Promise<NetWorthEntry | null> {
  const [row] = await db
    .select()
    .from(NetWorthEntries)
    .where(eq(NetWorthEntries.id, id));
  return row ? NetWorthEntry.load(row) : null;
}

const DEFAULT_PAGE_SIZE = 20;

/**
 * Paginated list of net-worth entries, newest first.
 *
 * @gqlQueryField
 * @gqlAnnotate semanticNonNull
 */
export async function netWorth(
  first?: Int | null,
  after?: ID | null,
  last?: Int | null,
  before?: ID | null,
): Promise<Connection<NetWorthEntry> | null> {
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
  const cursor = cursorRaw ? decodeCursor(cursorRaw) : null;

  const cursorWhere = cursor
    ? forward
      ? or(
          lt(NetWorthEntries.date, new Date(cursor.c)),
          and(
            eq(NetWorthEntries.date, new Date(cursor.c)),
            lt(NetWorthEntries.id, cursor.i),
          ),
        )
      : or(
          gt(NetWorthEntries.date, new Date(cursor.c)),
          and(
            eq(NetWorthEntries.date, new Date(cursor.c)),
            gt(NetWorthEntries.id, cursor.i),
          ),
        )
    : undefined;

  const rows = await db
    .select()
    .from(NetWorthEntries)
    .where(cursorWhere)
    .orderBy(
      forward ? asc(NetWorthEntries.date) : desc(NetWorthEntries.date),
      forward ? asc(NetWorthEntries.id) : desc(NetWorthEntries.id),
    )
    .limit(limit + 1);

  const hasExtra = rows.length > limit;
  const page = hasExtra ? rows.slice(0, limit) : rows;
  const ordered = forward ? page : [...page].reverse();

  return buildConnection(
    ordered.map((row) => NetWorthEntry.load(row)),
    (node) => entryCursor({ date: node.date, id: node.id }),
    {
      hasNextPage: forward ? hasExtra : cursor != null,
      hasPreviousPage: forward ? cursor != null : hasExtra,
    },
  );
}

/** A line item recorded against an asset category. @gqlInput */
export type NetWorthValueAssetInput = {
  /** Existing NetWorthValue id to update. Omit to create a new line item. */
  id?: ID | null;
  /** ID of the asset category this value is recorded against. */
  categoryId: ID;
  /** Monetary amounts for this line item; at most one entry per currency. */
  amounts: MoneyInput[];
};

/** A line item recorded against a liability category. @gqlInput */
export type NetWorthValueLiabilityInput = {
  /** Existing NetWorthValue id to update. Omit to create a new line item. */
  id?: ID | null;
  /** ID of the liability category this value is recorded against. */
  categoryId: ID;
  /** Monetary amounts for this line item; at most one entry per currency. */
  amounts: MoneyInput[];
};

/** A line item recorded against an equity-option category. @gqlInput */
export type NetWorthValueOptionInput = {
  /** Existing NetWorthValue id to update. Omit to create a new line item. */
  id?: ID | null;
  /** ID of the option category this value is recorded against. */
  categoryId: ID;
  /** Monetary amounts for this line item; at most one entry per currency. */
  amounts: MoneyInput[];
};

/** A currency rate to record alongside the entry. Keyed by `currency` within the entry. @gqlInput */
export type NetWorthCurrencyRateInput = {
  /** ISO-4217 currency the rate resolves into (e.g. "GBP"). */
  base: string;
  /** ISO-4217 currency being priced (e.g. "USD"). */
  currency: string;
  /** Units of `base` per one unit of `currency` (e.g. 0.77 for GBP/USD: 1 USD = 0.77 GBP). */
  rate: Float;
};

/** One line item; exactly one of `asset`, `liability`, `option` must be set. @gqlInput */
export type NetWorthValueInput =
  | {
      /** Line item recorded against an asset category. */
      asset: NetWorthValueAssetInput;
    }
  | {
      /** Line item recorded against a liability category. */
      liability: NetWorthValueLiabilityInput;
    }
  | {
      /** Line item recorded against an equity-option category. */
      option: NetWorthValueOptionInput;
    };

type ValueParts = {
  id: string | null;
  row: Omit<typeof NetWorthValues.$inferInsert, "entryId">;
  amounts: MoneyInput[];
};

function valueParts(v: NetWorthValueInput): ValueParts {
  if ("asset" in v) {
    return {
      id: v.asset.id ?? null,
      row: {
        categoryAssetId: v.asset.categoryId,
        categoryLiabilityId: null,
        categoryOptionId: null,
      },
      amounts: v.asset.amounts,
    };
  }
  if ("liability" in v) {
    return {
      id: v.liability.id ?? null,
      row: {
        categoryAssetId: null,
        categoryLiabilityId: v.liability.categoryId,
        categoryOptionId: null,
      },
      amounts: v.liability.amounts,
    };
  }
  return {
    id: v.option.id ?? null,
    row: {
      categoryAssetId: null,
      categoryLiabilityId: null,
      categoryOptionId: v.option.categoryId,
    },
    amounts: v.option.amounts,
  };
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function writeAmounts(
  tx: Tx,
  valueId: string,
  amounts: MoneyInput[],
): Promise<void> {
  const rows = amounts.map((m) => {
    const { currency, amount } = getMoneyInputFractionalAmount(m);
    return { valueId, amount, currency };
  });
  const currencies = rows.map((r) => r.currency);
  await tx
    .delete(NetWorthValueAmounts)
    .where(
      and(
        eq(NetWorthValueAmounts.valueId, valueId),
        currencies.length > 0
          ? notInArray(NetWorthValueAmounts.currency, currencies)
          : undefined,
      ),
    );
  if (rows.length > 0) {
    await tx
      .insert(NetWorthValueAmounts)
      .values(rows)
      .onConflictDoUpdate({
        target: [NetWorthValueAmounts.valueId, NetWorthValueAmounts.currency],
        set: {
          amount: sql`excluded.${sql.identifier("amount")}`,
          updatedAt: new Date(),
        },
      });
  }
}

async function writeCurrencyRates(
  tx: Tx,
  entryId: string,
  rates: NetWorthCurrencyRateInput[],
): Promise<void> {
  const rows = rates.map((r) => {
    assertCurrencyCode(r.base);
    assertCurrencyCode(r.currency);
    assert(
      r.base !== r.currency,
      `Currency rate base and currency must differ (got ${r.base})`,
    );
    return {
      entryId,
      base: r.base,
      currency: r.currency,
      rate: String(r.rate),
    };
  });

  await tx.delete(NetWorthCurrencyRates).where(
    and(
      eq(NetWorthCurrencyRates.entryId, entryId),
      rows.length > 0
        ? notInArray(
            NetWorthCurrencyRates.currency,
            rows.map((r) => r.currency),
          )
        : undefined,
    ),
  );

  if (rows.length === 0) return;
  await tx
    .insert(NetWorthCurrencyRates)
    .values(rows)
    .onConflictDoUpdate({
      target: [NetWorthCurrencyRates.entryId, NetWorthCurrencyRates.currency],
      set: {
        base: sql`excluded.${sql.identifier("base")}`,
        rate: sql`excluded.${sql.identifier("rate")}`,
        updatedAt: new Date(),
      },
    });
}

async function writeValues(
  tx: Tx,
  entryId: string,
  values: NetWorthValueInput[],
): Promise<void> {
  const parts = values.map(valueParts);
  const keepIds = parts.map((p) => p.id).filter((x): x is string => x != null);

  await tx
    .delete(NetWorthValues)
    .where(
      and(
        eq(NetWorthValues.entryId, entryId),
        keepIds.length > 0 ? notInArray(NetWorthValues.id, keepIds) : undefined,
      ),
    );

  for (const p of parts) {
    const [row] = p.id
      ? await tx
          .insert(NetWorthValues)
          .values({ id: p.id, entryId, ...p.row })
          .onConflictDoUpdate({
            target: NetWorthValues.id,
            set: { ...p.row, updatedAt: new Date() },
          })
          .returning({ id: NetWorthValues.id })
      : await tx
          .insert(NetWorthValues)
          .values({ entryId, ...p.row })
          .returning({ id: NetWorthValues.id });
    await writeAmounts(tx, row.id, p.amounts);
  }
}

/**
 * Create a net-worth entry and its values.
 * @gqlMutationField
 */
export async function netWorthCreate(
  /** Any calendar date inside the target month. */
  date: CalendarDate,
  values: NetWorthValueInput[],
  /** Exchange rates captured for this entry, or null to skip. */
  currencyRates: NetWorthCurrencyRateInput[] | null,
  ctx: Context,
): Promise<NetWorthEntry> {
  const result = await withMonthConflictMessage(date, () =>
    db.transaction(async (tx) => {
      const [entry] = await tx
        .insert(NetWorthEntries)
        .values({ date })
        .returning();
      await writeValues(tx, entry.id, values);
      if (currencyRates != null)
        await writeCurrencyRates(tx, entry.id, currencyRates);
      return NetWorthEntry.load(entry);
    }),
  );
  // The new entry isn't yet a member of any cached `netWorth(...)`
  // connection — Apollo can't tell which connection should now contain it.
  // Typename-only invalidation forces every consumer to refetch.
  ctx.invalidate({ typename: "NetWorthEntry", id: null });
  return result;
}

/**
 * Partially update an existing net-worth entry. Only fields passed in are changed.
 * When `values` is set, items with an `id` are upserted, items without one are created,
 * and any existing value on this entry not listed is deleted.
 * @gqlMutationField
 */
export async function netWorthUpdate(
  id: ID,
  /** New calendar date for the entry, or null to keep the existing one. */
  date?: CalendarDate | null,
  /** Line items to apply to this entry, or null to leave the existing set untouched. */
  values?: NetWorthValueInput[] | null,
  /** Exchange rates to apply to this entry, or null to leave the existing set untouched. */
  currencyRates?: NetWorthCurrencyRateInput[] | null,
): Promise<NetWorthEntry> {
  return withMonthConflictMessage(date ?? null, () =>
    db.transaction(async (tx) => {
      const [entry] = await tx
        .update(NetWorthEntries)
        .set({ ...(date != null && { date }), updatedAt: new Date() })
        .where(eq(NetWorthEntries.id, id))
        .returning();
      assert(entry, `NetWorthEntry ${id} not found`);

      if (values != null) await writeValues(tx, entry.id, values);
      if (currencyRates != null)
        await writeCurrencyRates(tx, entry.id, currencyRates);
      return NetWorthEntry.load(entry);
    }),
  );
}

function isMonthUniqueViolation(err: unknown): boolean {
  for (let cur: unknown = err; cur != null; ) {
    if (typeof cur !== "object") break;
    const e = cur as {
      code?: unknown;
      constraint?: unknown;
      constraint_name?: unknown;
      cause?: unknown;
    };
    const constraint = e.constraint ?? e.constraint_name;
    if (e.code === "23505" && constraint === "NetWorthEntries_month_uq")
      return true;
    cur = e.cause;
  }
  return false;
}

async function withMonthConflictMessage<T>(
  date: CalendarDate | null,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isMonthUniqueViolation(err)) {
      const month = date
        ? `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`
        : "that month";
      throw new GraphQLError(
        `A net-worth entry already exists for ${month}. Each month can only have one entry.`,
      );
    }
    throw err;
  }
}

/** Delete a net-worth entry. Its values are removed along with it. @gqlMutationField */
export async function netWorthDelete(id: ID, ctx: Context): Promise<Void> {
  await db.delete(NetWorthEntries).where(eq(NetWorthEntries.id, id));
  // The deleted entry leaves a dangling ref in any cached `netWorth(...)`
  // connection's edges; evicting it triggers Apollo's broadcast, which
  // re-reads consumers and refetches them when the dangling ref shows up.
  ctx.invalidate({ typename: "NetWorthEntry", id });
  return VOID;
}

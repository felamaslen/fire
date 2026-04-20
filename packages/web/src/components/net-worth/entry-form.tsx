import type { InternalRefetchQueriesInclude } from "@apollo/client";
import { useMutation, useSuspenseQuery } from "@apollo/client/react";
import type {
  FormAsyncValidateOrFn,
  FormValidateOrFn,
  ReactFormExtendedApi,
} from "@tanstack/react-form";
import { useForm } from "@tanstack/react-form";
import { Plus, RefreshCw, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";

import { graphql, type ResultOf, type VariablesOf } from "../../graphql";

export const NetWorthEntryFormDocument = graphql(`
  fragment NetWorthEntryForm on NetWorthEntry {
    id
    date
    currencyRates {
      base
      currency
      rate
    }
    values {
      id
      amounts {
        amount
        currency
      }
      asset {
        id
        name
      }
      liability {
        id
        name
      }
      option {
        id
        name
      }
    }
  }
`);

export const NetWorthEntryByIdDocument = graphql(
  `
    query NetWorthEntryById($id: ID!) {
      netWorthEntry(id: $id) {
        ...NetWorthEntryForm
      }
    }
  `,
  [NetWorthEntryFormDocument],
);

export const LatestNetWorthEntryDocument = graphql(
  `
    query LatestNetWorthEntry {
      netWorth(last: 1) {
        edges {
          node {
            id
            ...NetWorthEntryForm
          }
        }
      }
    }
  `,
  [NetWorthEntryFormDocument],
);

export const NetWorthEntryFormCategoriesDocument = graphql(`
  query NetWorthEntryFormCategories {
    currencyDefault
    currencies {
      code
      name
    }
    netWorthCategories(first: 100) {
      edges {
        node {
          __typename
          ... on NetWorthCategoryAsset {
            id
            name
            assetType: type
          }
          ... on NetWorthCategoryLiability {
            id
            name
            liabilityType: type
          }
          ... on NetWorthCategoryOption {
            id
            name
          }
        }
      }
    }
  }
`);

const NetWorthCreateDocument = graphql(`
  mutation NetWorthCreate(
    $date: Date!
    $values: [NetWorthValueInput!]!
    $currencyRates: [NetWorthCurrencyRateInput!]
  ) {
    netWorthCreate(
      date: $date
      values: $values
      currencyRates: $currencyRates
    ) {
      id
    }
  }
`);

const NetWorthUpdateDocument = graphql(`
  mutation NetWorthUpdate(
    $id: ID!
    $date: Date
    $values: [NetWorthValueInput!]
    $currencyRates: [NetWorthCurrencyRateInput!]
  ) {
    netWorthUpdate(
      id: $id
      date: $date
      values: $values
      currencyRates: $currencyRates
    ) {
      id
    }
  }
`);

export type EntryFormData = ResultOf<typeof NetWorthEntryFormDocument>;

type CategoryNode = NonNullable<
  ResultOf<typeof NetWorthEntryFormCategoriesDocument>["netWorthCategories"]
>["edges"][number]["node"];

/** All concrete `NetWorthAssetType` values, derived from the `assetType` selection on the `NetWorthCategoryAsset` variant so a new enum value on the server forces a compile error here until the labels / order get updated. */
type AssetType = Extract<
  CategoryNode,
  { __typename: "NetWorthCategoryAsset" }
>["assetType"];

/** All concrete `NetWorthLiabilityType` values, derived the same way as `AssetType`. */
type LiabilityType = Extract<
  CategoryNode,
  { __typename: "NetWorthCategoryLiability" }
>["liabilityType"];

/** Derived from the oneOf variants of `NetWorthValueInput` — each variant's single key (`asset` / `liability` / `option`) is the "kind". */
type NetWorthValueInput = VariablesOf<
  typeof NetWorthCreateDocument
>["values"][number];
export type CategoryKind = NetWorthValueInput extends infer U
  ? U extends object
    ? keyof U
    : never
  : never;

const CATEGORY_KIND_LABELS = {
  asset: "Assets",
  liability: "Liabilities",
  option: "Options",
} as const satisfies Record<CategoryKind, string>;

const CATEGORY_KINDS = Object.keys(CATEGORY_KIND_LABELS) as CategoryKind[];

export type CategoryOption = {
  kind: CategoryKind;
  id: string;
  name: string;
  /** Sub-type: `NetWorthAssetType` for assets, `NetWorthLiabilityType` for liabilities, or `null` for options (which have no sub-type). */
  subtype: string | null;
};

export function categoryOptions(nodes: CategoryNode[]): CategoryOption[] {
  const out: CategoryOption[] = [];
  for (const n of nodes) {
    if (n.__typename === "NetWorthCategoryAsset")
      out.push({ kind: "asset", id: n.id, name: n.name, subtype: n.assetType });
    else if (n.__typename === "NetWorthCategoryLiability")
      out.push({
        kind: "liability",
        id: n.id,
        name: n.name,
        subtype: n.liabilityType,
      });
    else if (n.__typename === "NetWorthCategoryOption")
      out.push({ kind: "option", id: n.id, name: n.name, subtype: null });
  }
  return out;
}

const ASSET_SUBTYPE_LABELS = {
  CASH: "Cash",
  STOCK: "Stocks",
  OPTION: "Options",
  PENSION: "Pensions",
  PROPERTY: "Property",
  VEHICLE: "Vehicles",
  MISC: "Other",
} as const satisfies Record<AssetType, string>;
const ASSET_SUBTYPE_ORDER = Object.keys(ASSET_SUBTYPE_LABELS) as AssetType[];

const LIABILITY_SUBTYPE_LABELS = {
  CREDIT_CARD: "Credit cards",
  LOAN: "Loans",
  MISC: "Other",
} as const satisfies Record<LiabilityType, string>;
const LIABILITY_SUBTYPE_ORDER = Object.keys(
  LIABILITY_SUBTYPE_LABELS,
) as LiabilityType[];

function subtypeOrderFor(kind: CategoryKind): string[] | null {
  if (kind === "asset") return ASSET_SUBTYPE_ORDER;
  if (kind === "liability") return LIABILITY_SUBTYPE_ORDER;
  return null;
}

function subtypeLabelFor(kind: CategoryKind, subtype: string): string {
  if (kind === "asset" && subtype in ASSET_SUBTYPE_LABELS) {
    return ASSET_SUBTYPE_LABELS[subtype as AssetType];
  }
  if (kind === "liability" && subtype in LIABILITY_SUBTYPE_LABELS) {
    return LIABILITY_SUBTYPE_LABELS[subtype as LiabilityType];
  }
  return subtype;
}

const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;

export type EntryFormMode = { kind: "new" } | { kind: "edit"; entryId: string };

type RateItem = { currency: string; rate: string };
type AmountItem = { amount: string; currency: string };
type LineItem = {
  /** Existing `NetWorthValue.id` when editing — included on update so the server upserts instead of recreating. */
  id: string | null;
  kind: CategoryKind;
  categoryId: string;
  amounts: AmountItem[];
};

function blankLine(kind: CategoryKind, currency: string): LineItem {
  return {
    id: null,
    kind,
    categoryId: "",
    amounts: [{ amount: "", currency }],
  };
}

function entryAsLineItems(entry: EntryFormData): LineItem[] {
  return entry.values.map((v) => {
    const kind: CategoryKind = v.asset
      ? "asset"
      : v.liability
        ? "liability"
        : "option";
    const category = v.asset ?? v.liability ?? v.option;
    return {
      id: v.id,
      kind,
      categoryId: category?.id ?? "",
      amounts: v.amounts.map((a) => ({
        amount: String(a.amount),
        currency: a.currency,
      })),
    };
  });
}

function entryAsRates(entry: EntryFormData): RateItem[] {
  return entry.currencyRates.map((r) => ({
    currency: r.currency,
    rate: String(r.rate),
  }));
}

async function fetchOpenExchangeRates(
  homeCurrency: string,
  codes: string[],
): Promise<Record<string, number>> {
  const appId = import.meta.env.VITE_OPENEXCHANGERATES_APP_ID as
    | string
    | undefined;
  if (!appId) {
    throw new Error(
      "Missing `VITE_OPENEXCHANGERATES_APP_ID`; add it to the web package's .env.",
    );
  }
  // Free-tier openexchangerates always bases at USD; convert to the home
  // currency client-side.
  const res = await fetch(
    `https://openexchangerates.org/api/latest.json?app_id=${encodeURIComponent(appId)}&symbols=${[homeCurrency, ...codes].join(",")}`,
  );
  if (!res.ok) {
    throw new Error(`openexchangerates: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as {
    rates: Record<string, number>;
  };
  const homeVsUsd = body.rates[homeCurrency];
  if (homeVsUsd == null) {
    throw new Error(
      `openexchangerates didn't return a rate for ${homeCurrency}`,
    );
  }
  const out: Record<string, number> = {};
  for (const code of codes) {
    const v = body.rates[code];
    if (v == null) continue;
    // rate = units of currency per 1 home-currency: (X per USD) / (HOME per USD).
    out[code] = v / homeVsUsd;
  }
  return out;
}

export function EntryForm({
  mode,
  entry,
  categories,
  onDone,
  refetchQueries,
}: {
  mode: EntryFormMode;
  /** Source entry to seed defaults from. In edit-mode, the entry being edited; in new-mode, the most recent entry (or null if none exists). */
  entry: EntryFormData | null;
  categories: CategoryOption[];
  onDone: () => void;
  /** Queries to refetch after a successful mutation. Typically the entries-grid query. */
  refetchQueries?: InternalRefetchQueriesInclude;
}) {
  const { data: configData } = useSuspenseQuery(
    NetWorthEntryFormCategoriesDocument,
  );
  const homeCurrency = configData.currencyDefault ?? "GBP";
  const supportedCurrencies = (configData.currencies ?? []).filter(
    (c): c is NonNullable<typeof c> => c !== null,
  );

  const [create, { loading: creating }] = useMutation(NetWorthCreateDocument, {
    refetchQueries,
    onCompleted: () => {
      toast.success("Entry added");
      onDone();
    },
  });
  const [update, { loading: updating }] = useMutation(NetWorthUpdateDocument, {
    refetchQueries,
    onCompleted: () => {
      toast.success("Entry updated");
      onDone();
    },
  });
  const loading = creating || updating;

  const initialItems = entry ? entryAsLineItems(entry) : [];
  const initialRates = entry ? entryAsRates(entry) : [];
  // New-mode carries categories/amounts from the source entry but clears its
  // value ids — those rows need to be created, not upserted into the new entry.
  const items =
    mode.kind === "new"
      ? initialItems.map((i) => ({ ...i, id: null }))
      : initialItems;

  const form = useForm({
    defaultValues: {
      date:
        mode.kind === "edit" && entry
          ? entry.date
          : new Date().toISOString().slice(0, 10),
      rates: initialRates,
      items,
    },
    onSubmit: async ({ value }) => {
      const values = value.items
        .filter((i) => i.categoryId)
        .map((i) => {
          const amounts = i.amounts
            .filter((a) => a.amount !== "")
            .map((a) => ({
              amount: Number.parseFloat(a.amount),
              currency: a.currency,
            }));
          if (amounts.length === 0) return null;
          const body = {
            ...(i.id && { id: i.id }),
            categoryId: i.categoryId,
            amounts,
          };
          return i.kind === "asset"
            ? { asset: body }
            : i.kind === "liability"
              ? { liability: body }
              : { option: body };
        })
        .filter((v): v is NonNullable<typeof v> => v !== null);
      if (values.length === 0) {
        toast.error("Add at least one line item with an amount");
        return;
      }
      const currencyRates = value.rates
        .filter((r) => r.currency && r.rate)
        .map((r) => ({
          base: homeCurrency,
          currency: r.currency,
          rate: Number.parseFloat(r.rate),
        }));
      if (mode.kind === "edit") {
        await update({
          variables: {
            id: mode.entryId,
            date: value.date,
            values,
            currencyRates,
          },
        }).catch((err: Error) => toast.error(err.message));
      } else {
        await create({
          variables: { date: value.date, values, currencyRates },
        }).catch((err: Error) => toast.error(err.message));
      }
    },
  });

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {mode.kind === "edit" ? "Edit entry" : "Add entry"}
        </DialogTitle>
      </DialogHeader>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void form.handleSubmit();
        }}
      >
        <div className="flex items-center gap-2">
          <label className="text-sm font-medium">Date</label>
          <form.Field name="date">
            {(field) => (
              <Input
                type="date"
                className="w-48"
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
              />
            )}
          </form.Field>
        </div>

        <Accordion type="single" collapsible className="space-y-2">
          <AccordionItem value="currencies">
            <AccordionTrigger>Currencies</AccordionTrigger>
            <AccordionContent>
              <CurrenciesSection
                form={form}
                homeCurrency={homeCurrency}
                supportedCurrencies={supportedCurrencies}
              />
            </AccordionContent>
          </AccordionItem>
          {CATEGORY_KINDS.map((kind) => (
            <AccordionItem key={kind} value={kind}>
              <AccordionTrigger>{CATEGORY_KIND_LABELS[kind]}</AccordionTrigger>
              <AccordionContent>
                {kind === "option" && (
                  <p className="mb-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-100">
                    Options aren't fully implemented yet — stock-option metadata
                    (units, strike, vested) is stored on the server but the
                    editor here only lets you record raw monetary amounts.
                  </p>
                )}
                <LineItemsSection
                  form={form}
                  kind={kind}
                  categories={categories}
                  homeCurrency={homeCurrency}
                />
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" disabled={loading}>
            {mode.kind === "edit" ? "Save changes" : "Save entry"}
          </Button>
        </div>
      </form>
    </>
  );
}

/** Shape of the form state used by `EntryForm` and its section components. */
type EntryFormValues = {
  date: string;
  rates: RateItem[];
  items: LineItem[];
};

/** TanStack Form's `useForm` returns a `ReactFormExtendedApi` whose validator generics default (when no validator is passed at the call site) to the full `FormValidateOrFn<T> | undefined` / `FormAsyncValidateOrFn<T> | undefined` unions — narrowing them to plain `undefined` would be incompatible with what `useForm(...)` actually returns, so we match those defaults here. */
type _ValidatorSync = FormValidateOrFn<EntryFormValues> | undefined;
type _ValidatorAsync = FormAsyncValidateOrFn<EntryFormValues> | undefined;
type EntryFormApi = ReactFormExtendedApi<
  EntryFormValues,
  _ValidatorSync,
  _ValidatorSync,
  _ValidatorAsync,
  _ValidatorSync,
  _ValidatorAsync,
  _ValidatorSync,
  _ValidatorAsync,
  _ValidatorSync,
  _ValidatorAsync,
  _ValidatorAsync,
  unknown
>;

function CurrenciesSection({
  form,
  homeCurrency,
  supportedCurrencies,
}: {
  form: EntryFormApi;
  homeCurrency: string;
  supportedCurrencies: { code: string; name: string }[];
}) {
  const [refreshing, setRefreshing] = useState(false);
  const [newCode, setNewCode] = useState("");

  return (
    <form.Field name="rates" mode="array">
      {(ratesField: {
        state: { value: RateItem[] };
        pushValue: (v: RateItem) => void;
        removeValue: (i: number) => void;
      }) => {
        const rates = ratesField.state.value;
        const refresh = async () => {
          if (rates.length === 0) return;
          setRefreshing(true);
          try {
            const fresh = await fetchOpenExchangeRates(
              homeCurrency,
              rates.map((r) => r.currency),
            );
            rates.forEach((r, i) => {
              const v = fresh[r.currency];
              if (v != null) {
                form.setFieldValue(`rates[${i}].rate`, (1 / v).toPrecision(10));
              }
            });
            toast.success("Rates refreshed");
          } catch (err) {
            toast.error(err instanceof Error ? err.message : String(err));
          } finally {
            setRefreshing(false);
          }
        };
        const addCurrency = () => {
          if (!CURRENCY_CODE_PATTERN.test(newCode)) {
            toast.error("Pick a currency");
            return;
          }
          if (newCode === homeCurrency) {
            toast.error(
              `${homeCurrency} is the home currency — no rate needed`,
            );
            return;
          }
          if (rates.some((r) => r.currency === newCode)) {
            toast.error(`${newCode} is already in the list`);
            return;
          }
          ratesField.pushValue({ currency: newCode, rate: "" });
          setNewCode("");
        };

        const existing = new Set(rates.map((r) => r.currency));
        const options = supportedCurrencies.filter(
          (c) => c.code !== homeCurrency && !existing.has(c.code),
        );

        /** Line-item amounts that reference this currency — if any, removing the rate would orphan them, so block the delete. */
        const usageByCurrency = collectCurrencyUsage(
          form.state.values.items as LineItem[],
        );

        return (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Rates are expressed as units of {homeCurrency} per 1 of the
              currency.
            </p>
            <div className="space-y-2">
              {rates.map((r, i) => {
                const usage = usageByCurrency[r.currency] ?? 0;
                const inUse = usage > 0;
                const removeButton = (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove ${r.currency}`}
                    onClick={() => {
                      if (inUse) return;
                      ratesField.removeValue(i);
                    }}
                    disabled={inUse}
                  >
                    <X />
                  </Button>
                );
                return (
                  <div key={i} className="flex items-center gap-2">
                    <span className="w-16 font-mono text-sm">{r.currency}</span>
                    <form.Field name={`rates[${i}].rate`}>
                      {(field: {
                        state: { value: string };
                        handleChange: (v: string) => void;
                      }) => (
                        <Input
                          type="number"
                          step="0.000001"
                          inputMode="decimal"
                          placeholder="Rate"
                          className="w-40"
                          currency={homeCurrency}
                          value={field.state.value}
                          onChange={(e) => field.handleChange(e.target.value)}
                        />
                      )}
                    </form.Field>
                    {inUse ? (
                      <Tooltip>
                        {/* Wrap the disabled button in a span so the tooltip
                            still gets pointer events — `disabled` buttons
                            don't fire them themselves. */}
                        <TooltipTrigger asChild>
                          <span className="inline-flex">{removeButton}</span>
                        </TooltipTrigger>
                        <TooltipContent>
                          {r.currency} is in use by {usage} line-item amount
                          {usage === 1 ? "" : "s"}. Clear those before removing
                          the rate.
                        </TooltipContent>
                      </Tooltip>
                    ) : (
                      removeButton
                    )}
                  </div>
                );
              })}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Select value={newCode} onValueChange={setNewCode}>
                <SelectTrigger className="w-64">
                  <SelectValue placeholder="Pick a currency" />
                </SelectTrigger>
                <SelectContent>
                  {options.map((c) => (
                    <SelectItem key={c.code} value={c.code}>
                      {c.code} — {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addCurrency}
                disabled={!newCode}
              >
                <Plus /> Add currency
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void refresh()}
                disabled={refreshing || rates.length === 0}
                className="ml-auto"
              >
                <RefreshCw className={cn(refreshing && "animate-spin")} />
                {refreshing ? "Refreshing…" : "Refresh rates"}
              </Button>
            </div>
          </div>
        );
      }}
    </form.Field>
  );
}

function collectCurrencyUsage(items: LineItem[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    for (const a of item.amounts) {
      if (!a.currency || !a.amount) continue;
      out[a.currency] = (out[a.currency] ?? 0) + 1;
    }
  }
  return out;
}

function LineItemsSection({
  form,
  kind,
  categories,
  homeCurrency,
}: {
  form: EntryFormApi;
  kind: CategoryKind;
  categories: CategoryOption[];
  homeCurrency: string;
}) {
  const kindCategories = categories.filter((c) => c.kind === kind);

  return (
    <form.Field name="items" mode="array">
      {(itemsField: {
        state: { value: LineItem[] };
        pushValue: (v: LineItem) => void;
        removeValue: (i: number) => void;
      }) => {
        const allItems = itemsField.state.value;
        const myIndexes = allItems
          .map((item, idx) => (item.kind === kind ? idx : -1))
          .filter((idx) => idx !== -1);
        const takenIds = new Set(
          allItems
            .filter((item) => item.kind === kind && item.categoryId)
            .map((item) => item.categoryId),
        );
        const availableCategories = kindCategories.filter(
          (c) => !takenIds.has(c.id),
        );

        const subtypeOrder = subtypeOrderFor(kind);

        // Bucket item-indexes by subtype so asset/liability rows group by
        // type (CASH, STOCK, LOAN, …). Options have no subtype so we emit a
        // single flat list via the `null` bucket.
        const buckets = new Map<string | null, number[]>();
        for (const i of myIndexes) {
          const cat = kindCategories.find(
            (c) => c.id === allItems[i].categoryId,
          );
          const subtype = subtypeOrder ? (cat?.subtype ?? null) : null;
          const list = buckets.get(subtype) ?? [];
          list.push(i);
          buckets.set(subtype, list);
        }
        const orderedKeys: (string | null)[] = subtypeOrder
          ? subtypeOrder.filter((k) => buckets.has(k))
          : [null];
        // Rows whose category hasn't been picked yet land in a separate
        // "new" bucket under subtypeOrder so the user can pick.
        if (subtypeOrder && buckets.has(null)) orderedKeys.push(null);

        const renderLine = (i: number) => (
          <div key={i} className="rounded-md border bg-muted/30 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <form.Field name={`items[${i}].categoryId`}>
                {(field: {
                  state: { value: string };
                  handleChange: (v: string) => void;
                }) => {
                  if (field.state.value) {
                    const name =
                      kindCategories.find((c) => c.id === field.state.value)
                        ?.name ?? "(unknown)";
                    return <span className="text-sm font-medium">{name}</span>;
                  }
                  return (
                    <NativeSelect
                      className="w-64"
                      value={field.state.value}
                      onChange={(e) => field.handleChange(e.target.value)}
                    >
                      <option value="" disabled>
                        Pick a category
                      </option>
                      {availableCategories.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </NativeSelect>
                  );
                }}
              </form.Field>

              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="ml-auto"
                aria-label="Remove line"
                onClick={() => itemsField.removeValue(i)}
              >
                <X />
              </Button>
            </div>

            <AmountsSection
              form={form}
              itemIndex={i}
              homeCurrency={homeCurrency}
            />
          </div>
        );

        return (
          <div className="space-y-3">
            {myIndexes.length === 0 && (
              <p className="text-xs text-muted-foreground">
                No {CATEGORY_KIND_LABELS[kind].toLowerCase()} yet.
              </p>
            )}
            {!subtypeOrder ? (
              // Options has no subtype — render flat, no nested accordion.
              orderedKeys.map((subtype) => {
                const indexes = buckets.get(subtype) ?? [];
                if (indexes.length === 0) return null;
                return (
                  <div key="__flat__" className="space-y-2">
                    {indexes.map(renderLine)}
                  </div>
                );
              })
            ) : (
              <Accordion type="single" collapsible className="space-y-2">
                {orderedKeys.map((subtype) => {
                  const indexes = buckets.get(subtype) ?? [];
                  if (indexes.length === 0) return null;
                  const value = subtype ?? "__unpicked__";
                  const title =
                    subtype === null ? "New" : subtypeLabelFor(kind, subtype);
                  return (
                    <AccordionItem key={value} value={value}>
                      <AccordionTrigger>{title}</AccordionTrigger>
                      <AccordionContent>
                        <div className="space-y-2">
                          {indexes.map(renderLine)}
                        </div>
                      </AccordionContent>
                    </AccordionItem>
                  );
                })}
              </Accordion>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                itemsField.pushValue(blankLine(kind, homeCurrency))
              }
            >
              <Plus /> Add {kind}
            </Button>
          </div>
        );
      }}
    </form.Field>
  );
}

function AmountsSection({
  form,
  itemIndex,
  homeCurrency,
}: {
  form: EntryFormApi;
  itemIndex: number;
  homeCurrency: string;
}) {
  return (
    <form.Subscribe
      selector={(s: { values: { rates: RateItem[] } }) => s.values.rates}
    >
      {(rates: RateItem[]) => {
        const supportedCurrencies = [
          homeCurrency,
          ...rates
            .map((r) => r.currency)
            .filter((c) => c && c !== homeCurrency),
        ];
        return (
          <form.Field name={`items[${itemIndex}].amounts`} mode="array">
            {(amountsField: {
              state: { value: AmountItem[] };
              pushValue: (v: AmountItem) => void;
              removeValue: (i: number) => void;
            }) => (
              <div className="mt-3 space-y-2">
                {amountsField.state.value.map((_a, j) => (
                  <div key={j} className="flex items-center gap-2">
                    <form.Subscribe
                      selector={(s: {
                        values: { items: { amounts: AmountItem[] }[] };
                      }) => s.values.items[itemIndex]?.amounts[j]?.currency}
                    >
                      {(currencyCode: string | undefined) => (
                        <form.Field
                          name={`items[${itemIndex}].amounts[${j}].amount`}
                        >
                          {(field: {
                            state: { value: string };
                            handleChange: (v: string) => void;
                          }) => (
                            <Input
                              type="number"
                              step="0.01"
                              inputMode="decimal"
                              placeholder="Amount"
                              className="w-40"
                              currency={currencyCode}
                              value={field.state.value}
                              onChange={(e) =>
                                field.handleChange(e.target.value)
                              }
                            />
                          )}
                        </form.Field>
                      )}
                    </form.Subscribe>
                    <form.Field
                      name={`items[${itemIndex}].amounts[${j}].currency`}
                    >
                      {(field: {
                        state: { value: string };
                        handleChange: (v: string) => void;
                      }) => (
                        <NativeSelect
                          className="w-24"
                          value={field.state.value}
                          onChange={(e) => field.handleChange(e.target.value)}
                          disabled={supportedCurrencies.length === 1}
                        >
                          {supportedCurrencies.map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </NativeSelect>
                      )}
                    </form.Field>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="Remove amount"
                      onClick={() => amountsField.removeValue(j)}
                      disabled={amountsField.state.value.length === 1}
                    >
                      <X />
                    </Button>
                  </div>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    amountsField.pushValue({
                      amount: "",
                      currency: homeCurrency,
                    })
                  }
                >
                  <Plus /> Add currency
                </Button>
              </div>
            )}
          </form.Field>
        );
      }}
    </form.Subscribe>
  );
}

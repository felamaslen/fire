import type { InternalRefetchQueriesInclude } from "@apollo/client";
import { useMutation } from "@apollo/client/react";
import { useForm } from "@tanstack/react-form";
import { Plus, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import {
  graphql,
  type ResultOf,
  type VariablesOf,
} from "../../graphql";

export const NetWorthEntryFormDocument = graphql(`
  fragment NetWorthEntryForm on NetWorthEntry {
    id
    date
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
    netWorthCategories(first: 100) {
      edges {
        node {
          __typename
          ... on NetWorthCategoryAsset {
            id
            name
          }
          ... on NetWorthCategoryLiability {
            id
            name
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
  mutation NetWorthCreate($date: Date!, $values: [NetWorthValueInput!]!) {
    netWorthCreate(date: $date, values: $values) {
      id
    }
  }
`);

const NetWorthUpdateDocument = graphql(`
  mutation NetWorthUpdate(
    $id: ID!
    $date: Date
    $values: [NetWorthValueInput!]
  ) {
    netWorthUpdate(id: $id, date: $date, values: $values) {
      id
    }
  }
`);

export type EntryFormData = ResultOf<typeof NetWorthEntryFormDocument>;

type CategoryNode = NonNullable<
  ResultOf<typeof NetWorthEntryFormCategoriesDocument>["netWorthCategories"]
>["edges"][number]["node"];

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
  asset: "Asset",
  liability: "Liability",
  option: "Option",
} as const satisfies Record<CategoryKind, string>;

const CATEGORY_KINDS = Object.keys(CATEGORY_KIND_LABELS) as CategoryKind[];

export type CategoryOption = {
  kind: CategoryKind;
  id: string;
  name: string;
};

export function categoryOptions(nodes: CategoryNode[]): CategoryOption[] {
  const out: CategoryOption[] = [];
  for (const n of nodes) {
    if (n.__typename === "NetWorthCategoryAsset")
      out.push({ kind: "asset", id: n.id, name: n.name });
    else if (n.__typename === "NetWorthCategoryLiability")
      out.push({ kind: "liability", id: n.id, name: n.name });
    else if (n.__typename === "NetWorthCategoryOption")
      out.push({ kind: "option", id: n.id, name: n.name });
  }
  return out;
}

/** Three uppercase ASCII letters — the ISO-4217 shape. The server validates the specific code against its `CurrencyCode` enum; the UI just enforces the format so users can enter any supported currency without us maintaining a client-side list. */
const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;

export type EntryFormMode =
  | { kind: "new" }
  | { kind: "edit"; entryId: string };

type AmountItem = { amount: string; currency: string };
type LineItem = {
  /** Existing `NetWorthValue.id` when editing — included on update so the server upserts instead of recreating. */
  id: string | null;
  kind: CategoryKind | "";
  categoryId: string;
  amounts: AmountItem[];
};

function blankLine(): LineItem {
  return {
    id: null,
    kind: "",
    categoryId: "",
    amounts: [{ amount: "", currency: "GBP" }],
  };
}

function entryAsLineItems(entry: EntryFormData): LineItem[] {
  if (entry.values.length === 0) return [blankLine()];
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
      amounts: v.amounts.length
        ? v.amounts.map((a) => ({
            amount: String(a.amount),
            currency: a.currency,
          }))
        : [{ amount: "", currency: "GBP" }],
    };
  });
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

  const initial =
    mode.kind === "edit" && entry
      ? { date: entry.date, items: entryAsLineItems(entry) }
      : {
          date: new Date().toISOString().slice(0, 10),
          items: entry ? entryAsLineItems(entry) : [blankLine()],
        };
  // In new-mode we carry categories/amounts from the source entry but clear its
  // value ids — those rows need to be created, not upserted into the new entry.
  if (mode.kind === "new") {
    initial.items = initial.items.map((i) => ({ ...i, id: null }));
  }

  const form = useForm({
    defaultValues: initial,
    onSubmit: async ({ value }) => {
      const values = value.items
        .filter((i) => i.kind && i.categoryId)
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
      if (mode.kind === "edit") {
        await update({
          variables: { id: mode.entryId, date: value.date, values },
        }).catch((err: Error) => toast.error(err.message));
      } else {
        await create({
          variables: { date: value.date, values },
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

        <form.Field name="items" mode="array">
          {(itemsField) => (
            <div className="space-y-3">
              {itemsField.state.value.map((_, i) => (
                <div key={i} className="rounded-md border bg-muted/30 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <form.Field name={`items[${i}].kind`}>
                      {(field) => (
                        <Select
                          value={field.state.value || undefined}
                          onValueChange={(v) => {
                            field.handleChange(v as CategoryKind);
                            form.setFieldValue(`items[${i}].categoryId`, "");
                          }}
                        >
                          <SelectTrigger className="w-32">
                            <SelectValue placeholder="Kind" />
                          </SelectTrigger>
                          <SelectContent>
                            {CATEGORY_KINDS.map((k) => (
                              <SelectItem key={k} value={k}>
                                {CATEGORY_KIND_LABELS[k]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    </form.Field>

                    <form.Subscribe selector={(s) => s.values.items[i]?.kind}>
                      {(kind) => (
                        <form.Field name={`items[${i}].categoryId`}>
                          {(field) => (
                            <Select
                              value={field.state.value || undefined}
                              onValueChange={(v) => field.handleChange(v)}
                              disabled={!kind}
                            >
                              <SelectTrigger className="w-56">
                                <SelectValue
                                  placeholder={
                                    kind
                                      ? "Pick a category"
                                      : "Pick kind first"
                                  }
                                />
                              </SelectTrigger>
                              <SelectContent>
                                {categories
                                  .filter((c) => c.kind === kind)
                                  .map((c) => (
                                    <SelectItem key={c.id} value={c.id}>
                                      {c.name}
                                    </SelectItem>
                                  ))}
                              </SelectContent>
                            </Select>
                          )}
                        </form.Field>
                      )}
                    </form.Subscribe>

                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="ml-auto"
                      aria-label="Remove line"
                      onClick={() => itemsField.removeValue(i)}
                      disabled={itemsField.state.value.length === 1}
                    >
                      <X />
                    </Button>
                  </div>

                  <form.Field name={`items[${i}].amounts`} mode="array">
                    {(amountsField) => (
                      <div className="mt-3 space-y-2">
                        {amountsField.state.value.map((_a, j) => (
                          <div key={j} className="flex items-center gap-2">
                            <form.Field
                              name={`items[${i}].amounts[${j}].amount`}
                            >
                              {(field) => (
                                <Input
                                  type="number"
                                  step="0.01"
                                  inputMode="decimal"
                                  placeholder="Amount"
                                  className="w-40"
                                  value={field.state.value}
                                  onChange={(e) =>
                                    field.handleChange(e.target.value)
                                  }
                                />
                              )}
                            </form.Field>
                            <form.Field
                              name={`items[${i}].amounts[${j}].currency`}
                              validators={{
                                onChange: ({ value }) =>
                                  CURRENCY_CODE_PATTERN.test(value)
                                    ? undefined
                                    : "3 uppercase letters (e.g. GBP)",
                              }}
                            >
                              {(field) => (
                                <Input
                                  className="w-20 uppercase"
                                  maxLength={3}
                                  placeholder="GBP"
                                  aria-label="Currency"
                                  aria-invalid={
                                    field.state.meta.errors.length > 0
                                  }
                                  value={field.state.value}
                                  onChange={(e) =>
                                    field.handleChange(
                                      e.target.value.toUpperCase(),
                                    )
                                  }
                                />
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
                              currency: "GBP",
                            })
                          }
                        >
                          <Plus /> Add currency
                        </Button>
                      </div>
                    )}
                  </form.Field>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => itemsField.pushValue(blankLine())}
              >
                <Plus /> Add line
              </Button>
            </div>
          )}
        </form.Field>

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

import { useMutation, useSuspenseQuery } from "@apollo/client/react";
import { useForm } from "@tanstack/react-form";
import { createFileRoute } from "@tanstack/react-router";
import { Plus, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { DeleteButton } from "@/components/delete-button";
import { Figure, FigureDocument } from "@/components/figure";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import {
  type FragmentOf,
  graphql,
  readFragment,
  type ResultOf,
} from "../../graphql";

const NetWorthEntryRowDocument = graphql(
  `
    fragment NetWorthEntryRow on NetWorthEntry {
      id
      date
      totalNet {
        ...Figure
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
  `,
  [FigureDocument],
);

const NetWorthEntriesDocument = graphql(
  `
    query NetWorthEntries {
      netWorth(last: 11) {
        edges {
          node {
            id
            ...NetWorthEntryRow
          }
        }
      }
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
  `,
  [NetWorthEntryRowDocument],
);

const NetWorthCreateDocument = graphql(
  `
    mutation NetWorthCreate($date: Date!, $values: [NetWorthValueInput!]!) {
      netWorthCreate(date: $date, values: $values) {
        id
        ...NetWorthEntryRow
      }
    }
  `,
  [NetWorthEntryRowDocument],
);

const NetWorthDeleteDocument = graphql(`
  mutation NetWorthDelete($id: ID!) {
    netWorthDelete(id: $id) {
      _
    }
  }
`);

type EntryNode = NonNullable<
  ResultOf<typeof NetWorthEntriesDocument>["netWorth"]
>["edges"][number]["node"];
type CategoryNode = NonNullable<
  ResultOf<typeof NetWorthEntriesDocument>["netWorthCategories"]
>["edges"][number]["node"];

type CategoryKind = "asset" | "liability" | "option";

const CATEGORY_KIND_LABELS = {
  asset: "Asset",
  liability: "Liability",
  option: "Option",
} as const satisfies Record<CategoryKind, string>;

const CATEGORY_KINDS = Object.keys(CATEGORY_KIND_LABELS) as CategoryKind[];

type CategoryOption = { kind: CategoryKind; id: string; name: string };

function categoryOptions(nodes: CategoryNode[]): CategoryOption[] {
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

const CURRENCIES = ["GBP", "USD", "EUR", "CHF", "JPY"] as const;

export const Route = createFileRoute("/net-worth/entries")({
  component: NetWorthEntriesPage,
});

const refetch = [{ query: NetWorthEntriesDocument }];

function NetWorthEntriesPage() {
  const [isAdding, setIsAdding] = useState(false);
  const { data } = useSuspenseQuery(NetWorthEntriesDocument);

  const entries: EntryNode[] = data.netWorth?.edges.map((e) => e.node) ?? [];
  const categories = categoryOptions(
    data.netWorthCategories?.edges.map((e) => e.node) ?? [],
  );
  const latest = entries[0]
    ? readFragment(NetWorthEntryRowDocument, entries[0])
    : null;

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3">
      {entries.map((e) => (
        <EntryTile key={e.id} id={e.id} data={e} />
      ))}
      {isAdding ? (
        <AddEntryForm
          key={latest?.id ?? "empty"}
          categories={categories}
          latest={latest}
          onDone={() => setIsAdding(false)}
        />
      ) : (
        <AddEntryTile onClick={() => setIsAdding(true)} />
      )}
    </div>
  );
}

function AddEntryTile({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-32 cursor-pointer flex-col items-center justify-center gap-2 rounded-md border border-dashed bg-background p-4 text-muted-foreground transition-colors hover:border-foreground hover:text-foreground"
    >
      <Plus className="h-5 w-5" />
      <span className="text-sm font-medium">Add entry</span>
    </button>
  );
}

function EntryTile({
  id,
  data,
}: {
  id: string;
  data: FragmentOf<typeof NetWorthEntryRowDocument>;
}) {
  const entry = readFragment(NetWorthEntryRowDocument, data);
  const [remove] = useMutation(NetWorthDeleteDocument, {
    refetchQueries: refetch,
    onCompleted: () => toast.success("Entry deleted"),
  });

  return (
    <div className="flex min-h-32 flex-col gap-2 rounded-md border bg-card p-3">
      <div className="flex items-center gap-2">
        <span className="font-medium">{formatDate(entry.date)}</span>
        <span className="ml-auto">
          <DeleteButton
            onConfirm={() =>
              remove({ variables: { id } }).catch((err: Error) =>
                toast.error(err.message),
              )
            }
          />
        </span>
      </div>
      <Figure
        data={entry.totalNet}
        className="text-2xl font-semibold tabular-nums"
      />
      <div className="text-xs text-muted-foreground">
        {entry.values.length} line{entry.values.length === 1 ? "" : "s"}
      </div>
    </div>
  );
}

type AmountItem = { amount: string; currency: string };
type LineItem = {
  kind: CategoryKind | "";
  categoryId: string;
  amounts: AmountItem[];
};

function latestAsLineItems(
  latest: ResultOf<typeof NetWorthEntryRowDocument> | null,
): LineItem[] {
  if (!latest || latest.values.length === 0) {
    return [
      { kind: "", categoryId: "", amounts: [{ amount: "", currency: "GBP" }] },
    ];
  }
  return latest.values.map((v) => {
    const kind: CategoryKind = v.asset
      ? "asset"
      : v.liability
        ? "liability"
        : "option";
    const category = v.asset ?? v.liability ?? v.option;
    return {
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

function AddEntryForm({
  categories,
  latest,
  onDone,
}: {
  categories: CategoryOption[];
  latest: ResultOf<typeof NetWorthEntryRowDocument> | null;
  onDone: () => void;
}) {
  const [create, { loading }] = useMutation(NetWorthCreateDocument, {
    refetchQueries: refetch,
    onCompleted: () => {
      toast.success("Entry added");
      onDone();
    },
  });

  const form = useForm({
    defaultValues: {
      date: new Date().toISOString().slice(0, 10),
      items: latestAsLineItems(latest),
    },
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
          const entry = { categoryId: i.categoryId, amounts };
          return i.kind === "asset"
            ? { asset: entry }
            : i.kind === "liability"
              ? { liability: entry }
              : { option: entry };
        })
        .filter((v): v is NonNullable<typeof v> => v !== null);
      if (values.length === 0) {
        toast.error("Add at least one line item with an amount");
        return;
      }
      await create({
        variables: { date: value.date, values },
      }).catch((err: Error) => toast.error(err.message));
    },
  });

  return (
    <Card className="col-span-full">
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle>Add entry</CardTitle>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Cancel"
          onClick={onDone}
        >
          <X />
        </Button>
      </CardHeader>
      <CardContent>
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
                              >
                                {(field) => (
                                  <Select
                                    value={field.state.value}
                                    onValueChange={(v) => field.handleChange(v)}
                                  >
                                    <SelectTrigger className="w-24">
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      {CURRENCIES.map((c) => (
                                        <SelectItem key={c} value={c}>
                                          {c}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
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
                  onClick={() =>
                    itemsField.pushValue({
                      kind: "",
                      categoryId: "",
                      amounts: [{ amount: "", currency: "GBP" }],
                    })
                  }
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
              Save entry
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function formatDate(d: string): string {
  return new Date(d).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
  });
}

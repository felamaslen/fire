import { useMutation, useSuspenseQuery } from "@apollo/client/react";
import { useForm } from "@tanstack/react-form";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { graphql, type ResultOf } from "../../graphql";

export const InvestmentFormDocument = graphql(`
  fragment InvestmentForm on Investment {
    id
    name
    currency
    asset {
      __typename
      ... on InvestmentStock {
        code
      }
      ... on InvestmentFund {
        url
      }
    }
  }
`);

const InvestmentFormDataDocument = graphql(`
  query InvestmentFormData {
    currencyDefault
    netWorthCategories(
      first: 200
      filterKindIn: [ASSET]
      filterTypeIn: [STOCK, PENSION]
    ) {
      edges {
        node {
          ... on NetWorthCategoryAsset {
            __typename
            id
            name
            type
          }
        }
      }
    }
  }
`);

export const InvestmentCreateDocument = graphql(`
  mutation InvestmentCreate(
    $name: String!
    $currency: String!
    $asset: InvestmentAssetInput!
    $transactions: [InvestmentInitialTransactionInput!]
  ) {
    investmentCreate(
      name: $name
      currency: $currency
      asset: $asset
      transactions: $transactions
    ) {
      id
    }
  }
`);

export const InvestmentUpdateDocument = graphql(
  `
    mutation InvestmentUpdate(
      $id: ID!
      $name: String
      $asset: InvestmentAssetInput
    ) {
      investmentUpdate(id: $id, name: $name, asset: $asset) {
        id
        ...InvestmentForm
      }
    }
  `,
  [InvestmentFormDocument],
);

const InvestmentDeleteDocument = graphql(`
  mutation InvestmentDelete($id: ID!) {
    investmentDelete(id: $id) {
      _
    }
  }
`);

type FormValues = {
  name: string;
  currency: string;
  kind: "stock" | "fund";
  stockCode: string;
  fundUrl: string;
  addInitialTx: boolean;
  txAssetId: string;
  txDate: string;
  txUnits: number;
  txPriceAmount: number;
  txTaxesAmount: number;
  txFeesAmount: number;
};

function initialFromExisting(
  existing: ResultOf<typeof InvestmentFormDocument> | null,
  homeCurrency: string,
): FormValues {
  const base = {
    addInitialTx: false,
    txAssetId: "",
    txDate: new Date().toISOString().slice(0, 10),
    txUnits: 0,
    txPriceAmount: 0,
    txTaxesAmount: 0,
    txFeesAmount: 0,
  };
  if (!existing) {
    return {
      name: "",
      currency: homeCurrency,
      kind: "stock",
      stockCode: "",
      fundUrl: "",
      ...base,
    };
  }
  const asset = existing.asset;
  return {
    name: existing.name,
    currency: existing.currency,
    kind: asset.__typename === "InvestmentStock" ? "stock" : "fund",
    stockCode: asset.__typename === "InvestmentStock" ? asset.code : "",
    fundUrl: asset.__typename === "InvestmentFund" ? asset.url : "",
    ...base,
  };
}

export function InvestmentForm({
  existing,
  onDone,
  onCancel,
  onDeleted,
  refetchQueries,
}: {
  existing?: ResultOf<typeof InvestmentFormDocument> | null;
  onDone: () => void;
  /** Optional cancel handler — when `null`, the Cancel button is hidden (e.g. when the form is embedded rather than a modal). */
  onCancel?: (() => void) | null;
  /** Edit-only — when set on an `existing` form, a Delete button is shown that calls `investmentDelete` and then this callback. */
  onDeleted?: () => void;
  refetchQueries: string[];
}) {
  const { data: formData } = useSuspenseQuery(InvestmentFormDataDocument);
  const homeCurrency = formData.currencyDefault ?? "GBP";
  const wrappers = (formData.netWorthCategories?.edges ?? []).flatMap((e) => {
    const n = e.node;
    return n.__typename === "NetWorthCategoryAsset" &&
      (n.type === "STOCK" || n.type === "PENSION")
      ? [{ id: n.id, name: n.name, type: n.type }]
      : [];
  });

  const [createFn] = useMutation(InvestmentCreateDocument, {
    refetchQueries,
    awaitRefetchQueries: true,
  });
  const [updateFn] = useMutation(InvestmentUpdateDocument);
  const [deleteFn, { loading: deleting }] = useMutation(
    InvestmentDeleteDocument,
    {
      refetchQueries,
      awaitRefetchQueries: true,
    },
  );
  const form = useForm({
    defaultValues: initialFromExisting(existing ?? null, homeCurrency),
    onSubmit: async ({ value }) => {
      const asset =
        value.kind === "stock"
          ? { stock: { code: value.stockCode.trim() } }
          : { fund: { url: value.fundUrl.trim() } };
      try {
        if (existing) {
          await updateFn({
            variables: { id: existing.id, name: value.name, asset },
          });
          toast.success("Investment updated");
        } else {
          if (value.addInitialTx) {
            if (!value.txAssetId) {
              toast.error("Pick a portfolio for the initial transaction");
              return;
            }
            if (!Number.isFinite(value.txUnits) || value.txUnits === 0) {
              toast.error("Enter a non-zero unit count");
              return;
            }
          }
          await createFn({
            variables: {
              name: value.name,
              currency: value.currency,
              asset,
              transactions: value.addInitialTx
                ? [
                    {
                      assetId: value.txAssetId,
                      date: value.txDate,
                      units: value.txUnits,
                      price: {
                        amount: Number(value.txPriceAmount),
                        currency: value.currency,
                      },
                      taxes: {
                        amount: Number(value.txTaxesAmount),
                        currency: value.currency,
                      },
                      fees: {
                        amount: Number(value.txFeesAmount),
                        currency: value.currency,
                      },
                    },
                  ]
                : null,
            },
          });
          toast.success(
            value.addInitialTx
              ? "Investment and transaction created"
              : "Investment created",
          );
        }
        onDone();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    },
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void form.handleSubmit();
      }}
      className="space-y-4"
    >
      <form.Field name="name">
        {(field) => (
          <div className="space-y-1">
            <Label htmlFor={field.name}>Name</Label>
            <Input
              id={field.name}
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              required
            />
          </div>
        )}
      </form.Field>

      {!existing && (
        <div className="space-y-1">
          <Label htmlFor="currency">Currency</Label>
          <Input id="currency" value={homeCurrency} disabled />
        </div>
      )}

      <form.Field name="kind">
        {(field) => (
          <div className="space-y-1">
            <Label>Type</Label>
            <div className="flex gap-2">
              <Button
                type="button"
                variant={field.state.value === "stock" ? "default" : "outline"}
                onClick={() => field.handleChange("stock")}
              >
                Stock
              </Button>
              <Button
                type="button"
                variant={field.state.value === "fund" ? "default" : "outline"}
                onClick={() => field.handleChange("fund")}
              >
                Fund
              </Button>
            </div>
          </div>
        )}
      </form.Field>

      <form.Subscribe selector={(s) => s.values.kind}>
        {(kind) =>
          kind === "stock" ? (
            <form.Field name="stockCode">
              {(field) => (
                <div className="space-y-1">
                  <Label htmlFor={field.name}>Ticker</Label>
                  <Input
                    id={field.name}
                    placeholder="e.g. AAPL or SMT.L"
                    value={field.state.value}
                    onChange={(e) => field.handleChange(e.target.value)}
                    required
                  />
                </div>
              )}
            </form.Field>
          ) : (
            <form.Field name="fundUrl">
              {(field) => (
                <div className="space-y-1">
                  <Label htmlFor={field.name}>Fund page URL</Label>
                  <Input
                    id={field.name}
                    type="url"
                    placeholder="https://..."
                    value={field.state.value}
                    onChange={(e) => field.handleChange(e.target.value)}
                    required
                  />
                </div>
              )}
            </form.Field>
          )
        }
      </form.Subscribe>

      {!existing && (
        <div className="space-y-3 rounded border p-3">
          <form.Field name="addInitialTx">
            {(field) => (
              <label className="flex items-center gap-2">
                <Checkbox
                  checked={field.state.value}
                  onCheckedChange={(v) => field.handleChange(v === true)}
                />
                <span className="text-sm font-medium">
                  Add an initial transaction
                </span>
              </label>
            )}
          </form.Field>
          <form.Subscribe selector={(s) => s.values.addInitialTx}>
            {(enabled) =>
              enabled && (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <form.Field name="txAssetId">
                    {(field) => (
                      <div className="space-y-1 sm:col-span-2">
                        <Label>Portfolio</Label>
                        <Select
                          value={field.state.value}
                          onValueChange={(v) => field.handleChange(v)}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Pick portfolio" />
                          </SelectTrigger>
                          <SelectContent>
                            {wrappers.map((w) => (
                              <SelectItem key={w.id} value={w.id}>
                                {w.name} ({w.type})
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                  </form.Field>
                  <form.Field name="txDate">
                    {(field) => (
                      <div className="space-y-1">
                        <Label>Date</Label>
                        <Input
                          type="date"
                          value={field.state.value}
                          onChange={(e) => field.handleChange(e.target.value)}
                        />
                      </div>
                    )}
                  </form.Field>
                  <form.Field name="txUnits">
                    {(field) => (
                      <div className="space-y-1">
                        <Label>Units (sell = negative)</Label>
                        <Input
                          type="number"
                          step="any"
                          value={field.state.value}
                          onChange={(e) =>
                            field.handleChange(Number(e.target.value))
                          }
                        />
                      </div>
                    )}
                  </form.Field>
                  <form.Field name="txPriceAmount">
                    {(field) => (
                      <div className="space-y-1 sm:col-span-2">
                        <Label>Unit price</Label>
                        <Input
                          type="number"
                          step="any"
                          currency={homeCurrency}
                          value={field.state.value}
                          onChange={(e) =>
                            field.handleChange(Number(e.target.value))
                          }
                        />
                      </div>
                    )}
                  </form.Field>
                  <form.Field name="txTaxesAmount">
                    {(field) => (
                      <div className="space-y-1">
                        <Label>Taxes</Label>
                        <Input
                          type="number"
                          step="any"
                          currency={homeCurrency}
                          value={field.state.value}
                          onChange={(e) =>
                            field.handleChange(Number(e.target.value))
                          }
                        />
                      </div>
                    )}
                  </form.Field>
                  <form.Field name="txFeesAmount">
                    {(field) => (
                      <div className="space-y-1">
                        <Label>Fees</Label>
                        <Input
                          type="number"
                          step="any"
                          currency={homeCurrency}
                          value={field.state.value}
                          onChange={(e) =>
                            field.handleChange(Number(e.target.value))
                          }
                        />
                      </div>
                    )}
                  </form.Field>
                </div>
              )
            }
          </form.Subscribe>
        </div>
      )}

      <div className="flex items-center justify-end gap-2">
        {existing && onDeleted && (
          <Button
            type="button"
            variant="ghost"
            disabled={deleting}
            className="mr-auto text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={() => {
              if (
                !window.confirm(
                  `Delete "${existing.name}" and all its transactions, splits, and prices? This cannot be undone.`,
                )
              )
                return;
              void (async () => {
                try {
                  await deleteFn({ variables: { id: existing.id } });
                  toast.success("Investment deleted");
                  onDeleted();
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : String(err));
                }
              })();
            }}
          >
            <Trash2 className="h-4 w-4" />
            Delete
          </Button>
        )}
        {onCancel !== null && (
          <Button type="button" variant="outline" onClick={onCancel ?? onDone}>
            Cancel
          </Button>
        )}
        <form.Subscribe selector={(s) => s.isSubmitting}>
          {(submitting) => (
            <Button type="submit" disabled={submitting}>
              {existing ? "Save" : "Create"}
            </Button>
          )}
        </form.Subscribe>
      </div>
    </form>
  );
}

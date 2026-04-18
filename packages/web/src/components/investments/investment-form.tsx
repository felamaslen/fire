import { useMutation } from "@apollo/client/react";
import { useForm } from "@tanstack/react-form";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
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

export const InvestmentCurrenciesDocument = graphql(`
  query InvestmentCurrencies {
    currencies {
      code
    }
  }
`);

export const InvestmentCreateDocument = graphql(`
  mutation InvestmentCreate(
    $name: String!
    $currency: String!
    $asset: InvestmentAssetInput!
  ) {
    investmentCreate(name: $name, currency: $currency, asset: $asset) {
      id
    }
  }
`);

export const InvestmentUpdateDocument = graphql(`
  mutation InvestmentUpdate(
    $id: ID!
    $name: String
    $asset: InvestmentAssetInput
  ) {
    investmentUpdate(id: $id, name: $name, asset: $asset) {
      id
    }
  }
`);

type FormValues = {
  name: string;
  currency: string;
  kind: "stock" | "fund";
  stockCode: string;
  fundUrl: string;
};

function initialFromExisting(
  existing: ResultOf<typeof InvestmentFormDocument> | null,
): FormValues {
  if (!existing) {
    return {
      name: "",
      currency: "GBP",
      kind: "stock",
      stockCode: "",
      fundUrl: "",
    };
  }
  const asset = existing.asset;
  return {
    name: existing.name,
    currency: existing.currency,
    kind: asset.__typename === "InvestmentStock" ? "stock" : "fund",
    stockCode: asset.__typename === "InvestmentStock" ? asset.code : "",
    fundUrl: asset.__typename === "InvestmentFund" ? asset.url : "",
  };
}

export function InvestmentForm({
  existing,
  onDone,
  refetchQueries,
}: {
  existing?: ResultOf<typeof InvestmentFormDocument> | null;
  onDone: () => void;
  refetchQueries: unknown;
}) {
  const [currencies] = useState<string[]>([
    "GBP",
    "USD",
    "EUR",
    "CHF",
    "JPY",
    "AUD",
    "CAD",
  ]);

  const [createFn] = useMutation(InvestmentCreateDocument, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    refetchQueries: refetchQueries as any,
    awaitRefetchQueries: true,
  });
  const [updateFn] = useMutation(InvestmentUpdateDocument, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    refetchQueries: refetchQueries as any,
    awaitRefetchQueries: true,
  });

  const form = useForm({
    defaultValues: initialFromExisting(existing ?? null),
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
          await createFn({
            variables: {
              name: value.name,
              currency: value.currency,
              asset,
            },
          });
          toast.success("Investment created");
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
        <form.Field name="currency">
          {(field) => (
            <div className="space-y-1">
              <Label htmlFor={field.name}>Currency</Label>
              <Select
                value={field.state.value}
                onValueChange={(v) => field.handleChange(v)}
              >
                <SelectTrigger id={field.name}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {currencies.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </form.Field>
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

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
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

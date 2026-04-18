import { useMutation, useSuspenseQuery } from "@apollo/client/react";
import { useForm } from "@tanstack/react-form";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { Suspense, useState } from "react";
import { toast } from "sonner";

import { DeleteButton } from "@/components/delete-button";
import { Figure, FigureDocument } from "@/components/figure";
import { Spinner } from "@/components/spinner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { graphql, type ResultOf } from "@/graphql";

import { InvestmentsPageDocument } from "../investments";

const InvestmentDetailDocument = graphql(
  `
    query InvestmentDetail($txFirst: Int, $txAfter: ID) {
      investment: investments {
        edges {
          node {
            id
            name
            currency
            asset {
              ... on InvestmentStock {
                __typename
                code
              }
              ... on InvestmentFund {
                __typename
                url
              }
            }
            transactionsPaged(first: $txFirst, after: $txAfter) {
              edges {
                cursor
                node {
                  id
                  date
                  units
                  drip
                  price { ...Figure }
                  taxes { ...Figure }
                  fees { ...Figure }
                  asset { id name }
                }
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
            position {
              units
              costBasis { ...Figure }
              totalValue { ...Figure }
              totalGain { ...Figure }
              percentGain
            }
          }
        }
      }
      stockPensionAssets: netWorthCategories(first: 100) {
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
  `,
  [FigureDocument],
);

const InvestmentTransactionCreateDocument = graphql(`
  mutation InvestmentTransactionCreate(
    $investmentId: ID!
    $assetId: ID!
    $date: Date!
    $units: Int!
    $price: MoneyInput!
    $taxes: MoneyInput
    $fees: MoneyInput
    $drip: Boolean
  ) {
    investmentTransactionCreate(
      investmentId: $investmentId
      assetId: $assetId
      date: $date
      units: $units
      price: $price
      taxes: $taxes
      fees: $fees
      drip: $drip
    ) {
      id
    }
  }
`);

const InvestmentTransactionDeleteDocument = graphql(`
  mutation InvestmentTransactionDelete($id: ID!) {
    investmentTransactionDelete(id: $id) {
      _
    }
  }
`);

export const Route = createFileRoute("/investments/$id")({
  component: InvestmentDetailPage,
});

function InvestmentDetailPage() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) void navigate({ to: "/investments" });
      }}
    >
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Investment</DialogTitle>
          <DialogDescription className="sr-only">
            Transaction history and stats for this investment.
          </DialogDescription>
        </DialogHeader>
        <Suspense fallback={<Spinner />}>
          <InvestmentDetail id={id} />
        </Suspense>
      </DialogContent>
    </Dialog>
  );
}

type AssetEdge = NonNullable<
  ResultOf<typeof InvestmentDetailDocument>["stockPensionAssets"]
>["edges"][number];

function InvestmentDetail({ id }: { id: string }) {
  const { data, refetch, fetchMore } = useSuspenseQuery(
    InvestmentDetailDocument,
    { variables: { txFirst: 15, txAfter: null } },
  );
  const investment = data.investment?.edges
    .map((e) => e.node)
    .find((n) => n.id === id);

  if (!investment) {
    return <p className="text-sm text-muted-foreground">Investment not found.</p>;
  }

  const wrappers = (data.stockPensionAssets?.edges ?? [])
    .map((e: AssetEdge) => e.node)
    .flatMap((n) =>
      n.__typename === "NetWorthCategoryAsset" &&
      (n.type === "STOCK" || n.type === "PENSION")
        ? [{ id: n.id, name: n.name, type: n.type }]
        : [],
    );

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h2 className="text-xl font-semibold">{investment.name}</h2>
        <p className="text-xs text-muted-foreground">
          {investment.asset.__typename === "InvestmentStock"
            ? investment.asset.code
            : investment.asset.__typename === "InvestmentFund"
              ? investment.asset.url
              : ""}{" "}
          · {investment.currency}
        </p>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
          <Stat
            label="Units"
            value={investment.position.units.toString()}
          />
          <Stat
            label="Cost basis"
            value={
              investment.position.costBasis ? (
                <Figure data={investment.position.costBasis} />
              ) : (
                "—"
              )
            }
          />
          <Stat
            label="Value"
            value={
              investment.position.totalValue ? (
                <Figure data={investment.position.totalValue} />
              ) : (
                "—"
              )
            }
          />
          <Stat
            label="Gain"
            value={
              investment.position.totalGain ? (
                <Figure data={investment.position.totalGain} />
              ) : (
                "—"
              )
            }
          />
        </dl>
      </header>

      <TransactionsSection
        investmentId={investment.id}
        currency={investment.currency}
        transactions={investment.transactionsPaged?.edges.map((e) => e.node) ?? []}
        hasNextPage={investment.transactionsPaged?.pageInfo.hasNextPage ?? false}
        endCursor={investment.transactionsPaged?.pageInfo.endCursor ?? null}
        wrappers={wrappers}
        onMutate={() => void refetch()}
        onLoadMore={() =>
          void fetchMore({
            variables: {
              txFirst: 15,
              txAfter: investment.transactionsPaged?.pageInfo.endCursor,
            },
          })
        }
      />
    </div>
  );
}

type TransactionRow = NonNullable<
  NonNullable<
    ResultOf<typeof InvestmentDetailDocument>["investment"]
  >["edges"][number]["node"]["transactionsPaged"]
>["edges"][number]["node"];

function TransactionsSection({
  investmentId,
  currency,
  transactions,
  wrappers,
  hasNextPage,
  endCursor,
  onMutate,
  onLoadMore,
}: {
  investmentId: string;
  currency: string;
  transactions: TransactionRow[];
  wrappers: { id: string; name: string; type: string }[];
  hasNextPage: boolean;
  endCursor: string | null;
  onMutate: () => void;
  onLoadMore: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [deleteTx] = useMutation(InvestmentTransactionDeleteDocument, {
    refetchQueries: [
      { query: InvestmentDetailDocument, variables: { txFirst: 15, txAfter: null } },
      { query: InvestmentsPageDocument, variables: { first: 100 } },
    ],
    onCompleted: () => toast.success("Transaction removed"),
    onError: (err) => toast.error(err.message),
  });

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Transactions</h3>
        <Button size="sm" onClick={() => setAdding(true)}>
          <Plus className="mr-1 h-4 w-4" /> Add
        </Button>
      </div>

      {adding && (
        <AddTransactionForm
          investmentId={investmentId}
          currency={currency}
          wrappers={wrappers}
          defaultAssetId={transactions[0]?.asset.id ?? wrappers[0]?.id ?? ""}
          onDone={() => {
            setAdding(false);
            onMutate();
          }}
          onCancel={() => setAdding(false)}
        />
      )}

      {transactions.length === 0 ? (
        <p className="text-sm text-muted-foreground">No transactions yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Wrapper</TableHead>
              <TableHead className="text-right">Units</TableHead>
              <TableHead className="text-right">Price</TableHead>
              <TableHead>DRIP</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {transactions.map((t) => (
              <TableRow key={t.id}>
                <TableCell>{t.date}</TableCell>
                <TableCell>{t.asset.name}</TableCell>
                <TableCell className="text-right tabular-nums">{t.units}</TableCell>
                <TableCell className="text-right">
                  <Figure data={t.price} />
                </TableCell>
                <TableCell>{t.drip ? "Yes" : ""}</TableCell>
                <TableCell className="w-0">
                  <DeleteButton
                    onConfirm={() => deleteTx({ variables: { id: t.id } })}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {hasNextPage && endCursor && (
        <div className="flex justify-center">
          <Button size="sm" variant="outline" onClick={onLoadMore}>
            Load more
          </Button>
        </div>
      )}
    </section>
  );
}

function AddTransactionForm({
  investmentId,
  currency,
  wrappers,
  defaultAssetId,
  onDone,
  onCancel,
}: {
  investmentId: string;
  currency: string;
  wrappers: { id: string; name: string; type: string }[];
  defaultAssetId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [createTx] = useMutation(InvestmentTransactionCreateDocument, {
    refetchQueries: [
      { query: InvestmentDetailDocument, variables: { txFirst: 15, txAfter: null } },
      { query: InvestmentsPageDocument, variables: { first: 100 } },
    ],
    awaitRefetchQueries: true,
  });

  const form = useForm({
    defaultValues: {
      assetId: defaultAssetId,
      date: new Date().toISOString().slice(0, 10),
      units: 0,
      priceAmount: 0,
      taxesAmount: 0,
      feesAmount: 0,
      drip: false,
    },
    onSubmit: async ({ value }) => {
      if (!value.assetId) {
        toast.error("Pick a wrapper");
        return;
      }
      try {
        await createTx({
          variables: {
            investmentId,
            assetId: value.assetId,
            date: value.date,
            units: Math.trunc(value.units),
            price: { amount: Number(value.priceAmount), currency },
            taxes: { amount: Number(value.taxesAmount), currency },
            fees: { amount: Number(value.feesAmount), currency },
            drip: value.drip,
          },
        });
        toast.success("Transaction added");
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
      className="grid grid-cols-2 gap-3 rounded border p-3 sm:grid-cols-4"
    >
      <form.Field name="assetId">
        {(field) => (
          <div className="space-y-1 sm:col-span-2">
            <Label>Wrapper</Label>
            <Select
              value={field.state.value}
              onValueChange={(v) => field.handleChange(v)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Pick wrapper" />
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
      <form.Field name="date">
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
      <form.Field name="units">
        {(field) => (
          <div className="space-y-1">
            <Label>Units (sell = negative)</Label>
            <Input
              type="number"
              step="1"
              value={field.state.value}
              onChange={(e) => field.handleChange(Number(e.target.value))}
            />
          </div>
        )}
      </form.Field>
      <form.Field name="priceAmount">
        {(field) => (
          <div className="space-y-1">
            <Label>Unit price</Label>
            <Input
              type="number"
              step="any"
              currency={currency}
              value={field.state.value}
              onChange={(e) => field.handleChange(Number(e.target.value))}
            />
          </div>
        )}
      </form.Field>
      <form.Field name="taxesAmount">
        {(field) => (
          <div className="space-y-1">
            <Label>Taxes</Label>
            <Input
              type="number"
              step="any"
              currency={currency}
              value={field.state.value}
              onChange={(e) => field.handleChange(Number(e.target.value))}
            />
          </div>
        )}
      </form.Field>
      <form.Field name="feesAmount">
        {(field) => (
          <div className="space-y-1">
            <Label>Fees</Label>
            <Input
              type="number"
              step="any"
              currency={currency}
              value={field.state.value}
              onChange={(e) => field.handleChange(Number(e.target.value))}
            />
          </div>
        )}
      </form.Field>
      <form.Field name="drip">
        {(field) => (
          <label className="flex items-center gap-2 sm:col-span-2">
            <Checkbox
              checked={field.state.value}
              onCheckedChange={(v) => field.handleChange(v === true)}
            />
            <span className="text-sm">Dividend reinvestment</span>
          </label>
        )}
      </form.Field>
      <div className="col-span-full flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <form.Subscribe selector={(s) => s.isSubmitting}>
          {(submitting) => (
            <Button type="submit" disabled={submitting}>
              Add
            </Button>
          )}
        </form.Subscribe>
      </div>
    </form>
  );
}

function Stat({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}

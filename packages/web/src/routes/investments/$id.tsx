import { useMutation, useSuspenseQuery } from "@apollo/client/react";
import { useForm } from "@tanstack/react-form";
import {
  createFileRoute,
  useNavigate,
  useSearch,
} from "@tanstack/react-router";
import { Pencil, Plus } from "lucide-react";
import { Suspense, useState } from "react";
import { toast } from "sonner";

import { DeleteButton } from "@/components/delete-button";
import { Figure, FigureDocument } from "@/components/figure";
import {
  InvestmentForm,
  InvestmentFormDocument,
} from "@/components/investments/investment-form";
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { graphql, type ResultOf } from "@/graphql";

import { InvestmentsListDocument } from "../investments";

const InvestmentDetailDocument = graphql(
  `
    query InvestmentDetail {
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
            position {
              units
              costBasis {
                ...Figure
              }
              totalValue {
                ...Figure
              }
              totalGain {
                ...Figure
              }
              percentGain
            }
            ...InvestmentForm
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
  [FigureDocument, InvestmentFormDocument],
);

const InvestmentStockSplitsDocument = graphql(`
  query InvestmentStockSplits {
    investment: investments {
      edges {
        node {
          id
          stockSplits {
            id
            date
            ratio
          }
        }
      }
    }
  }
`);

const InvestmentStockSplitCreateDocument = graphql(`
  mutation InvestmentStockSplitCreate(
    $investmentId: ID!
    $date: Date!
    $ratio: Float!
  ) {
    investmentStockSplitCreate(
      investmentId: $investmentId
      date: $date
      ratio: $ratio
    ) {
      id
    }
  }
`);

const InvestmentStockSplitUpdateDocument = graphql(`
  mutation InvestmentStockSplitUpdate($id: ID!, $date: Date, $ratio: Float) {
    investmentStockSplitUpdate(id: $id, date: $date, ratio: $ratio) {
      id
    }
  }
`);

const InvestmentStockSplitDeleteDocument = graphql(`
  mutation InvestmentStockSplitDelete($id: ID!) {
    investmentStockSplitDelete(id: $id) {
      _
    }
  }
`);

const InvestmentTransactionsDocument = graphql(
  `
    query InvestmentTransactions(
      $txFirst: Int
      $txAfter: ID
      $filterAssetId: ID
    ) {
      investment: investments(filterAssetId: $filterAssetId) {
        edges {
          node {
            id
            transactionsPaged(
              first: $txFirst
              after: $txAfter
              filterAssetId: $filterAssetId
            ) {
              edges {
                cursor
                node {
                  id
                  date
                  units
                  drip
                  price {
                    amount
                    ...Figure
                  }
                  taxes {
                    amount
                    ...Figure
                  }
                  fees {
                    amount
                    ...Figure
                  }
                  asset {
                    id
                    name
                  }
                }
              }
              pageInfo {
                hasNextPage
                endCursor
              }
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

const InvestmentTransactionUpdateDocument = graphql(`
  mutation InvestmentTransactionUpdate(
    $id: ID!
    $assetId: ID
    $date: Date
    $units: Int
    $price: MoneyInput
    $taxes: MoneyInput
    $fees: MoneyInput
    $drip: Boolean
  ) {
    investmentTransactionUpdate(
      id: $id
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
  const parentSearch = useSearch({ from: "/investments" });
  const filterAssetId = parentSearch["filter-wrapper-id"] ?? null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open)
          void navigate({ to: "/investments", search: (prev) => prev });
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
          <InvestmentDetail id={id} filterAssetId={filterAssetId} />
        </Suspense>
      </DialogContent>
    </Dialog>
  );
}

type AssetEdge = NonNullable<
  ResultOf<typeof InvestmentDetailDocument>["stockPensionAssets"]
>["edges"][number];

function InvestmentDetail({
  id,
  filterAssetId,
}: {
  id: string;
  filterAssetId: string | null;
}) {
  const { data } = useSuspenseQuery(InvestmentDetailDocument);
  const investment = data.investment?.edges
    .map((e) => e.node)
    .find((n) => n.id === id);

  if (!investment) {
    return (
      <p className="text-sm text-muted-foreground">Investment not found.</p>
    );
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
      <InvestmentForm
        existing={investment}
        onDone={() => {}}
        onCancel={null}
        refetchQueries={[{ query: InvestmentDetailDocument }]}
      />
      <header className="space-y-1">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
          <Stat label="Units" value={investment.position.units.toString()} />
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

      <DetailTabs
        investmentId={investment.id}
        currency={investment.currency}
        wrappers={wrappers}
        filterAssetId={filterAssetId}
      />
    </div>
  );
}

function DetailTabs({
  investmentId,
  currency,
  wrappers,
  filterAssetId,
}: {
  investmentId: string;
  currency: string;
  wrappers: { id: string; name: string; type: string }[];
  filterAssetId: string | null;
}) {
  const [tab, setTab] = useState<"transactions" | "splits">("transactions");
  return (
    <div className="space-y-3">
      <nav
        role="tablist"
        aria-label="Investment data"
        className="flex gap-1 border-b"
      >
        <TabButton
          active={tab === "transactions"}
          onClick={() => setTab("transactions")}
        >
          Transactions
        </TabButton>
        <TabButton active={tab === "splits"} onClick={() => setTab("splits")}>
          Stock splits
        </TabButton>
      </nav>
      <Suspense
        fallback={
          <div className="flex min-h-32 items-center justify-center">
            <Spinner />
          </div>
        }
      >
        {tab === "transactions" ? (
          <TransactionsSection
            investmentId={investmentId}
            currency={currency}
            wrappers={wrappers}
            filterAssetId={filterAssetId}
          />
        ) : (
          <StockSplitsSection investmentId={investmentId} />
        )}
      </Suspense>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
        active
          ? "border-foreground text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

type TransactionRow = NonNullable<
  NonNullable<
    NonNullable<
      ResultOf<typeof InvestmentTransactionsDocument>["investment"]
    >["edges"][number]["node"]["transactionsPaged"]
  >
>["edges"][number]["node"];

function TransactionsSection({
  investmentId,
  currency,
  wrappers,
  filterAssetId,
}: {
  investmentId: string;
  currency: string;
  wrappers: { id: string; name: string; type: string }[];
  filterAssetId: string | null;
}) {
  // Keyset pagination stack: each entry is the `after` cursor that produced the
  // current page. `[null]` = first page.
  const [cursorStack, setCursorStack] = useState<(string | null)[]>([null]);
  const currentCursor = cursorStack[cursorStack.length - 1];
  const { data, refetch } = useSuspenseQuery(InvestmentTransactionsDocument, {
    variables: {
      txFirst: 15,
      txAfter: currentCursor,
      filterAssetId,
    },
  });
  const investment = data.investment?.edges
    .map((e) => e.node)
    .find((n) => n.id === investmentId);
  const transactions: TransactionRow[] =
    investment?.transactionsPaged?.edges.map((e) => e.node) ?? [];
  const hasNextPage =
    investment?.transactionsPaged?.pageInfo.hasNextPage ?? false;
  const endCursor = investment?.transactionsPaged?.pageInfo.endCursor ?? null;

  const onMutate = () => {
    setCursorStack([null]);
    void refetch();
  };
  const onNext = () => {
    if (endCursor) setCursorStack((s) => [...s, endCursor]);
  };
  const onPrev: (() => void) | null =
    cursorStack.length > 1 ? () => setCursorStack((s) => s.slice(0, -1)) : null;

  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<TransactionRow | null>(null);
  const onEdit = (t: TransactionRow) => setEditing(t);
  const [deleteTx] = useMutation(InvestmentTransactionDeleteDocument, {
    refetchQueries: [
      {
        query: InvestmentTransactionsDocument,
        variables: { txFirst: 15, txAfter: null },
      },
      { query: InvestmentDetailDocument },
      { query: InvestmentsListDocument, variables: { first: 100 } },
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
        <TransactionForm
          investmentId={investmentId}
          currency={currency}
          wrappers={wrappers}
          existing={null}
          defaultAssetId={
            filterAssetId ?? transactions[0]?.asset.id ?? wrappers[0]?.id ?? ""
          }
          lockedAssetId={filterAssetId}
          onDone={() => {
            setAdding(false);
            onMutate();
          }}
          onCancel={() => setAdding(false)}
        />
      )}

      {editing && (
        <TransactionForm
          investmentId={investmentId}
          currency={currency}
          wrappers={wrappers}
          existing={editing}
          defaultAssetId={editing.asset.id}
          lockedAssetId={filterAssetId}
          onDone={() => {
            setEditing(null);
            onMutate();
          }}
          onCancel={() => setEditing(null)}
        />
      )}

      {transactions.length === 0 ? (
        <p className="text-sm text-muted-foreground">No transactions yet.</p>
      ) : (
        <div className="max-h-[45vh] overflow-y-auto rounded border">
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
                  <TableCell className="align-middle">{t.date}</TableCell>
                  <TableCell className="align-middle">{t.asset.name}</TableCell>
                  <TableCell className="text-right tabular-nums align-middle">
                    {t.units}
                  </TableCell>
                  <TableCell className="text-right align-middle">
                    <Figure data={t.price} />
                  </TableCell>
                  <TableCell className="align-middle">
                    {t.drip ? "Yes" : ""}
                  </TableCell>
                  <TableCell className="w-0 align-middle">
                    <div className="flex items-center gap-1">
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => onEdit(t)}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <DeleteButton
                        onConfirm={() => deleteTx({ variables: { id: t.id } })}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <div className="flex justify-between border-t pt-3">
        <Button
          size="sm"
          variant="outline"
          disabled={!onPrev}
          onClick={() => onPrev?.()}
        >
          ← Prev
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!hasNextPage || !endCursor}
          onClick={onNext}
        >
          Next →
        </Button>
      </div>
    </section>
  );
}

function TransactionForm({
  investmentId,
  currency,
  wrappers,
  existing,
  defaultAssetId,
  lockedAssetId,
  onDone,
  onCancel,
}: {
  investmentId: string;
  currency: string;
  wrappers: { id: string; name: string; type: string }[];
  existing: TransactionRow | null;
  defaultAssetId: string;
  /** When set, the wrapper field is read-only and pinned to this id (applied when a page-level filter is active). */
  lockedAssetId: string | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const refetch = [
    {
      query: InvestmentTransactionsDocument,
      variables: { txFirst: 15, txAfter: null },
    },
    { query: InvestmentDetailDocument },
    { query: InvestmentsListDocument, variables: { first: 100 } },
  ];
  const [createTx] = useMutation(InvestmentTransactionCreateDocument, {
    refetchQueries: refetch,
    awaitRefetchQueries: true,
  });
  const [updateTx] = useMutation(InvestmentTransactionUpdateDocument, {
    refetchQueries: refetch,
    awaitRefetchQueries: true,
  });

  const form = useForm({
    defaultValues: {
      assetId: existing?.asset.id ?? defaultAssetId,
      date: existing?.date ?? new Date().toISOString().slice(0, 10),
      units: existing?.units ?? 0,
      priceAmount: existing?.price.amount ?? 0,
      taxesAmount: existing?.taxes.amount ?? 0,
      feesAmount: existing?.fees.amount ?? 0,
      drip: existing?.drip ?? false,
    },
    onSubmit: async ({ value }) => {
      if (!value.assetId) {
        toast.error("Pick a wrapper");
        return;
      }
      try {
        if (existing) {
          await updateTx({
            variables: {
              id: existing.id,
              assetId: value.assetId,
              date: value.date,
              units: Math.trunc(value.units),
              price: { amount: Number(value.priceAmount), currency },
              taxes: { amount: Number(value.taxesAmount), currency },
              fees: { amount: Number(value.feesAmount), currency },
              drip: value.drip,
            },
          });
          toast.success("Transaction updated");
        } else {
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
      className="grid grid-cols-2 gap-3 rounded border p-3 sm:grid-cols-4"
    >
      <form.Field name="assetId">
        {(field) => {
          if (lockedAssetId) {
            const locked = wrappers.find((w) => w.id === lockedAssetId);
            return (
              <div className="space-y-1 sm:col-span-2">
                <Label>Wrapper</Label>
                <TooltipProvider delayDuration={150}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Input
                        readOnly
                        disabled
                        value={locked ? `${locked.name} (${locked.type})` : ""}
                      />
                    </TooltipTrigger>
                    <TooltipContent>
                      Remove the page filter to change the wrapper.
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
            );
          }
          return (
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
          );
        }}
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
              {existing ? "Save" : "Add"}
            </Button>
          )}
        </form.Subscribe>
      </div>
    </form>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}

type StockSplitRow = {
  id: string;
  date: string;
  ratio: number;
};

function StockSplitsSection({ investmentId }: { investmentId: string }) {
  const { data, refetch } = useSuspenseQuery(InvestmentStockSplitsDocument);
  const investment = data.investment?.edges
    .map((e) => e.node)
    .find((n) => n.id === investmentId);
  const splits: StockSplitRow[] = (investment?.stockSplits ?? []).map((s) => ({
    id: s.id,
    date: s.date,
    ratio: s.ratio,
  }));

  const refetchLists = [
    { query: InvestmentStockSplitsDocument },
    { query: InvestmentDetailDocument },
    { query: InvestmentsListDocument, variables: { first: 100 } },
  ];
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<StockSplitRow | null>(null);

  const [deleteSplit] = useMutation(InvestmentStockSplitDeleteDocument, {
    refetchQueries: refetchLists,
    awaitRefetchQueries: true,
    onCompleted: () => toast.success("Split removed"),
    onError: (err) => toast.error(err.message),
  });

  const onMutate = () => void refetch();

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Stock splits</h3>
        <Button size="sm" onClick={() => setAdding(true)}>
          <Plus className="mr-1 h-4 w-4" /> Add
        </Button>
      </div>

      {adding && (
        <StockSplitForm
          investmentId={investmentId}
          existing={null}
          onDone={() => {
            setAdding(false);
            onMutate();
          }}
          onCancel={() => setAdding(false)}
        />
      )}
      {editing && (
        <StockSplitForm
          investmentId={investmentId}
          existing={editing}
          onDone={() => {
            setEditing(null);
            onMutate();
          }}
          onCancel={() => setEditing(null)}
        />
      )}

      {splits.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No stock splits recorded.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead className="text-right">Ratio</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {splits.map((s) => (
              <TableRow key={s.id}>
                <TableCell className="align-middle">{s.date}</TableCell>
                <TableCell className="text-right tabular-nums align-middle">
                  {s.ratio}
                </TableCell>
                <TableCell className="w-0 align-middle">
                  <div className="flex items-center gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => setEditing(s)}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <DeleteButton
                      onConfirm={() => deleteSplit({ variables: { id: s.id } })}
                    />
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

function StockSplitForm({
  investmentId,
  existing,
  onDone,
  onCancel,
}: {
  investmentId: string;
  existing: StockSplitRow | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const refetchLists = [
    { query: InvestmentStockSplitsDocument },
    { query: InvestmentDetailDocument },
    { query: InvestmentsListDocument, variables: { first: 100 } },
  ];
  const [createSplit] = useMutation(InvestmentStockSplitCreateDocument, {
    refetchQueries: refetchLists,
    awaitRefetchQueries: true,
  });
  const [updateSplit] = useMutation(InvestmentStockSplitUpdateDocument, {
    refetchQueries: refetchLists,
    awaitRefetchQueries: true,
  });

  const form = useForm({
    defaultValues: {
      date: existing?.date ?? new Date().toISOString().slice(0, 10),
      ratio: existing?.ratio ?? 2,
    },
    onSubmit: async ({ value }) => {
      if (!(value.ratio > 0)) {
        toast.error("Ratio must be positive");
        return;
      }
      try {
        if (existing) {
          await updateSplit({
            variables: {
              id: existing.id,
              date: value.date,
              ratio: value.ratio,
            },
          });
          toast.success("Split updated");
        } else {
          await createSplit({
            variables: {
              investmentId,
              date: value.date,
              ratio: value.ratio,
            },
          });
          toast.success("Split added");
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
      className="grid grid-cols-1 gap-3 rounded border p-3 sm:grid-cols-3"
    >
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
      <form.Field name="ratio">
        {(field) => (
          <div className="space-y-1">
            <Label>Ratio</Label>
            <Input
              type="number"
              step="any"
              value={field.state.value}
              onChange={(e) => field.handleChange(Number(e.target.value))}
            />
          </div>
        )}
      </form.Field>
      <div className="col-span-full flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <form.Subscribe selector={(s) => s.isSubmitting}>
          {(submitting) => (
            <Button type="submit" disabled={submitting}>
              {existing ? "Save" : "Add"}
            </Button>
          )}
        </form.Subscribe>
      </div>
    </form>
  );
}

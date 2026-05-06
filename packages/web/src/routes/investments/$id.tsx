import { useMutation, useSuspenseQuery } from "@apollo/client/react";
import { useForm } from "@tanstack/react-form";
import {
  createFileRoute,
  useNavigate,
  useSearch,
} from "@tanstack/react-router";
import { FileText, Paperclip, Plus, Trash2, Upload, X } from "lucide-react";
import { Suspense, useId, useState } from "react";
import { toast } from "sonner";

import { ContractNoteImportDialog } from "@/components/contract-note-import-dialog";
import { Figure, FigureDocument } from "@/components/figure";
import {
  InvestmentForm,
  InvestmentFormDocument,
} from "@/components/investments/investment-form";
import { PdfPreviewDialog } from "@/components/pdf-preview-dialog";
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
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { graphql, type ResultOf } from "@/graphql";
import { formatAccountingMoney } from "@/lib/format";

const InvestmentDetailDocument = graphql(
  `
    query InvestmentDetail($filterAssetIdIn: [ID!]) {
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
            position(filterAssetIdIn: $filterAssetIdIn) {
              units
              costBasis {
                ...Figure
              }
              totalValue {
                ...Figure
              }
              realisedValue {
                amount
                ...Figure
              }
              reinvested {
                cost {
                  ...Figure
                }
                value {
                  ...Figure
                }
              }
              totalGain {
                ...Figure
              }
              realisedGain {
                ...Figure
              }
              unrealisedGain {
                ...Figure
              }
              feesAndTaxes {
                amount
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
      $filterAssetIdIn: [ID!]
    ) {
      investment: investments(filterAssetIdIn: $filterAssetIdIn) {
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
                  fileUrl
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
    $units: Float!
    $price: MoneyInput!
    $taxes: MoneyInput
    $fees: MoneyInput
    $drip: Boolean
    $file: Upload
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
      file: $file
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
    $units: Float
    $price: MoneyInput
    $taxes: MoneyInput
    $fees: MoneyInput
    $drip: Boolean
    $file: Upload
    $clearFile: Boolean
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
      file: $file
      clearFile: $clearFile
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
  // Scope to a single portfolio only when exactly one is selected at the
  // page level; the transactions query / position lookup accept a singular
  // `filterAssetId`, so 0 or 2+ selected falls back to unfiltered.
  const rawFilter = parentSearch["filter-portfolio-id"];
  const parsed = rawFilter
    ? rawFilter.split(",").filter((s) => s.length > 0)
    : [];
  const filterAssetId = parsed.length === 1 ? parsed[0] : null;
  const filterAssetIds = parsed;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open)
          void navigate({
            to: "/investments",
            search: (prev) => prev,
            resetScroll: false,
          });
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
          <InvestmentDetail
            id={id}
            filterAssetId={filterAssetId}
            filterAssetIds={filterAssetIds}
          />
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
  filterAssetIds,
}: {
  id: string;
  filterAssetId: string | null;
  filterAssetIds: string[];
}) {
  const navigate = useNavigate();
  const { data } = useSuspenseQuery(InvestmentDetailDocument, {
    variables: {
      filterAssetIdIn: filterAssetIds.length > 0 ? filterAssetIds : null,
    },
  });
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
        onDeleted={() =>
          void navigate({
            to: "/investments",
            search: (prev) => prev,
            resetScroll: false,
          })
        }
        refetchQueries={["InvestmentDetail", "InvestmentsList"]}
      />
      <header className="space-y-1">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-5">
          <Stat label="Units" value={investment.position.units.toString()} />
          <Stat
            label="Cost basis"
            tooltip="Average price per held share under FIFO lot accounting (oldest buys consumed first by sells). DRIP shares are counted at zero cost — the dividend was already received as income."
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
            sub={
              investment.position.realisedValue.amount > 0 ? (
                <>
                  <Figure data={investment.position.realisedValue} /> realised
                </>
              ) : null
            }
          />
          <Stat
            label="Reinvested"
            value={
              <>
                <Figure data={investment.position.reinvested.cost} />
                {investment.position.reinvested.value && (
                  <span className="text-muted-foreground">
                    {" → "}
                    <Figure data={investment.position.reinvested.value} />
                  </span>
                )}
              </>
            }
          />
          <Stat
            label="Total return"
            tooltip={
              <span className="space-y-1">
                <span className="block">
                  Unrealised:{" "}
                  {investment.position.unrealisedGain ? (
                    <Figure data={investment.position.unrealisedGain} />
                  ) : (
                    "—"
                  )}
                </span>
                <span className="block">
                  Realised: <Figure data={investment.position.realisedGain} />
                </span>
                {investment.position.feesAndTaxes.amount > 0 && (
                  <span className="block">
                    Fees & taxes: −
                    <Figure data={investment.position.feesAndTaxes} />
                  </span>
                )}
              </span>
            }
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
        filterAssetIds={filterAssetIds}
      />
    </div>
  );
}

function DetailTabs({
  investmentId,
  currency,
  wrappers,
  filterAssetId,
  filterAssetIds,
}: {
  investmentId: string;
  currency: string;
  wrappers: { id: string; name: string; type: string }[];
  filterAssetId: string | null;
  filterAssetIds: string[];
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
            filterAssetIds={filterAssetIds}
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
  filterAssetIds,
}: {
  investmentId: string;
  currency: string;
  wrappers: { id: string; name: string; type: string }[];
  filterAssetId: string | null;
  filterAssetIds: string[];
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
      filterAssetIdIn: filterAssetIds.length > 0 ? filterAssetIds : null,
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
  const [updateTx] = useMutation(InvestmentTransactionUpdateDocument, {
    refetchQueries: [
      "InvestmentTransactions",
      "InvestmentDetail",
      "InvestmentsList",
    ],
    awaitRefetchQueries: true,
  });
  const attachFile = async (id: string, file: File) => {
    if (
      file.type !== "application/pdf" &&
      !file.name.toLowerCase().endsWith(".pdf")
    ) {
      toast.error("Only PDF files are supported.");
      return;
    }
    try {
      await updateTx({ variables: { id, file } });
      toast.success("Attached contract note");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };
  const [contractNoteFile, setContractNoteFile] = useState<File | null>(null);
  const [contractNoteOpen, setContractNoteOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const onEdit = (t: TransactionRow) => setEditing(t);

  const handleDroppedFile = (file: File | undefined) => {
    if (!file) return;
    if (
      file.type !== "application/pdf" &&
      !file.name.toLowerCase().endsWith(".pdf")
    ) {
      toast.error("Only PDF files are supported.");
      return;
    }
    setContractNoteFile(file);
    setContractNoteOpen(true);
  };
  const [deleteTx] = useMutation(InvestmentTransactionDeleteDocument, {
    refetchQueries: [
      "InvestmentTransactions",
      "InvestmentDetail",
      "InvestmentsList",
    ],
    onCompleted: () => toast.success("Transaction removed"),
    onError: (err) => toast.error(err.message),
  });

  return (
    <section
      className="space-y-2"
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        handleDroppedFile(e.dataTransfer.files?.[0]);
      }}
    >
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Transactions</h3>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setContractNoteFile(null);
              setContractNoteOpen(true);
            }}
          >
            <FileText className="mr-1 h-4 w-4" /> Import contract note
          </Button>
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus className="mr-1 h-4 w-4" /> Add
          </Button>
        </div>
      </div>
      <div
        className={`rounded border-2 border-dashed px-3 py-2 text-center text-xs transition-colors ${
          dragOver
            ? "border-foreground bg-accent/40 text-foreground"
            : "border-muted-foreground/30 text-muted-foreground"
        }`}
      >
        Drop a contract note PDF here to import it.
      </div>
      {contractNoteOpen && (
        <Suspense fallback={null}>
          <ContractNoteImportDialog
            initialFile={contractNoteFile}
            lockedInvestmentId={investmentId}
            onClose={() => {
              setContractNoteOpen(false);
              setContractNoteFile(null);
            }}
            onSaved={onMutate}
          />
        </Suspense>
      )}

      {adding && (
        <TransactionForm
          investmentId={investmentId}
          currency={currency}
          wrappers={wrappers}
          existing={null}
          defaultAssetId={
            filterAssetId ?? transactions[0]?.asset.id ?? wrappers[0]?.id ?? ""
          }
          allowedAssetIds={filterAssetIds}
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
          allowedAssetIds={filterAssetIds}
          onDone={() => {
            setEditing(null);
            onMutate();
          }}
          onCancel={() => setEditing(null)}
          onDelete={async () => {
            await deleteTx({ variables: { id: editing.id } });
            setEditing(null);
            onMutate();
          }}
        />
      )}

      {transactions.length === 0 ? (
        <p className="text-sm text-muted-foreground">No transactions yet.</p>
      ) : (
        <ul className="max-h-[45vh] divide-y overflow-y-auto rounded border">
          {transactions.map((t) => (
            <TransactionRowItem
              key={t.id}
              t={t}
              currency={currency}
              onEdit={() => onEdit(t)}
              onAttach={(file) => attachFile(t.id, file)}
            />
          ))}
        </ul>
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
  allowedAssetIds,
  onDone,
  onCancel,
  onDelete,
}: {
  investmentId: string;
  currency: string;
  wrappers: { id: string; name: string; type: string }[];
  existing: TransactionRow | null;
  defaultAssetId: string;
  /** Page-level portfolio filter: empty = all allowed; one entry = field is locked to that id; 2+ = select is restricted to that subset. */
  allowedAssetIds: string[];
  onDone: () => void;
  onCancel: () => void;
  onDelete?: () => Promise<void> | void;
}) {
  const refetch = [
    "InvestmentTransactions",
    "InvestmentDetail",
    "InvestmentsList",
  ];
  const [createTx] = useMutation(InvestmentTransactionCreateDocument, {
    refetchQueries: refetch,
    awaitRefetchQueries: true,
  });
  const [updateTx] = useMutation(InvestmentTransactionUpdateDocument, {
    refetchQueries: refetch,
    awaitRefetchQueries: true,
  });

  // Pending file selection (separate from the rest of the form state since
  // `useForm` defaults stay JSON-ish and `File` doesn't round-trip well).
  // `clearFile` only matters on update — toggles the existing attachment off.
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [clearFile, setClearFile] = useState(false);

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
        toast.error("Pick a portfolio");
        return;
      }
      try {
        if (existing) {
          await updateTx({
            variables: {
              id: existing.id,
              assetId: value.assetId,
              date: value.date,
              units: value.units,
              price: { amount: Number(value.priceAmount), currency },
              taxes: { amount: Number(value.taxesAmount), currency },
              fees: { amount: Number(value.feesAmount), currency },
              drip: value.drip,
              file: pendingFile,
              clearFile: pendingFile ? null : clearFile || null,
            },
          });
          toast.success("Transaction updated");
        } else {
          await createTx({
            variables: {
              investmentId,
              assetId: value.assetId,
              date: value.date,
              units: value.units,
              price: { amount: Number(value.priceAmount), currency },
              taxes: { amount: Number(value.taxesAmount), currency },
              fees: { amount: Number(value.feesAmount), currency },
              drip: value.drip,
              file: pendingFile,
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
      className="grid grid-cols-1 gap-3 rounded border p-3 sm:grid-cols-4"
    >
      <form.Field name="assetId">
        {(field) => {
          if (allowedAssetIds.length === 1) {
            const lockedId = allowedAssetIds[0];
            const locked = wrappers.find((w) => w.id === lockedId);
            return (
              <div className="space-y-1 sm:col-span-2">
                <Label>Portfolio</Label>
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
                      Remove the page filter to change the portfolio.
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
            );
          }
          const options =
            allowedAssetIds.length > 1
              ? wrappers.filter((w) => allowedAssetIds.includes(w.id))
              : wrappers;
          return (
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
                  {options.map((w) => (
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
              step="any"
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
      <ContractNoteFileField
        existingUrl={existing?.fileUrl ?? null}
        pendingFile={pendingFile}
        onPick={(f) => {
          setPendingFile(f);
          setClearFile(false);
        }}
        onClear={() => {
          setPendingFile(null);
          setClearFile(true);
        }}
      />
      <div className="col-span-full flex items-center justify-end gap-2">
        {onDelete && (
          <Button
            type="button"
            variant="ghost"
            className="mr-auto text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={() => {
              void onDelete();
            }}
          >
            <Trash2 className="h-4 w-4" />
            Delete
          </Button>
        )}
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

function TransactionRowItem({
  t,
  currency,
  onEdit,
  onAttach,
}: {
  t: TransactionRow;
  currency: string;
  onEdit: () => void;
  onAttach: (file: File) => void;
}) {
  const inputId = useId();
  const [dragOver, setDragOver] = useState(false);
  return (
    <li
      onDragOver={(e) => {
        // Stop the section-level import dropzone from also lighting up — a
        // drop on a row should attach to that row, not open the import dialog.
        e.preventDefault();
        e.stopPropagation();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setDragOver(false);
        const f = e.dataTransfer.files?.[0];
        if (f) onAttach(f);
      }}
      className={
        dragOver ? "bg-accent/60 outline outline-1 outline-foreground" : ""
      }
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={onEdit}
          className="flex min-w-0 flex-1 items-center justify-between gap-3 text-left hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:outline-none"
        >
          <span className="flex min-w-0 items-baseline gap-2 text-sm">
            <span className="tabular-nums">{t.date}</span>
            <span className="truncate text-muted-foreground">
              {t.asset.name}
            </span>
          </span>
          <span className="shrink-0 text-sm tabular-nums">
            <span className="hidden text-muted-foreground sm:inline">
              {formatAccountingMoney(currency, t.units * t.price.amount)}
              {" · "}
            </span>
            {t.units}u @ <Figure data={t.price} />
            {t.drip && (
              <span className="ml-1 text-xs text-muted-foreground">DRIP</span>
            )}
          </span>
        </button>
        <input
          id={inputId}
          type="file"
          accept="application/pdf"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onAttach(f);
            e.target.value = "";
          }}
        />
        {t.fileUrl ? (
          <PdfPreviewDialog
            url={t.fileUrl}
            label={`Contract note for ${t.date} ${t.asset.name}`}
          >
            <button
              type="button"
              title="Preview contract note"
              className="inline-flex shrink-0 cursor-pointer items-center justify-center rounded p-1 text-muted-foreground hover:bg-accent/40 hover:text-foreground"
            >
              <Paperclip className="size-3.5" />
            </button>
          </PdfPreviewDialog>
        ) : (
          <label
            htmlFor={inputId}
            title="Attach contract note (or drop a PDF on this row)"
            className="inline-flex shrink-0 cursor-pointer items-center justify-center rounded p-1 text-muted-foreground hover:bg-accent/40 hover:text-foreground"
          >
            <Upload className="size-3.5" />
          </label>
        )}
      </div>
    </li>
  );
}

function ContractNoteFileField({
  existingUrl,
  pendingFile,
  onPick,
  onClear,
}: {
  existingUrl: string | null;
  pendingFile: File | null;
  onPick: (file: File) => void;
  onClear: () => void;
}) {
  const inputId = useId();
  return (
    <div className="space-y-1 sm:col-span-2">
      <Label>Contract note</Label>
      <div className="flex items-center gap-2">
        <input
          id={inputId}
          type="file"
          accept="application/pdf"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onPick(f);
            e.target.value = "";
          }}
        />
        {pendingFile ? (
          <span className="flex min-w-0 flex-1 items-center gap-2 truncate text-sm">
            <Paperclip className="size-4 shrink-0" />
            <span className="truncate">{pendingFile.name}</span>
          </span>
        ) : existingUrl ? (
          <PdfPreviewDialog url={existingUrl} label="Contract note">
            <button
              type="button"
              className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 truncate text-sm text-foreground hover:underline"
            >
              <Paperclip className="size-4 shrink-0" />
              View attached PDF
            </button>
          </PdfPreviewDialog>
        ) : (
          <span className="flex-1 text-sm text-muted-foreground">
            No file attached.
          </span>
        )}
        <Button asChild size="sm" variant="outline">
          <label htmlFor={inputId} className="cursor-pointer">
            {existingUrl || pendingFile ? "Replace" : "Attach"}
          </label>
        </Button>
        {(existingUrl || pendingFile) && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={onClear}
            aria-label="Remove attachment"
          >
            <X className="size-4" />
          </Button>
        )}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tooltip,
  sub,
}: {
  label: string;
  value: React.ReactNode;
  tooltip?: React.ReactNode;
  sub?: React.ReactNode;
}) {
  const labelEl = tooltip ? (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-help border-b border-dotted border-muted-foreground/40">
            {label}
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">{tooltip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  ) : (
    label
  );
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{labelEl}</dt>
      <dd className="tabular-nums">{value}</dd>
      {sub ? (
        <dd className="text-xs tabular-nums text-muted-foreground">{sub}</dd>
      ) : null}
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
    "InvestmentDetail",
    "InvestmentsList",
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
          onDelete={async () => {
            await deleteSplit({ variables: { id: editing.id } });
            setEditing(null);
            onMutate();
          }}
        />
      )}

      {splits.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No stock splits recorded.
        </p>
      ) : (
        <ul className="divide-y rounded border">
          {splits.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => setEditing(s)}
                className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:outline-none"
              >
                <span className="text-sm tabular-nums">{s.date}</span>
                <span className="text-sm tabular-nums">{s.ratio}×</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function StockSplitForm({
  investmentId,
  existing,
  onDone,
  onCancel,
  onDelete,
}: {
  investmentId: string;
  existing: StockSplitRow | null;
  onDone: () => void;
  onCancel: () => void;
  onDelete?: () => Promise<void> | void;
}) {
  const refetchLists = [
    { query: InvestmentStockSplitsDocument },
    "InvestmentDetail",
    "InvestmentsList",
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
      <div className="col-span-full flex items-center justify-end gap-2">
        {onDelete && (
          <Button
            type="button"
            variant="ghost"
            className="mr-auto text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={() => {
              void onDelete();
            }}
          >
            <Trash2 className="h-4 w-4" />
            Delete
          </Button>
        )}
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

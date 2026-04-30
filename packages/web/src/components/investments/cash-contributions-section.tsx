import { useMutation, useQuery } from "@apollo/client/react";
import { Pencil, Plus, Wallet } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { DeleteButton } from "@/components/delete-button";
import { Button } from "@/components/ui/button";
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
import { graphql, readFragment, type ResultOf } from "@/graphql";
import { formatAccountingMoney } from "@/lib/format";

export const CashContributionsAvailableFragment = graphql(`
  fragment CashContributionsAvailable on Portfolio {
    cash {
      amount
      currency
    }
  }
`);

// Pinned to `skipLive: true` so this query targets the same `Portfolio`
// normalised entity the route's `InvestmentsPageDocument` prewarms (which
// also runs with `skipLive: true`). When the initial `filter-portfolio-id`
// matches `assetId`, the prewarm satisfies this query from cache without
// hitting the network. On filter change, the route's query stays frozen on
// the initial vars while this one re-fires to track the current asset.
const CashContributionsAvailableDocument = graphql(
  `
    query CashContributionsAvailable($assetId: ID!) {
      portfolio(filterAssetIdIn: [$assetId], skipLive: true) {
        id
        ...CashContributionsAvailable
      }
    }
  `,
  [CashContributionsAvailableFragment],
);

const CashContributionsListDocument = graphql(`
  query CashContributionsList($assetId: ID!, $first: Int, $after: ID) {
    netWorthCategoryAsset(id: $assetId) {
      id
      name
      cashContributions(first: $first, after: $after) {
        edges {
          cursor
          node {
            __typename
            ... on InvestmentDeposit {
              id
              date
              name
              amount {
                amount
                currency
              }
            }
            ... on AssetCashPlanningTransaction {
              id
              date
              name
              amount {
                amount
                currency
              }
              fromAccount {
                id
                name
              }
            }
            ... on AssetValueSnapshot {
              id
              date
              value {
                amount
                currency
              }
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
    planningYearCurrent {
      id
      accounts {
        id
        name
        asset {
          id
          type
        }
      }
    }
  }
`);

const InvestmentDepositCreateDocument = graphql(`
  mutation InvestmentDepositCreate(
    $assetId: ID!
    $date: Date!
    $amount: MoneyInput!
    $name: String!
  ) {
    investmentDepositCreate(
      assetId: $assetId
      date: $date
      amount: $amount
      name: $name
    ) {
      id
    }
  }
`);

const InvestmentDepositUpdateDocument = graphql(`
  mutation InvestmentDepositUpdate(
    $id: ID!
    $date: Date
    $amount: MoneyInput
    $name: String
  ) {
    investmentDepositUpdate(
      id: $id
      date: $date
      amount: $amount
      name: $name
    ) {
      id
    }
  }
`);

const InvestmentDepositDeleteDocument = graphql(`
  mutation InvestmentDepositDelete($id: ID!) {
    investmentDepositDelete(id: $id) {
      _
    }
  }
`);

const AssetPlanningTxCreateDocument = graphql(`
  mutation AssetPlanningTxCreate(
    $assetId: ID!
    $fromAccountId: ID!
    $date: Date!
    $amount: MoneyInput!
    $name: String!
  ) {
    assetCashTransactionCreate(
      assetId: $assetId
      fromAccountId: $fromAccountId
      date: $date
      amount: $amount
      name: $name
    ) {
      id
    }
  }
`);

const AssetPlanningTxUpdateDocument = graphql(`
  mutation AssetPlanningTxUpdate(
    $id: ID!
    $date: Date
    $amount: MoneyInput
    $name: String
    $fromAccountId: ID
  ) {
    assetCashTransactionUpdate(
      id: $id
      date: $date
      amount: $amount
      name: $name
      fromAccountId: $fromAccountId
    ) {
      id
    }
  }
`);

const AssetPlanningTxDeleteDocument = graphql(`
  mutation AssetPlanningTxDelete($id: ID!) {
    assetCashTransactionDelete(id: $id) {
      _
    }
  }
`);

type ListData = ResultOf<typeof CashContributionsListDocument>;
type ContributionEdge = NonNullable<
  NonNullable<ListData["netWorthCategoryAsset"]>["cashContributions"]
>["edges"][number];
type ContributionNode = ContributionEdge["node"];
type DepositNode = Extract<
  ContributionNode,
  { __typename: "InvestmentDeposit" }
>;
type PlanningTxNode = Extract<
  ContributionNode,
  { __typename: "AssetCashPlanningTransaction" }
>;
type CashAccountOption = {
  id: string;
  name: string;
};

const PAGE_SIZE = 20;

type EditingState =
  | { kind: "deposit"; deposit: DepositNode | null }
  | { kind: "planningTx"; tx: PlanningTxNode | null }
  | null;

export function CashContributionsSection({ assetId }: { assetId: string }) {
  const { data } = useQuery(CashContributionsAvailableDocument, {
    variables: { assetId },
  });
  const cash = data?.portfolio
    ? readFragment(CashContributionsAvailableFragment, data.portfolio).cash
    : null;
  const [open, setOpen] = useState(false);

  return (
    <section className="rounded-lg border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold">Cash contributions</h2>
          <p className="text-xs text-muted-foreground">
            Available to invest:{" "}
            {cash ? formatAccountingMoney(cash.currency, cash.amount) : "—"}
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          <Wallet className="mr-1 h-4 w-4" />
          Manage cash deposits
        </Button>
      </div>
      {open && (
        <ManageDialog
          assetId={assetId}
          defaultCurrency={cash?.currency ?? "GBP"}
          onClose={() => setOpen(false)}
        />
      )}
    </section>
  );
}

function ManageDialog({
  assetId,
  defaultCurrency,
  onClose,
}: {
  assetId: string;
  defaultCurrency: string;
  onClose: () => void;
}) {
  const { data, fetchMore, refetch } = useQuery(CashContributionsListDocument, {
    variables: { assetId, first: PAGE_SIZE },
    notifyOnNetworkStatusChange: true,
  });

  const asset = data?.netWorthCategoryAsset ?? null;
  const edges = asset?.cashContributions?.edges ?? [];
  const pageInfo = asset?.cashContributions?.pageInfo;
  const cashAccounts: CashAccountOption[] = (
    data?.planningYearCurrent?.accounts ?? []
  )
    .filter((a) => a.asset.type === "CASH")
    .map((a) => ({ id: a.id, name: a.name }));

  const [editing, setEditing] = useState<EditingState>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const [deleteDeposit] = useMutation(InvestmentDepositDeleteDocument, {
    onCompleted: () => {
      toast.success("Deposit deleted");
      void refetch();
    },
    onError: (err) => toast.error(err.message),
  });
  const [deletePlanningTx] = useMutation(AssetPlanningTxDeleteDocument, {
    onCompleted: () => {
      toast.success("Cash transfer deleted");
      void refetch();
    },
    onError: (err) => toast.error(err.message),
  });

  const noPlanningAccountsAvailable = cashAccounts.length === 0;

  async function loadMore() {
    if (!pageInfo?.hasNextPage || !pageInfo.endCursor) return;
    setLoadingMore(true);
    try {
      await fetchMore({
        variables: { after: pageInfo.endCursor },
        // No global `relayStylePagination` is configured, so append the new
        // page onto the cached edges by hand. Using `updateQuery` keeps the
        // append local to this consumer rather than introducing a typePolicy
        // for one rarely-paginated field.
        updateQuery: (prev, { fetchMoreResult }) => {
          const prevAsset = prev.netWorthCategoryAsset;
          const nextAsset = fetchMoreResult.netWorthCategoryAsset;
          if (!prevAsset?.cashContributions || !nextAsset?.cashContributions) {
            return prev;
          }
          return {
            ...fetchMoreResult,
            netWorthCategoryAsset: {
              ...nextAsset,
              cashContributions: {
                ...nextAsset.cashContributions,
                edges: [
                  ...prevAsset.cashContributions.edges,
                  ...nextAsset.cashContributions.edges,
                ],
              },
            },
          };
        },
      });
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Manage cash deposits</DialogTitle>
          <DialogDescription>
            Cash contributions to this wrapper. Add a transfer from a planning
            cash account, or an external deposit (e.g. dividend income, pension
            tax relief). Amounts are from the wrapper's perspective: positive
            means money flowing into the wrapper, negative means out.
          </DialogDescription>
        </DialogHeader>
        <div className="mb-3 flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setEditing({ kind: "planningTx", tx: null })}
            disabled={noPlanningAccountsAvailable}
            title={
              noPlanningAccountsAvailable
                ? "No cash planning accounts configured yet"
                : undefined
            }
          >
            <Plus className="mr-1 h-4 w-4" />
            Cash transfer
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setEditing({ kind: "deposit", deposit: null })}
          >
            <Plus className="mr-1 h-4 w-4" />
            External deposit
          </Button>
        </div>
        {edges.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No cash contributions recorded yet.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Source</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {edges.map(({ node }) => {
                if (node.__typename === "AssetCashPlanningTransaction") {
                  return (
                    <TableRow key={node.id}>
                      <TableCell className="align-middle tabular-nums">
                        {node.date.slice(0, 7)}
                      </TableCell>
                      <TableCell className="align-middle">
                        {node.name}
                      </TableCell>
                      <TableCell className="align-middle text-xs text-muted-foreground">
                        {node.fromAccount.name}
                      </TableCell>
                      <TableCell className="align-middle text-right tabular-nums">
                        {formatAccountingMoney(
                          node.amount.currency,
                          node.amount.amount,
                        )}
                      </TableCell>
                      <TableCell className="align-middle text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() =>
                              setEditing({ kind: "planningTx", tx: node })
                            }
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <DeleteButton
                            onConfirm={() =>
                              deletePlanningTx({
                                variables: { id: node.id },
                              })
                            }
                          />
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                }
                if (node.__typename === "AssetValueSnapshot") {
                  const label =
                    node.value === null
                      ? `Defunct since ${node.date}`
                      : `Recorded as ${formatAccountingMoney(
                          node.value.currency,
                          node.value.amount,
                        )} on ${node.date}`;
                  return (
                    <TableRow
                      key={node.id}
                      className="bg-muted/30 hover:bg-muted/40"
                    >
                      <TableCell
                        colSpan={5}
                        className="text-center text-xs uppercase tracking-wide text-muted-foreground"
                      >
                        — {label} —
                      </TableCell>
                    </TableRow>
                  );
                }
                if (node.__typename === "InvestmentDeposit") {
                  return (
                    <TableRow key={node.id}>
                      <TableCell className="align-middle tabular-nums">
                        {node.date}
                      </TableCell>
                      <TableCell className="align-middle">
                        {node.name}
                      </TableCell>
                      <TableCell className="align-middle text-xs text-muted-foreground italic">
                        External
                      </TableCell>
                      <TableCell className="align-middle text-right tabular-nums">
                        {formatAccountingMoney(
                          node.amount.currency,
                          node.amount.amount,
                        )}
                      </TableCell>
                      <TableCell className="align-middle text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() =>
                              setEditing({ kind: "deposit", deposit: node })
                            }
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <DeleteButton
                            onConfirm={() =>
                              deleteDeposit({ variables: { id: node.id } })
                            }
                          />
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                }
                return null;
              })}
            </TableBody>
          </Table>
        )}
        {pageInfo?.hasNextPage && (
          <div className="mt-3 flex justify-center">
            <Button
              size="sm"
              variant="ghost"
              onClick={loadMore}
              disabled={loadingMore}
            >
              {loadingMore ? "Loading…" : "Load more"}
            </Button>
          </div>
        )}
        {editing?.kind === "deposit" && (
          <DepositDialog
            assetId={assetId}
            deposit={editing.deposit}
            defaultCurrency={defaultCurrency}
            onClose={(refresh) => {
              setEditing(null);
              if (refresh) void refetch();
            }}
          />
        )}
        {editing?.kind === "planningTx" && (
          <PlanningTxDialog
            assetId={assetId}
            tx={editing.tx}
            cashAccounts={cashAccounts}
            defaultCurrency={defaultCurrency}
            onClose={(refresh) => {
              setEditing(null);
              if (refresh) void refetch();
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function DepositDialog({
  assetId,
  deposit,
  defaultCurrency,
  onClose,
}: {
  assetId: string;
  deposit: DepositNode | null;
  defaultCurrency: string;
  onClose: (refresh: boolean) => void;
}) {
  const [date, setDate] = useState(
    deposit?.date ?? new Date().toISOString().slice(0, 10),
  );
  const [name, setName] = useState(deposit?.name ?? "");
  const [amount, setAmount] = useState(
    deposit?.amount.amount?.toString() ?? "",
  );
  const currency = deposit?.amount.currency ?? defaultCurrency;

  const [createDeposit, { loading: creating }] = useMutation(
    InvestmentDepositCreateDocument,
    {
      onCompleted: () => {
        toast.success("Deposit added");
        onClose(true);
      },
      onError: (err) => toast.error(err.message),
    },
  );
  const [updateDeposit, { loading: updating }] = useMutation(
    InvestmentDepositUpdateDocument,
    {
      onCompleted: () => {
        toast.success("Deposit updated");
        onClose(true);
      },
      onError: (err) => toast.error(err.message),
    },
  );

  const saving = creating || updating;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const parsed = Number.parseFloat(amount);
    if (!Number.isFinite(parsed)) {
      toast.error("Amount must be a number");
      return;
    }
    if (deposit) {
      void updateDeposit({
        variables: {
          id: deposit.id,
          date,
          name,
          amount: { amount: parsed, currency },
        },
      });
    } else {
      void createDeposit({
        variables: {
          assetId,
          date,
          name,
          amount: { amount: parsed, currency },
        },
      });
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose(false)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {deposit ? "Edit external deposit" : "Add external deposit"}
          </DialogTitle>
          <DialogDescription>
            External cash credit to the wrapper (positive) or debit (negative)
            that doesn't pair with a planning transfer or unit trade — e.g. a
            dividend or pension tax relief.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <Field label="Date">
            <Input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              required
            />
          </Field>
          <Field label="Description">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Q2 dividend"
              required
            />
          </Field>
          <Field label="Amount">
            <Input
              type="number"
              step="0.01"
              currency={currency}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              required
            />
          </Field>
          <DialogActions
            saving={saving}
            saveLabel={deposit ? "Save" : "Add"}
            onCancel={() => onClose(false)}
          />
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PlanningTxDialog({
  assetId,
  tx,
  cashAccounts,
  defaultCurrency,
  onClose,
}: {
  assetId: string;
  tx: PlanningTxNode | null;
  cashAccounts: CashAccountOption[];
  defaultCurrency: string;
  onClose: (refresh: boolean) => void;
}) {
  // Cash transfers anchor to the *month* (the underlying `PlanningTransactions`
  // row stores date = first of the month it lives in). Use a month picker so
  // the user can't accidentally pick a mid-month day that the server would
  // silently round.
  const [month, setMonth] = useState(
    (tx?.date ?? new Date().toISOString().slice(0, 10)).slice(0, 7),
  );
  const [name, setName] = useState(tx?.name ?? "");
  const [amount, setAmount] = useState(tx?.amount.amount?.toString() ?? "");
  const [accountId, setAccountId] = useState(
    tx?.fromAccount.id ?? cashAccounts[0]?.id ?? "",
  );
  const currency = tx?.amount.currency ?? defaultCurrency;

  const [createTx, { loading: creating }] = useMutation(
    AssetPlanningTxCreateDocument,
    {
      onCompleted: () => {
        toast.success("Cash transfer added");
        onClose(true);
      },
      onError: (err) => toast.error(err.message),
    },
  );
  const [updateTx, { loading: updating }] = useMutation(
    AssetPlanningTxUpdateDocument,
    {
      onCompleted: () => {
        toast.success("Cash transfer updated");
        onClose(true);
      },
      onError: (err) => toast.error(err.message),
    },
  );

  const saving = creating || updating;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const parsed = Number.parseFloat(amount);
    if (!Number.isFinite(parsed)) {
      toast.error("Amount must be a number");
      return;
    }
    if (!accountId) {
      toast.error("Pick a cash account");
      return;
    }
    const date = `${month}-01`;
    if (tx) {
      void updateTx({
        variables: {
          id: tx.id,
          date,
          fromAccountId: accountId,
          amount: { amount: parsed, currency },
          name,
        },
      });
    } else {
      void createTx({
        variables: {
          assetId,
          fromAccountId: accountId,
          date,
          amount: { amount: parsed, currency },
          name,
        },
      });
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose(false)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {tx ? "Edit cash transfer" : "Add cash transfer"}
          </DialogTitle>
          <DialogDescription>
            Move cash from one of your planning cash accounts into this wrapper.{" "}
            <strong>Positive</strong> = deposit into the wrapper;
            <strong> negative</strong> = withdrawal back to the cash account.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <Field label="Month">
            <Input
              type="month"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              required
            />
          </Field>
          <Field label="Description">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. April ISA contribution"
              required
            />
          </Field>
          <Field label="From cash account">
            <Select value={accountId} onValueChange={setAccountId}>
              <SelectTrigger>
                <SelectValue placeholder="Pick an account" />
              </SelectTrigger>
              <SelectContent>
                {cashAccounts.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Amount (positive = deposit into wrapper)">
            <Input
              type="number"
              step="0.01"
              currency={currency}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              required
            />
          </Field>
          <DialogActions
            saving={saving}
            saveLabel={tx ? "Save" : "Add"}
            onCancel={() => onClose(false)}
          />
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function DialogActions({
  saving,
  saveLabel,
  onCancel,
}: {
  saving: boolean;
  saveLabel: string;
  onCancel: () => void;
}) {
  return (
    <div className="flex justify-end gap-2 pt-2">
      <Button type="button" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
      <Button type="submit" disabled={saving}>
        {saveLabel}
      </Button>
    </div>
  );
}

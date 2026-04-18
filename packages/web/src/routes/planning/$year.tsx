import { useMutation, useSuspenseQuery } from "@apollo/client/react";
import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { AlertTriangle, Check, Pencil, Plus, Trash2, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Figure, FigureDocument } from "@/components/figure";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/cn";

import {
  type FragmentOf,
  graphql,
  readFragment,
  type ResultOf,
} from "../../graphql";

const PlanningTransactionRowDocument = graphql(
  `
    fragment PlanningTransactionRow on PlanningTransaction {
      id
      name
      isProvisional
      isEditable
      liabilityId
      amount {
        amount
        currency
        ...Figure
      }
    }
  `,
  [FigureDocument],
);

const PlanningMonthAccountCellDocument = graphql(
  `
    fragment PlanningMonthAccountCell on PlanningMonthAccount {
      id
      name
      valueStart {
        ...Figure
      }
      valueEnd {
        ...Figure
      }
      transactions {
        id
        ...PlanningTransactionRow
      }
    }
  `,
  [FigureDocument, PlanningTransactionRowDocument],
);

export const PlanningYearViewDocument = graphql(
  `
    query PlanningYearView($id: ID!) {
      planningYear(id: $id) {
        id
        taxRates {
          __typename
        }
        accounts {
          id
          name
        }
        months {
          id
          date
          accounts {
            id
            ...PlanningMonthAccountCell
          }
        }
      }
      planningYears(last: 9) {
        edges {
          node {
            id
          }
        }
      }
      netWorthCategories(first: 100) {
        edges {
          node {
            __typename
            ... on NetWorthCategoryLiability {
              id
              name
            }
          }
        }
      }
    }
  `,
  [PlanningMonthAccountCellDocument],
);

const TransactionCreateDocument = graphql(`
  mutation PlanningTransactionCreate(
    $monthId: ID!
    $amount: MoneyInput!
    $name: String!
    $fromAccountId: ID!
    $toAccountId: ID
    $liabilityId: ID
  ) {
    transactionCreate(
      monthId: $monthId
      amount: $amount
      name: $name
      fromAccountId: $fromAccountId
      toAccountId: $toAccountId
      liabilityId: $liabilityId
    ) {
      id
    }
  }
`);

const TransactionUpdateDocument = graphql(`
  mutation PlanningTransactionUpdate(
    $monthId: ID!
    $id: ID!
    $amount: MoneyInput
    $name: String
  ) {
    transactionUpdate(
      monthId: $monthId
      id: $id
      amount: $amount
      name: $name
    ) {
      id
    }
  }
`);

const TransactionDeleteDocument = graphql(`
  mutation PlanningTransactionDelete($monthId: ID!, $id: ID!) {
    transactionDelete(monthId: $monthId, id: $id) {
      id
    }
  }
`);

export const Route = createFileRoute("/planning/$year")({
  component: PlanningYearPage,
});

type PlanningYearData = NonNullable<
  ResultOf<typeof PlanningYearViewDocument>["planningYear"]
>;

function PlanningYearPage() {
  const { year } = Route.useParams();
  const { data } = useSuspenseQuery(PlanningYearViewDocument, {
    variables: { id: year },
  });
  if (!data.planningYear) {
    return (
      <main className="mx-auto max-w-3xl space-y-2 p-8">
        <h1 className="text-2xl font-semibold tracking-tight">
          No year {year}
        </h1>
        <p className="text-muted-foreground">
          This planning year hasn't been configured.
        </p>
      </main>
    );
  }
  const allYears = data.planningYears?.edges.map((e) => e.node.id) ?? [];
  const hasTaxRates = data.planningYear.taxRates != null;
  const liabilities: LiabilityOption[] = (data.netWorthCategories?.edges ?? [])
    .map((e) => e.node)
    .filter(
      (n): n is LiabilityOption => n.__typename === "NetWorthCategoryLiability",
    );
  return (
    <main className="flex min-h-svh flex-col">
      <div className="space-y-6 p-8 pb-24">
        <Header year={year} hasTaxRates={hasTaxRates} />
        <PlanningTable
          data={data.planningYear}
          year={year}
          liabilities={liabilities}
        />
      </div>
      <YearFooter current={year} years={allYears} />
      <Outlet />
    </main>
  );
}

type LiabilityOption = Extract<
  NonNullable<
    ResultOf<typeof PlanningYearViewDocument>["netWorthCategories"]
  >["edges"][number]["node"],
  { __typename: "NetWorthCategoryLiability" }
>;

function Header({
  year,
  hasTaxRates,
}: {
  year: string;
  hasTaxRates: boolean;
}) {
  return (
    <div className="flex items-baseline gap-3">
      <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
        Planning · {fyLabel(year)}
        {!hasTaxRates && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Link
                to="/planning/$year/tax-rates"
                params={{ year }}
                aria-label="Tax rates not configured"
                className="text-amber-500 hover:text-amber-600"
              >
                <AlertTriangle className="size-5" />
              </Link>
            </TooltipTrigger>
            <TooltipContent>
              No tax rates set for {fyLabel(year)} — earnings projections are
              disabled until you configure them.
            </TooltipContent>
          </Tooltip>
        )}
      </h1>
      <nav className="ml-auto flex items-center gap-2">
        <Button asChild variant="outline" size="sm">
          <Link to="/planning/$year/accounts" params={{ year }}>
            Manage accounts
          </Link>
        </Button>
        <Button asChild variant="outline" size="sm">
          <Link to="/planning/$year/earnings" params={{ year }}>
            Manage earnings
          </Link>
        </Button>
        <Button asChild variant="outline" size="sm">
          <Link to="/planning/$year/bills" params={{ year }}>
            Manage bills
          </Link>
        </Button>
        <Button asChild variant="outline" size="sm">
          <Link to="/planning/$year/payslips" params={{ year }}>
            Manage payslips
          </Link>
        </Button>
        <Button asChild variant="outline" size="sm">
          <Link to="/planning/$year/tax-rates" params={{ year }}>
            Manage tax rates
          </Link>
        </Button>
      </nav>
    </div>
  );
}

function YearFooter({ current, years }: { current: string; years: string[] }) {
  return (
    <nav className="sticky bottom-0 z-40 border-t bg-background/95 px-4 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <ul className="flex flex-wrap items-center gap-1">
        {years.map((y) => {
          const isCurrent = y === current;
          return (
            <li key={y}>
              <Button
                asChild
                size="sm"
                variant={isCurrent ? "default" : "outline"}
                aria-current={isCurrent ? "page" : undefined}
              >
                <Link to="/planning/$year" params={{ year: y }}>
                  {fyLabelShort(y)}
                </Link>
              </Button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** Full UK FY label: `2026` → `FY2026/27`. Used for the page title. */
function fyLabel(year: string): string {
  const n = Number(year);
  const next = String((n + 1) % 100).padStart(2, "0");
  return `FY${year}/${next}`;
}

/** Compact UK FY label: `2026` → `FY26/27`. Used for year-switcher buttons. */
function fyLabelShort(year: string): string {
  const n = Number(year);
  const start = String(n % 100).padStart(2, "0");
  const next = String((n + 1) % 100).padStart(2, "0");
  return `FY${start}/${next}`;
}

function PlanningTable({
  data,
  year,
  liabilities,
}: {
  data: PlanningYearData;
  year: string;
  liabilities: LiabilityOption[];
}) {
  const accounts = data.accounts;

  // Excel-like: sticky header row, sticky first column, hairline gridlines on
  // every cell border, tabular figures aligned right, dense rows.
  const cellBorder = "border-r border-b border-border";
  const monoRight = "text-right font-mono tabular-nums tracking-tight";

  return (
    <div className="max-h-[calc(100svh-10rem)] overflow-auto rounded-md border bg-background">
      <Table className="border-separate border-spacing-0 text-xs">
        <TableHeader className="bg-muted">
          <TableRow className="hover:bg-muted">
            <TableHead
              className={cn(
                "sticky top-0 left-0 z-30 w-8 min-w-8 max-w-8 bg-muted",
                cellBorder,
              )}
            />
            {accounts.map((a) => (
              <TableHead
                key={a.id}
                className={cn(
                  "sticky top-0 z-20 min-w-56 bg-muted",
                  cellBorder,
                )}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate">{a.name}</span>
                </div>
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.months.map((month, i) => (
            <TableRow key={month.id} className="align-top">
              <TableHead
                scope="row"
                className={cn(
                  "sticky left-0 z-10 w-8 min-w-8 max-w-8 bg-background p-0 text-center align-middle font-medium",
                  cellBorder,
                )}
              >
                <span className="flex h-20 items-center justify-center [writing-mode:vertical-rl] rotate-180 whitespace-nowrap">
                  {formatMonth(month.date)}
                </span>
              </TableHead>
              {accounts.length === 0
                ? // Empty-state CTA: one cell spans the entire body next to the
                  // month column so the grid keeps its shape but stays useful.
                  i === 0 && (
                    <TableCell
                      rowSpan={data.months.length}
                      className={cn(
                        "bg-muted/20 p-8 text-center align-middle",
                        cellBorder,
                      )}
                    >
                      <div className="mx-auto flex max-w-sm flex-col items-center gap-2">
                        <p className="text-sm text-muted-foreground">
                          No planning accounts yet. Add one to start projecting
                          balances across the year.
                        </p>
                        <Button asChild size="sm">
                          <Link
                            to="/planning/$year/accounts"
                            params={{ year: String(data.id) }}
                          >
                            Manage accounts
                          </Link>
                        </Button>
                      </div>
                    </TableCell>
                  )
                : month.accounts.map((cell, j) => (
                    <TableCell
                      key={cell.id}
                      className={cn(
                        // `h-px` is a CSS trick: `height: 1px` on a <td>
                        // doesn't actually shrink the cell (the row still
                        // expands to the tallest content), but it gives the
                        // inner div a concrete base to resolve `h-full`
                        // against — letting the transactions list flex-grow
                        // and pin the end-balance row at the bottom.
                        "h-px min-w-56 p-0",
                        cellBorder,
                      )}
                    >
                      <MonthAccountCell
                        data={cell}
                        monoRight={monoRight}
                        showStart={i === 0}
                        monthId={month.id}
                        year={year}
                        fromAccountId={accounts[j].id}
                        accounts={accounts}
                        liabilities={liabilities}
                      />
                    </TableCell>
                  ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function MonthAccountCell({
  data,
  monoRight,
  showStart,
  monthId,
  year,
  fromAccountId,
  accounts,
  liabilities,
}: {
  data: FragmentOf<typeof PlanningMonthAccountCellDocument>;
  monoRight: string;
  showStart: boolean;
  monthId: string;
  year: string;
  fromAccountId: string;
  accounts: PlanningYearData["accounts"];
  liabilities: LiabilityOption[];
}) {
  const cell = readFragment(PlanningMonthAccountCellDocument, data);
  return (
    <div className="group flex h-full flex-col divide-y divide-border">
      {showStart && (
        <div className="flex items-baseline justify-end bg-muted/30 px-2 py-1">
          <Figure
            data={cell.valueStart}
            className={cn(monoRight, "font-medium")}
          />
        </div>
      )}
      <ul className="flex-1">
        {cell.transactions.length === 0 && (
          <li className="px-2 py-1 text-[10px] text-muted-foreground">—</li>
        )}
        {cell.transactions.map((tx) => (
          <TransactionRow
            key={tx.id}
            data={tx}
            monoRight={monoRight}
            monthId={monthId}
            year={year}
          />
        ))}
        <li className="flex justify-end px-1 py-0.5">
          <CreateTransactionTrigger
            monthId={monthId}
            year={year}
            fromAccountId={fromAccountId}
            accounts={accounts}
            liabilities={liabilities}
          />
        </li>
      </ul>
      <div className="flex items-baseline justify-end bg-muted/30 px-2 py-1">
        <Figure data={cell.valueEnd} className={cn(monoRight, "font-medium")} />
      </div>
    </div>
  );
}

function TransactionRow({
  data,
  monoRight,
  monthId,
  year,
}: {
  data: FragmentOf<typeof PlanningTransactionRowDocument>;
  monoRight: string;
  monthId: string;
  year: string;
}) {
  const tx = readFragment(PlanningTransactionRowDocument, data);
  const [editOpen, setEditOpen] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  const [update] = useMutation(TransactionUpdateDocument, {
    refetchQueries: [
      { query: PlanningYearViewDocument, variables: { id: year } },
    ],
  });
  const [remove] = useMutation(TransactionDeleteDocument, {
    refetchQueries: [
      { query: PlanningYearViewDocument, variables: { id: year } },
    ],
  });

  const onSaveEdit = async (patch: { name: string; amount: number }) => {
    await update({
      variables: {
        monthId,
        id: tx.id,
        name: patch.name,
        amount: { amount: patch.amount, currency: tx.amount.currency },
      },
    });
    toast.success("Saved");
    setEditOpen(false);
  };
  const onDelete = async () => {
    await remove({ variables: { monthId, id: tx.id } });
    toast.success("Deleted");
  };

  return (
    <li
      className={cn(
        "group/row flex items-center gap-1 px-2 py-1",
        tx.isProvisional && "italic text-muted-foreground",
      )}
    >
      <span className="flex-1 truncate">{tx.name}</span>
      <Figure data={tx.amount} className={monoRight} />
      {tx.isEditable && (
        <span
          className={cn(
            "flex items-center gap-0.5 transition-opacity",
            // While delete confirmation is open, keep the icons visible even
            // if the pointer leaves the row — otherwise the confirm button
            // disappears before the user can click it.
            deletePending
              ? "opacity-100"
              : "opacity-0 group-hover/row:opacity-100",
          )}
        >
          {!deletePending && (
            <Popover open={editOpen} onOpenChange={setEditOpen}>
              <PopoverTrigger asChild>
                <IconButton aria-label={`Edit ${tx.name}`}>
                  <Pencil className="size-3" />
                </IconButton>
              </PopoverTrigger>
              <PopoverContent className="w-72" align="end">
                <EditTransactionForm
                  initial={{
                    name: tx.name,
                    amount: Math.abs(tx.amount.amount),
                  }}
                  onSubmit={onSaveEdit}
                  onCancel={() => setEditOpen(false)}
                />
              </PopoverContent>
            </Popover>
          )}
          <InlineDeleteButton
            pending={deletePending}
            onPendingChange={setDeletePending}
            onConfirm={onDelete}
            label={`Delete ${tx.name}`}
          />
        </span>
      )}
    </li>
  );
}

/** Compact ghost-styled button sized to fit inside a dense transaction row. */
function IconButton({
  className,
  ...props
}: React.ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex size-5 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

/** Two-step inline delete: click → morphs into confirm (✓) + cancel (✕).
 * `pending` is lifted so the parent can hide the sibling edit button while
 * the user is deciding, keeping the row's button count stable. */
function InlineDeleteButton({
  pending,
  onPendingChange,
  onConfirm,
  label,
}: {
  pending: boolean;
  onPendingChange: (pending: boolean) => void;
  onConfirm: () => void | Promise<unknown>;
  label: string;
}) {
  if (!pending) {
    return (
      <IconButton onClick={() => onPendingChange(true)} aria-label={label}>
        <Trash2 className="size-3" />
      </IconButton>
    );
  }
  return (
    <>
      <IconButton
        onClick={() => onPendingChange(false)}
        aria-label="Cancel delete"
      >
        <X className="size-3" />
      </IconButton>
      <IconButton
        onClick={async () => {
          onPendingChange(false);
          await onConfirm();
        }}
        aria-label="Confirm delete"
        className="text-destructive hover:text-destructive"
      >
        <Check className="size-3" />
      </IconButton>
    </>
  );
}

function CreateTransactionTrigger({
  monthId,
  year,
  fromAccountId,
  accounts,
  liabilities,
}: {
  monthId: string;
  year: string;
  fromAccountId: string;
  accounts: PlanningYearData["accounts"];
  liabilities: LiabilityOption[];
}) {
  const [open, setOpen] = useState(false);
  const [create] = useMutation(TransactionCreateDocument, {
    refetchQueries: [
      { query: PlanningYearViewDocument, variables: { id: year } },
    ],
  });

  const onSubmit = async (v: {
    name: string;
    amount: number;
    toAccountId: string | null;
    liabilityId: string | null;
  }) => {
    await create({
      variables: {
        monthId,
        fromAccountId,
        name: v.name,
        amount: { amount: v.amount, currency: "GBP" },
        toAccountId: v.toAccountId,
        liabilityId: v.liabilityId,
      },
    });
    toast.success("Transaction added");
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <IconButton
          aria-label="Add transaction"
          className="opacity-0 transition-opacity group-hover:opacity-100"
        >
          <Plus className="size-3" />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent className="w-80" align="end">
        <CreateTransactionForm
          accounts={accounts}
          liabilities={liabilities}
          excludeAccountId={fromAccountId}
          onSubmit={onSubmit}
          onCancel={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  );
}

function EditTransactionForm({
  initial,
  onSubmit,
  onCancel,
}: {
  initial: { name: string; amount: number };
  onSubmit: (v: { name: string; amount: number }) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [amount, setAmount] = useState(String(initial.amount));
  const parsed = Number(amount);
  const disabled =
    !name.trim() || !Number.isFinite(parsed) || parsed <= 0;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (disabled) return;
    await onSubmit({ name: name.trim(), amount: parsed });
  };
  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="space-y-1">
        <Label className="text-xs">Name</Label>
        <Input value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Amount</Label>
        <Input
          type="number"
          inputMode="decimal"
          step="0.01"
          min="0"
          currency="GBP"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={disabled}>
          Save
        </Button>
      </div>
    </form>
  );
}

function CreateTransactionForm({
  accounts,
  liabilities,
  excludeAccountId,
  onSubmit,
  onCancel,
}: {
  accounts: PlanningYearData["accounts"];
  liabilities: LiabilityOption[];
  excludeAccountId: string;
  onSubmit: (v: {
    name: string;
    amount: number;
    toAccountId: string | null;
    liabilityId: string | null;
  }) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [toAccountId, setToAccountId] = useState("__none__");
  const [liabilityId, setLiabilityId] = useState("__none__");
  const parsed = Number(amount);
  const disabled =
    !name.trim() || !Number.isFinite(parsed) || parsed <= 0;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (disabled) return;
    await onSubmit({
      name: name.trim(),
      amount: parsed,
      toAccountId: toAccountId === "__none__" ? null : toAccountId,
      liabilityId: liabilityId === "__none__" ? null : liabilityId,
    });
  };
  const transferTargets = accounts.filter((a) => a.id !== excludeAccountId);
  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="space-y-1">
        <Label className="text-xs">Name</Label>
        <Input
          placeholder="e.g. Rent"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Amount</Label>
        <Input
          type="number"
          inputMode="decimal"
          step="0.01"
          min="0"
          currency="GBP"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Transfer to (optional)</Label>
        <Select value={toAccountId} onValueChange={setToAccountId}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">External outflow</SelectItem>
            {transferTargets.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Pays down liability (optional)</Label>
        <Select value={liabilityId} onValueChange={setLiabilityId}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">None</SelectItem>
            {liabilities.map((l) => (
              <SelectItem key={l.id} value={l.id}>
                {l.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={disabled}>
          Add
        </Button>
      </div>
    </form>
  );
}

function formatMonth(d: string): string {
  return new Date(d).toLocaleDateString(undefined, {
    month: "short",
    year: "numeric",
  });
}

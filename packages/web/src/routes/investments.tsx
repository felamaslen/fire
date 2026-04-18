import { useMutation, useSuspenseQuery } from "@apollo/client/react";
import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { ArrowDown, ArrowUp, Pencil, Plus } from "lucide-react";
import { Suspense, useState } from "react";
import { toast } from "sonner";

import { DeleteButton } from "@/components/delete-button";
import { Figure, FigureDocument } from "@/components/figure";
import {
  InvestmentForm,
  InvestmentFormDocument,
} from "@/components/investments/investment-form";
import { PortfolioSection } from "@/components/investments/portfolio-section";
import { Spinner } from "@/components/spinner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  type FragmentOf,
  graphql,
  readFragment,
  type ResultOf,
  type VariablesOf,
} from "@/graphql";

const InvestmentRowDocument = graphql(
  `
    fragment InvestmentRow on Investment {
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
  `,
  [FigureDocument, InvestmentFormDocument],
);

export const InvestmentsPageDocument = graphql(
  `
    query InvestmentsPage($first: Int, $sort: InvestmentSort) {
      investments(first: $first, sort: $sort) {
        edges {
          node {
            id
            ...InvestmentRow
            ...InvestmentForm
          }
        }
      }
    }
  `,
  [InvestmentRowDocument, InvestmentFormDocument],
);

const InvestmentDeleteDocument = graphql(`
  mutation InvestmentDelete($id: ID!) {
    investmentDelete(id: $id) {
      _
    }
  }
`);

type InvestmentRowNode = NonNullable<
  ResultOf<typeof InvestmentsPageDocument>["investments"]
>["edges"][number]["node"];

export const Route = createFileRoute("/investments")({
  component: InvestmentsDialogLayout,
});

export const investmentsRefetch = [
  { query: InvestmentsPageDocument, variables: { first: 100 } },
];

type SortKind = "createdAt" | "value" | "gainAbs" | "gainPercent";
type SortDirection = "ASC" | "DESC";

function toSortInput(
  kind: SortKind,
  dir: SortDirection,
): VariablesOf<typeof InvestmentsPageDocument>["sort"] {
  if (kind === "createdAt") return null;
  if (kind === "value") return { value: dir };
  if (kind === "gainAbs") return { gainAbs: dir };
  return { gainPercent: dir };
}

function InvestmentsDialogLayout() {
  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Investments</h1>
        <Link
          to="/"
          className="text-sm text-muted-foreground hover:underline"
        >
          ← Home
        </Link>
      </header>
      <PortfolioSection />
      <Suspense fallback={<Spinner />}>
        <InvestmentsList />
      </Suspense>
      <Outlet />
    </main>
  );
}

function InvestmentsList() {
  const [sort, setSort] = useState<{ kind: SortKind; dir: SortDirection }>({
    kind: "createdAt",
    dir: "DESC",
  });
  const [hideSold, setHideSold] = useState(true);

  const { data } = useSuspenseQuery(InvestmentsPageDocument, {
    variables: { first: 100, sort: toSortInput(sort.kind, sort.dir) },
  });
  const allRows: InvestmentRowNode[] =
    data.investments?.edges.map((e) => e.node) ?? [];
  const rows = hideSold
    ? allRows.filter((r) => {
        const u = readFragment(InvestmentRowDocument, r).position.units;
        return u !== 0;
      })
    : allRows;

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<InvestmentRowNode | null>(null);

  const toggle = (kind: SortKind) => {
    setSort((s) =>
      s.kind === kind
        ? { kind, dir: s.dir === "ASC" ? "DESC" : "ASC" }
        : { kind, dir: "DESC" },
    );
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={hideSold}
            onChange={(e) => setHideSold(e.target.checked)}
            className="accent-foreground"
          />
          Hide sold (zero-unit) investments
        </label>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="mr-1 h-4 w-4" /> New investment
        </Button>
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No investments yet. Create one to get started.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Ticker / link</TableHead>
              <TableHead className="text-right">Units</TableHead>
              <TableHead className="text-right">
                <SortHeader
                  label="Value"
                  kind="value"
                  sort={sort}
                  onToggle={toggle}
                />
              </TableHead>
              <TableHead className="text-right">
                <SortHeader
                  label="Gain"
                  kind="gainAbs"
                  sort={sort}
                  onToggle={toggle}
                />
              </TableHead>
              <TableHead className="text-right">
                <SortHeader
                  label="%"
                  kind="gainPercent"
                  sort={sort}
                  onToggle={toggle}
                />
              </TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <InvestmentRow
                key={row.id}
                data={row}
                onEdit={() => setEditing(row)}
              />
            ))}
          </TableBody>
        </Table>
      )}

      <InvestmentFormDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        existing={null}
      />
      <InvestmentFormDialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        existing={editing}
      />
    </div>
  );
}

function SortHeader({
  label,
  kind,
  sort,
  onToggle,
}: {
  label: string;
  kind: SortKind;
  sort: { kind: SortKind; dir: SortDirection };
  onToggle: (kind: SortKind) => void;
}) {
  const active = sort.kind === kind;
  return (
    <button
      type="button"
      onClick={() => onToggle(kind)}
      className="inline-flex items-center gap-1 hover:text-foreground"
    >
      {label}
      {active ? (
        sort.dir === "ASC" ? (
          <ArrowUp className="h-3 w-3" />
        ) : (
          <ArrowDown className="h-3 w-3" />
        )
      ) : null}
    </button>
  );
}

function InvestmentFormDialog({
  open,
  onClose,
  existing,
}: {
  open: boolean;
  onClose: () => void;
  existing: FragmentOf<typeof InvestmentFormDocument> | null;
}) {
  const unmasked = existing ? readFragment(InvestmentFormDocument, existing) : null;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {unmasked ? `Edit ${unmasked.name}` : "New investment"}
          </DialogTitle>
        </DialogHeader>
        <InvestmentForm
          existing={unmasked}
          onDone={onClose}
          refetchQueries={investmentsRefetch}
        />
      </DialogContent>
    </Dialog>
  );
}

function InvestmentRow({
  data,
  onEdit,
}: {
  data: FragmentOf<typeof InvestmentRowDocument>;
  onEdit: () => void;
}) {
  const inv = readFragment(InvestmentRowDocument, data);
  const [remove] = useMutation(InvestmentDeleteDocument, {
    refetchQueries: investmentsRefetch,
    awaitRefetchQueries: true,
    onCompleted: () => toast.success("Investment deleted"),
    onError: (err) => toast.error(err.message),
  });

  return (
    <TableRow>
      <TableCell>
        <Link
          to="/investments/$id"
          params={{ id: inv.id }}
          className="font-medium hover:underline"
        >
          {inv.name}
        </Link>
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {inv.asset.__typename === "InvestmentStock"
          ? inv.asset.code
          : inv.asset.__typename === "InvestmentFund"
            ? new URL(inv.asset.url).hostname
            : ""}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {inv.position.units}
      </TableCell>
      <TableCell className="text-right">
        {inv.position.totalValue ? (
          <Figure data={inv.position.totalValue} />
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="text-right">
        {inv.position.totalGain ? (
          <Figure data={inv.position.totalGain} />
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {inv.position.percentGain == null
          ? "—"
          : `${(inv.position.percentGain * 100).toFixed(2)}%`}
      </TableCell>
      <TableCell className="w-0">
        <div className="flex items-center gap-1">
          <Button size="icon" variant="ghost" onClick={onEdit}>
            <Pencil className="h-4 w-4" />
          </Button>
          <DeleteButton
            onConfirm={() => remove({ variables: { id: inv.id } })}
          />
        </div>
      </TableCell>
    </TableRow>
  );
}

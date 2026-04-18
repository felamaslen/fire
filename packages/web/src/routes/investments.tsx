import { useMutation, useSuspenseQuery } from "@apollo/client/react";
import {
  createFileRoute,
  Link,
  Outlet,
  useNavigate,
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
    query InvestmentsPage($first: Int) {
      investments(first: $first) {
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

export const investmentsRefetch = [{ query: InvestmentsPageDocument }];

function InvestmentsDialogLayout() {
  const navigate = useNavigate();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) void navigate({ to: "/" });
      }}
    >
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>Investments</DialogTitle>
        </DialogHeader>
        <PortfolioSection />
        <Suspense fallback={<Spinner />}>
          <InvestmentsList />
        </Suspense>
        <Outlet />
      </DialogContent>
    </Dialog>
  );
}

function InvestmentsList() {
  const { data } = useSuspenseQuery(InvestmentsPageDocument, {
    variables: { first: 100 },
  });
  const rows: InvestmentRowNode[] =
    data.investments?.edges.map((e) => e.node) ?? [];

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<InvestmentRowNode | null>(null);

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
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
              <TableHead className="text-right">Value</TableHead>
              <TableHead className="text-right">Gain</TableHead>
              <TableHead className="text-right">%</TableHead>
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

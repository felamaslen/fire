import { useSuspenseQuery } from "@apollo/client/react";
import {
  createFileRoute,
  Link,
  Outlet,
  useNavigate,
} from "@tanstack/react-router";
import { Suspense } from "react";

import { Figure, FigureDocument } from "@/components/figure";
import { Spinner } from "@/components/spinner";
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
    }
  `,
  [FigureDocument],
);

export const InvestmentsPageDocument = graphql(
  `
    query InvestmentsPage($first: Int) {
      investments(first: $first) {
        edges {
          node {
            id
            ...InvestmentRow
          }
        }
      }
    }
  `,
  [InvestmentRowDocument],
);

type InvestmentRowNode = NonNullable<
  ResultOf<typeof InvestmentsPageDocument>["investments"]
>["edges"][number]["node"];

export const Route = createFileRoute("/investments")({
  component: InvestmentsDialogLayout,
});

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

  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No investments yet. Create one to get started.
      </p>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Ticker / link</TableHead>
          <TableHead className="text-right">Units</TableHead>
          <TableHead className="text-right">Value</TableHead>
          <TableHead className="text-right">Gain</TableHead>
          <TableHead className="text-right">%</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <InvestmentRow key={row.id} data={row} />
        ))}
      </TableBody>
    </Table>
  );
}

function InvestmentRow({ data }: { data: FragmentOf<typeof InvestmentRowDocument> }) {
  const inv = readFragment(InvestmentRowDocument, data);
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
    </TableRow>
  );
}

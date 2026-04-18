import { useSuspenseQuery } from "@apollo/client/react";
import { createFileRoute, Link } from "@tanstack/react-router";

import { Figure, FigureDocument } from "@/components/figure";
import { Button } from "@/components/ui/button";
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

const PlanningYearViewDocument = graphql(
  `
    query PlanningYearView($id: ID!) {
      planningYear(id: $id) {
        id
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
      planningYears {
        edges {
          node {
            id
          }
        }
      }
    }
  `,
  [PlanningMonthAccountCellDocument],
);

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
  return (
    <main className="space-y-6 p-8">
      <Header
        year={year}
        allYears={data.planningYears?.edges.map((e) => e.node) ?? []}
      />
      <PlanningTable data={data.planningYear} />
    </main>
  );
}

function Header({
  year,
  allYears,
}: {
  year: string;
  allYears: { id: string }[];
}) {
  const years = [...allYears.map((y) => y.id)].sort();
  const idx = years.indexOf(year);
  const prev = idx > 0 ? years[idx - 1] : null;
  const next = idx >= 0 && idx < years.length - 1 ? years[idx + 1] : null;
  return (
    <div className="flex items-baseline gap-3">
      <h1 className="text-2xl font-semibold tracking-tight">
        Planning · FY {year}
      </h1>
      <nav className="ml-auto flex items-center gap-1">
        {prev && (
          <Button asChild variant="outline" size="sm">
            <Link to="/planning/$year" params={{ year: prev }}>
              ← {prev}
            </Link>
          </Button>
        )}
        {next && (
          <Button asChild variant="outline" size="sm">
            <Link to="/planning/$year" params={{ year: next }}>
              {next} →
            </Link>
          </Button>
        )}
      </nav>
    </div>
  );
}

function PlanningTable({ data }: { data: PlanningYearData }) {
  const accounts = data.accounts;

  if (accounts.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No planning accounts assigned yet. Assign assets via{" "}
        <code>planningAccountAssign</code> to see them here.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="bg-muted/50">
            <th className="sticky left-0 z-10 bg-muted/50 px-3 py-2 text-left font-medium">
              Month
            </th>
            {accounts.map((a) => (
              <th
                key={a.id}
                className="min-w-64 px-3 py-2 text-left font-medium"
              >
                {a.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.months.map((month) => (
            <tr key={month.id} className="border-t align-top">
              <th className="sticky left-0 z-10 bg-background px-3 py-2 text-left font-medium">
                {formatMonth(month.date)}
              </th>
              {month.accounts.map((cell) => (
                <td key={cell.id} className="border-l px-3 py-2">
                  <MonthAccountCell data={cell} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MonthAccountCell({
  data,
}: {
  data: FragmentOf<typeof PlanningMonthAccountCellDocument>;
}) {
  const cell = readFragment(PlanningMonthAccountCellDocument, data);
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
        <span>Start</span>
        <Figure data={cell.valueStart} className="tabular-nums" />
      </div>
      <ul className="space-y-0.5">
        {cell.transactions.length === 0 && (
          <li className="text-xs text-muted-foreground">—</li>
        )}
        {cell.transactions.map((tx) => (
          <TransactionRow key={tx.id} data={tx} />
        ))}
      </ul>
      <div className="flex items-baseline justify-between gap-2 border-t pt-1 text-xs font-medium">
        <span>End</span>
        <Figure data={cell.valueEnd} className="tabular-nums" />
      </div>
    </div>
  );
}

function TransactionRow({
  data,
}: {
  data: FragmentOf<typeof PlanningTransactionRowDocument>;
}) {
  const tx = readFragment(PlanningTransactionRowDocument, data);
  return (
    <li
      className={cn(
        "flex items-baseline justify-between gap-2 text-xs",
        tx.isProvisional && "italic text-muted-foreground",
      )}
    >
      <span className="truncate">{tx.name}</span>
      <Figure data={tx.amount} className="tabular-nums" />
    </li>
  );
}

function formatMonth(d: string): string {
  return new Date(d).toLocaleDateString(undefined, {
    month: "short",
    year: "numeric",
  });
}

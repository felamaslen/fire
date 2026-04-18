import { useSuspenseQuery } from "@apollo/client/react";
import { createFileRoute, Link, Outlet } from "@tanstack/react-router";

import { Figure, FigureDocument } from "@/components/figure";
import { Button } from "@/components/ui/button";
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
  const allYears = data.planningYears?.edges.map((e) => e.node.id) ?? [];
  return (
    <main className="flex min-h-svh flex-col">
      <div className="space-y-6 p-8 pb-24">
        <Header year={year} />
        <PlanningTable data={data.planningYear} />
      </div>
      <YearFooter current={year} years={allYears} />
      <Outlet />
    </main>
  );
}

function Header({ year }: { year: string }) {
  return (
    <div className="flex items-baseline gap-3">
      <h1 className="text-2xl font-semibold tracking-tight">
        Planning · {fyLabel(year)}
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

function PlanningTable({ data }: { data: PlanningYearData }) {
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
                : month.accounts.map((cell) => (
                    <TableCell
                      key={cell.id}
                      className={cn("min-w-56 p-0", cellBorder)}
                    >
                      <MonthAccountCell data={cell} monoRight={monoRight} />
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
}: {
  data: FragmentOf<typeof PlanningMonthAccountCellDocument>;
  monoRight: string;
}) {
  const cell = readFragment(PlanningMonthAccountCellDocument, data);
  return (
    <div className="divide-y divide-border">
      <ul>
        {cell.transactions.length === 0 && (
          <li className="px-2 py-1 text-[10px] text-muted-foreground">—</li>
        )}
        {cell.transactions.map((tx) => (
          <TransactionRow key={tx.id} data={tx} monoRight={monoRight} />
        ))}
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
}: {
  data: FragmentOf<typeof PlanningTransactionRowDocument>;
  monoRight: string;
}) {
  const tx = readFragment(PlanningTransactionRowDocument, data);
  return (
    <li
      className={cn(
        "flex items-baseline justify-between gap-2 px-2 py-1",
        tx.isProvisional && "italic text-muted-foreground",
      )}
    >
      <span className="truncate">{tx.name}</span>
      <Figure data={tx.amount} className={monoRight} />
    </li>
  );
}

function formatMonth(d: string): string {
  return new Date(d).toLocaleDateString(undefined, {
    month: "short",
    year: "numeric",
  });
}

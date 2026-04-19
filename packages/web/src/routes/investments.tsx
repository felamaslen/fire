import { useMutation, useQuery, useSuspenseQuery } from "@apollo/client/react";
import {
  createFileRoute,
  Link,
  Outlet,
  useNavigate,
} from "@tanstack/react-router";
import { ArrowDown, ArrowUp, ExternalLink, Pencil, Plus } from "lucide-react";
import { Suspense, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";

import { DeleteButton } from "@/components/delete-button";
import { Figure, FigureDocument } from "@/components/figure";
import {
  InvestmentForm,
  InvestmentFormDocument,
} from "@/components/investments/investment-form";
import {
  PortfolioHeadline,
  PortfolioHeadlineFragment,
} from "@/components/investments/portfolio-headline";
import {
  PortfolioChartPortfolioFragment,
  type PortfolioChartSettings,
  PortfolioSection,
} from "@/components/investments/portfolio-section";
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
import { cn } from "@/lib/cn";

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
          amount
          ...Figure
        }
        percentGain
      }
      ...InvestmentForm
    }
  `,
  [FigureDocument, InvestmentFormDocument],
);

export const InvestmentsListDocument = graphql(
  `
    query InvestmentsList($first: Int, $sort: InvestmentSort) {
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

// Combined document fired once on initial page load — prewarms the Apollo
// cache so each child's own `useQuery` renders synchronously without a
// per-widget spinner. Each child keeps its own document for refreshes
// (headline polling, chart period/mode changes, list sort changes).
const InvestmentsPageDocument = graphql(
  `
    query InvestmentsPage(
      $first: Int
      $sort: InvestmentSort
      $period: PortfolioTimePeriod!
      $length: Int
      $candlestick: Boolean!
      $skipLive: Boolean!
    ) {
      investments(first: $first, sort: $sort) {
        edges {
          node {
            id
            ...InvestmentRow
            ...InvestmentForm
          }
        }
      }
      portfolio {
        ...PortfolioHeadline
        ...PortfolioChartPortfolio
      }
      portfolios @skip(if: $candlestick) {
        edges {
          node {
            id
            investment {
              id
              name
            }
            timeseries(period: $period, length: $length) {
              initialDate
              points {
                x
                y
              }
            }
          }
        }
      }
    }
  `,
  [
    InvestmentRowDocument,
    InvestmentFormDocument,
    PortfolioHeadlineFragment,
    PortfolioChartPortfolioFragment,
  ],
);

const InvestmentDeleteDocument = graphql(`
  mutation InvestmentDelete($id: ID!) {
    investmentDelete(id: $id) {
      _
    }
  }
`);

type InvestmentRowNode = NonNullable<
  ResultOf<typeof InvestmentsListDocument>["investments"]
>["edges"][number]["node"];

type SortKind = "createdAt" | "value" | "gainAbs" | "gainPercent";
type SortDirection = "ASC" | "DESC";
type SortState = { kind: SortKind; dir: SortDirection };

const RANGES = ["5y", "3y", "1y", "ytd", "3m"] as const;
type Range = (typeof RANGES)[number];

const investmentsSearchSchema = z.object({
  range: z.enum(RANGES).optional().catch(undefined),
  mode: z.enum(["line", "candle"]).optional().catch(undefined),
  stack: z.coerce.boolean().optional().catch(undefined),
  sort: z.enum(["value", "gainAbs", "gainPercent"]).optional().catch(undefined),
  dir: z.enum(["asc", "desc"]).optional().catch(undefined),
});

type InvestmentsSearch = z.infer<typeof investmentsSearchSchema>;

const SEARCH_STORAGE_KEY = "fire.investments.search";

export const Route = createFileRoute("/investments")({
  component: InvestmentsDialogLayout,
  validateSearch: investmentsSearchSchema,
});

export const investmentsRefetch = [
  { query: InvestmentsListDocument, variables: { first: 100 } },
];

function toSortInput(
  kind: SortKind,
  dir: SortDirection,
): VariablesOf<typeof InvestmentsListDocument>["sort"] {
  if (kind === "createdAt") return null;
  if (kind === "value") return { value: dir };
  if (kind === "gainAbs") return { gainAbs: dir };
  return { gainPercent: dir };
}

function rangeToPeriod(r: Range): {
  period: "YEAR" | "MONTH" | "YTD";
  length: number | null;
} {
  switch (r) {
    case "5y":
      return { period: "YEAR", length: 5 };
    case "3y":
      return { period: "YEAR", length: 3 };
    case "1y":
      return { period: "YEAR", length: 1 };
    case "ytd":
      return { period: "YTD", length: null };
    case "3m":
      return { period: "MONTH", length: 3 };
  }
}

function searchToChart(s: InvestmentsSearch): PortfolioChartSettings {
  const range = s.range ?? "5y";
  return {
    periodIdx: RANGES.indexOf(range),
    mode: s.mode === "candle" ? "candlestick" : "line",
    stack: s.stack ?? false,
  };
}

function chartToSearch(
  c: PortfolioChartSettings,
): Pick<InvestmentsSearch, "range" | "mode" | "stack"> {
  const range = RANGES[c.periodIdx] ?? "5y";
  return {
    range: range === "5y" ? undefined : range,
    mode: c.mode === "candlestick" ? "candle" : undefined,
    stack: c.stack ? true : undefined,
  };
}

function searchToSort(s: InvestmentsSearch): SortState {
  const kind: SortKind = s.sort ?? "createdAt";
  const dir: SortDirection = s.dir === "asc" ? "ASC" : "DESC";
  return { kind, dir };
}

function sortToSearch(
  state: SortState,
): Pick<InvestmentsSearch, "sort" | "dir"> {
  if (state.kind === "createdAt") return { sort: undefined, dir: undefined };
  return {
    sort: state.kind,
    dir: state.dir === "ASC" ? "asc" : "desc",
  };
}

function hasAnySearch(s: InvestmentsSearch): boolean {
  return Object.values(s).some((v) => v !== undefined);
}

function loadPersistedSearch(): InvestmentsSearch {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(SEARCH_STORAGE_KEY);
    if (!raw) return {};
    return investmentsSearchSchema.parse(JSON.parse(raw));
  } catch {
    return {};
  }
}

function InvestmentsDialogLayout() {
  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Investments</h1>
        <Link to="/" className="text-sm text-muted-foreground hover:underline">
          ← Home
        </Link>
      </header>
      <Suspense fallback={<Spinner />}>
        <InvestmentsPageContent />
      </Suspense>
      <Outlet />
    </main>
  );
}

// All persisted UI options (chart period/mode/stack, sort) live in the URL
// search params. On first mount, if the URL is empty, hydrate from
// localStorage and `replace` into the URL so it reflects current state.
// Any URL-driven change gets mirrored back to localStorage.
function InvestmentsPageContent() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  // Bootstrap: captured once — used to seed URL + freeze initial query vars.
  const [bootstrap] = useState<InvestmentsSearch>(() =>
    hasAnySearch(search) ? search : loadPersistedSearch(),
  );

  useEffect(() => {
    if (!hasAnySearch(search) && hasAnySearch(bootstrap)) {
      void navigate({ search: bootstrap, replace: true });
      return;
    }
    window.localStorage.setItem(SEARCH_STORAGE_KEY, JSON.stringify(search));
  }, [search, bootstrap, navigate]);

  const effective = hasAnySearch(search) ? search : bootstrap;
  const chart = searchToChart(effective);
  const sort = searchToSort(effective);

  const setChart = (next: PortfolioChartSettings) => {
    const patch = chartToSearch(next);
    void navigate({
      search: (prev) => ({ ...prev, ...patch }),
      replace: true,
    });
  };
  const setSort = (next: SortState) => {
    const patch = sortToSearch(next);
    void navigate({
      search: (prev) => ({ ...prev, ...patch }),
      replace: true,
    });
  };

  // Freeze the initial suspense-query variables so later set* calls don't
  // re-suspend the page — children refetch via their own `useQuery`.
  const [initialVars] = useState(() => {
    const c = searchToChart(bootstrap);
    const s = searchToSort(bootstrap);
    const { period, length } = rangeToPeriod(RANGES[c.periodIdx] ?? "5y");
    return {
      first: 100,
      sort: toSortInput(s.kind, s.dir),
      period,
      length,
      candlestick: c.mode === "candlestick",
      skipLive: true,
    };
  });
  useSuspenseQuery(InvestmentsPageDocument, { variables: initialVars });

  return (
    <>
      <PortfolioHeadline />
      <PortfolioSection settings={chart} onChange={setChart} />
      <InvestmentsList sort={sort} onSortChange={setSort} />
    </>
  );
}

function InvestmentsList({
  sort,
  onSortChange,
}: {
  sort: SortState;
  onSortChange: (next: SortState) => void;
}) {
  const setSort = (updater: (prev: SortState) => SortState) =>
    onSortChange(updater(sort));
  const [hideSold, setHideSold] = useHideSold();

  const { data, previousData, loading } = useQuery(InvestmentsListDocument, {
    variables: { first: 100, sort: toSortInput(sort.kind, sort.dir) },
    notifyOnNetworkStatusChange: true,
  });
  const current = data ?? previousData;
  const allRows: InvestmentRowNode[] =
    current?.investments?.edges.map((e) => e.node) ?? [];
  const rows = hideSold
    ? allRows.filter((r) => {
        const u = readFragment(InvestmentRowDocument, r).position.units;
        return u !== 0;
      })
    : allRows;

  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = useState(false);

  const toggle = (kind: SortKind) => {
    setSort((s) =>
      s.kind === kind
        ? { kind, dir: s.dir === "ASC" ? "DESC" : "ASC" }
        : { kind, dir: "DESC" },
    );
  };

  return (
    <div
      className={cn(
        "space-y-3 transition-opacity",
        loading && "pointer-events-none opacity-50",
      )}
    >
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
              <TableHead>Ticker</TableHead>
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
            {rows.map((row) => {
              const id = readFragment(InvestmentRowDocument, row).id;
              return (
                <InvestmentRow
                  key={row.id}
                  data={row}
                  onEdit={() =>
                    void navigate({
                      to: "/investments/$id",
                      params: { id },
                    })
                  }
                />
              );
            })}
          </TableBody>
        </Table>
      )}

      <InvestmentFormDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
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
      className="inline-flex cursor-pointer items-center gap-1 hover:text-foreground"
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
}: {
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New investment</DialogTitle>
        </DialogHeader>
        <InvestmentForm
          existing={null}
          onDone={onClose}
          refetchQueries={investmentsRefetch}
        />
      </DialogContent>
    </Dialog>
  );
}

const HIDE_SOLD_STORAGE_KEY = "fire.investments.hideSold";

function useHideSold(): [boolean, (v: boolean) => void] {
  const [hideSold, setHideSoldState] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    const raw = window.sessionStorage.getItem(HIDE_SOLD_STORAGE_KEY);
    return raw === null ? true : raw === "1";
  });
  useEffect(() => {
    window.sessionStorage.setItem(HIDE_SOLD_STORAGE_KEY, hideSold ? "1" : "0");
  }, [hideSold]);
  const setHideSold = useCallback((v: boolean) => setHideSoldState(v), []);
  return [hideSold, setHideSold];
}

function gainSignColor(amount: number | null | undefined): string {
  if (amount == null || amount === 0) return "";
  return amount > 0
    ? "text-sky-600 dark:text-sky-400"
    : "text-red-600 dark:text-red-400";
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
  const gainColor = gainSignColor(inv.position.totalGain?.amount);

  return (
    <TableRow>
      <TableCell className="font-medium align-middle">
        <span className="inline-flex items-center gap-1.5">
          {inv.name}
          {inv.asset.__typename === "InvestmentFund" && (
            <a
              href={inv.asset.url}
              target="_blank"
              rel="noreferrer noopener"
              className="text-muted-foreground hover:text-foreground"
              aria-label="Open fund page"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
        </span>
      </TableCell>
      <TableCell className="text-xs text-muted-foreground align-middle">
        {inv.asset.__typename === "InvestmentStock" ? inv.asset.code : ""}
      </TableCell>
      <TableCell className="text-right tabular-nums align-middle">
        {inv.position.units}
      </TableCell>
      <TableCell className="text-right align-middle">
        {inv.position.totalValue ? (
          <Figure data={inv.position.totalValue} compact />
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className={cn("text-right align-middle", gainColor)}>
        {inv.position.totalGain ? (
          <Figure data={inv.position.totalGain} compact />
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell
        className={cn("text-right tabular-nums align-middle", gainColor)}
      >
        {inv.position.percentGain == null
          ? "—"
          : `${(inv.position.percentGain * 100).toFixed(2)}%`}
      </TableCell>
      <TableCell className="w-0 align-middle">
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

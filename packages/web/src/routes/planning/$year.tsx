import { useMutation, useQuery, useSuspenseQuery } from "@apollo/client/react";
import {
  createFileRoute,
  Link,
  Outlet,
  useNavigate,
} from "@tanstack/react-router";
import { isSameMonth } from "date-fns/isSameMonth";
import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  Briefcase,
  ChartCandlestick,
  Check,
  ChevronLeft,
  ChevronRight,
  CreditCard,
  HandCoins,
  Landmark,
  Pencil,
  PiggyBank,
  Plus,
  Scale,
  ScrollText,
  Trash2,
  X,
} from "lucide-react";
import {
  Suspense,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react";
import { toast } from "sonner";

import { Figure, FigureDocument } from "@/components/figure";
import { NavHeaderActions, NavHeaderTitle } from "@/components/nav-header";
import { Spinner } from "@/components/spinner";
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
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
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
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { useToday } from "@/lib/use-today";

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
      isBill
      isPayslipGross
      toAccount {
        id
      }
      fromAccount {
        id
      }
      liability {
        id
        type
      }
      asset {
        id
        type
      }
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
      valueStartProvisional
      valueEnd {
        ...Figure
      }
      valueEndProvisional
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
            ... on NetWorthCategoryAsset {
              id
              name
              assetType: type
            }
          }
        }
      }
    }
  `,
  [PlanningMonthAccountCellDocument],
);

/** Windowed list of planning years for the bottom navigation footer. The
 * main `PlanningYearView` suspense query selects the first window (`last: 9`)
 * with the same args, so first-render is a cache hit; left / right clicks
 * then re-read via this non-suspense query with a different `before` cursor
 * so pagination doesn't re-suspend the whole page. */
const PlanningYearsFooterDocument = graphql(`
  query PlanningYearsFooter($last: Int!, $before: ID) {
    planningYears(last: $last, before: $before) {
      edges {
        node {
          id
        }
      }
      pageInfo {
        hasPreviousPage
        startCursor
      }
    }
  }
`);

/** Frequently-used liability and asset categories for a given planning
 * account — used to surface a "Frequently used" section on top of the plain
 * alphabetical dropdown in the create-transaction popover. Fetched lazily
 * when the user opens a popover so the main grid query stays minimal and
 * the counts re-read whenever a popover reopens. */
const PlanningFrequentTargetsDocument = graphql(`
  query PlanningFrequentTargets($accountId: ID!) {
    transactionLiabilitiesFrequent(accountId: $accountId) {
      id
    }
    transactionAssetsFrequent(accountId: $accountId) {
      id
    }
  }
`);

const TransactionCreateDocument = graphql(`
  mutation PlanningTransactionCreate(
    $monthId: ID!
    $amount: MoneyInput!
    $name: String!
    $accountId: ID!
    $toAccountId: ID
    $liabilityId: ID
    $assetId: ID
  ) {
    transactionCreate(
      monthId: $monthId
      amount: $amount
      name: $name
      accountId: $accountId
      toAccountId: $toAccountId
      liabilityId: $liabilityId
      assetId: $assetId
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
    $toAccountId: ID
    $liabilityId: ID
    $assetId: ID
  ) {
    transactionUpdate(
      monthId: $monthId
      id: $id
      amount: $amount
      name: $name
      toAccountId: $toAccountId
      liabilityId: $liabilityId
      assetId: $assetId
    ) {
      id
    }
  }
`);

const TransactionDeleteDocument = graphql(`
  mutation PlanningTransactionDelete($monthId: ID!, $id: ID!) {
    transactionDelete(monthId: $monthId, id: $id) {
      _
    }
  }
`);

export const Route = createFileRoute("/planning/$year")({
  component: PlanningYearRoute,
});

function PlanningYearRoute() {
  const { year } = Route.useParams();
  return (
    <main className="flex min-h-svh flex-col">
      <Suspense
        fallback={
          <div className="flex flex-1 items-center justify-center">
            <Spinner />
          </div>
        }
      >
        <PlanningYearPage year={year} />
      </Suspense>
      <YearFooter current={year} />
      <Suspense fallback={null}>
        <Outlet />
      </Suspense>
    </main>
  );
}

type PlanningYearData = NonNullable<
  ResultOf<typeof PlanningYearViewDocument>["planningYear"]
>;

function PlanningYearPage({ year }: { year: string }) {
  // Defer the query variable so re-rendering the grid for a new year happens
  // at low priority. Without this, Apollo treats the variable change as an
  // urgent update and React commits the full table re-render synchronously
  // (~700ms in dev for a cache-to-cache switch). With `useDeferredValue` the
  // old grid keeps rendering instantly, and the new one is built concurrently
  // across frames — keeping the main thread responsive.
  const deferredYear = useDeferredValue(year);
  const { data } = useSuspenseQuery(PlanningYearViewDocument, {
    variables: { id: deferredYear },
  });
  const isStale = deferredYear !== year;
  if (!data.planningYear) {
    return (
      <div className="mx-auto max-w-3xl space-y-2 p-8">
        <h1 className="text-2xl font-semibold tracking-tight">
          No year {deferredYear}
        </h1>
        <p className="text-muted-foreground">
          This planning year hasn't been configured.
        </p>
      </div>
    );
  }
  const hasTaxRates = data.planningYear.taxRates != null;
  const liabilities: LiabilityOption[] = (data.netWorthCategories?.edges ?? [])
    .map((e) => e.node)
    .filter(
      (n): n is LiabilityOption => n.__typename === "NetWorthCategoryLiability",
    );
  // Only STOCK / PENSION assets can receive investment transactions — other
  // types (cash, property, etc.) aren't investable and would be rejected by
  // the server.
  const investableAssets: AssetOption[] = (data.netWorthCategories?.edges ?? [])
    .map((e) => e.node)
    .filter(
      (n): n is AssetOption =>
        n.__typename === "NetWorthCategoryAsset" &&
        (n.assetType === "STOCK" || n.assetType === "PENSION"),
    );
  return (
    <div
      className={cn(
        "flex-1 space-y-6 p-8 pb-24 transition-opacity",
        isStale && "pointer-events-none opacity-50",
      )}
    >
      <Header year={deferredYear} hasTaxRates={hasTaxRates} />
      <PlanningTable
        data={data.planningYear}
        year={deferredYear}
        liabilities={liabilities}
        investableAssets={investableAssets}
      />
    </div>
  );
}

type LiabilityOption = Extract<
  NonNullable<
    ResultOf<typeof PlanningYearViewDocument>["netWorthCategories"]
  >["edges"][number]["node"],
  { __typename: "NetWorthCategoryLiability" }
>;

type AssetOption = Extract<
  NonNullable<
    ResultOf<typeof PlanningYearViewDocument>["netWorthCategories"]
  >["edges"][number]["node"],
  { __typename: "NetWorthCategoryAsset" }
>;

function Header({ year, hasTaxRates }: { year: string; hasTaxRates: boolean }) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [pageTitleVisible, setPageTitleVisible] = useState(true);
  useEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => setPageTitleVisible(entry.isIntersecting),
      // Shrink the intersection root from the top by the `NavHeader`'s height
      // so the title is treated as "hidden" once it slips behind the sticky
      // app header, not only when it leaves the viewport entirely.
      { rootMargin: "-48px 0px 0px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <>
      <h1
        ref={titleRef}
        className="flex items-center gap-2 text-2xl font-semibold tracking-tight"
      >
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
      {!pageTitleVisible && (
        <NavHeaderTitle>
          <span className="text-sm font-semibold tracking-tight">
            Planning · {fyLabel(year)}
          </span>
        </NavHeaderTitle>
      )}
      <NavHeaderActions>
        <ManageIconLink
          to="/planning/$year/accounts"
          year={year}
          label="Manage accounts"
          icon={<PiggyBank className="size-6" />}
        />
        <ManageIconLink
          to="/planning/$year/earnings"
          year={year}
          label="Manage earnings"
          icon={<Briefcase className="size-6" />}
        />
        <ManageIconLink
          to="/planning/$year/payslips"
          year={year}
          label="Manage payslips"
          icon={<HandCoins className="size-6" />}
        />
        <ManageIconLink
          to="/planning/$year/bills"
          year={year}
          label="Manage bills"
          icon={<ScrollText className="size-6" />}
        />
        <ManageIconLink
          to="/planning/$year/tax-rates"
          year={year}
          label="Manage tax rates"
          icon={<Scale className="size-6" />}
        />
      </NavHeaderActions>
    </>
  );
}

type ManageRoute =
  | "/planning/$year/accounts"
  | "/planning/$year/earnings"
  | "/planning/$year/bills"
  | "/planning/$year/payslips"
  | "/planning/$year/tax-rates";

function ManageIconLink({
  to,
  year,
  label,
  icon,
}: {
  to: ManageRoute;
  year: string;
  label: string;
  icon: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button asChild variant="ghost" size="icon" aria-label={label}>
          <Link to={to} params={{ year }}>
            {icon}
          </Link>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

const YEARS_PAGE_SIZE = 9;

function YearFooter({ current }: { current: string }) {
  // Stack of `before` cursors, one per page already shown. `[null]` is the
  // newest window; pushing prepends the current window's start cursor to page
  // backwards in time; popping returns to a newer window.
  const [cursorStack, setCursorStack] = useState<Array<string | null>>([null]);
  const before = cursorStack[cursorStack.length - 1];
  const { data, loading } = useQuery(PlanningYearsFooterDocument, {
    variables: { last: YEARS_PAGE_SIZE, before },
    // Match the main suspense query's args on first render so we read the
    // already-warm cache instead of hitting the network.
    fetchPolicy: "cache-first",
  });
  const years = data?.planningYears?.edges.map((e) => e.node.id) ?? [];
  const hasOlder = data?.planningYears?.pageInfo.hasPreviousPage ?? false;
  const startCursor = data?.planningYears?.pageInfo.startCursor ?? null;
  const canGoNewer = cursorStack.length > 1;
  const onOlder = () => {
    if (!startCursor) return;
    setCursorStack((s) => [...s, startCursor]);
  };
  const onNewer = () => {
    setCursorStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
  };
  // Navigate inside a React transition so the previous year's grid stays
  // mounted while Apollo fetches the new one — `useSuspenseQuery` won't show
  // the suspense fallback during a transition, avoiding a blank-page flash.
  const navigate = useNavigate();
  const [isPending, startTransition] = useTransition();
  const onPickYear = (y: string) => {
    startTransition(() => {
      void navigate({ to: "/planning/$year", params: { year: y } });
    });
  };
  return (
    <nav className="sticky bottom-0 z-40 border-t bg-background/95 px-4 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <ul
        className={cn(
          "flex flex-wrap items-center gap-1 transition-opacity",
          (loading || isPending) && "opacity-50",
        )}
      >
        {hasOlder && (
          <li>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="sm"
                  variant="outline"
                  aria-label="Show older years"
                  onClick={onOlder}
                >
                  <ChevronLeft className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Show older years</TooltipContent>
            </Tooltip>
          </li>
        )}
        {years.map((y) => {
          const isCurrent = y === current;
          return (
            <li key={y}>
              <Button
                size="sm"
                variant={isCurrent ? "default" : "outline"}
                aria-current={isCurrent ? "page" : undefined}
                onClick={() => {
                  if (!isCurrent) onPickYear(y);
                }}
              >
                {fyLabelShort(y)}
              </Button>
            </li>
          );
        })}
        {canGoNewer && (
          <li>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="sm"
                  variant="outline"
                  aria-label="Show newer years"
                  onClick={onNewer}
                >
                  <ChevronRight className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Show newer years</TooltipContent>
            </Tooltip>
          </li>
        )}
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
  investableAssets,
}: {
  data: PlanningYearData;
  year: string;
  liabilities: LiabilityOption[];
  investableAssets: AssetOption[];
}) {
  const accounts = data.accounts;

  // Excel-like: sticky header row, sticky first column, hairline gridlines on
  // every cell border, tabular figures aligned right, dense rows.
  const cellBorder = "border-r border-b border-border";
  const monoRight = "text-right font-mono tabular-nums tracking-tight";

  const today = useToday();

  return (
    <div className="rounded-md border bg-background">
      <Table
        containerClassName="overflow-visible"
        className="border-separate border-spacing-0 text-xs"
      >
        <TableHeader className="bg-muted">
          <TableRow className="hover:bg-muted">
            <TableHead
              className={cn(
                "sticky top-12 left-0 z-30 w-8 min-w-8 max-w-8 bg-muted",
                cellBorder,
              )}
            />
            {accounts.map((a, j) => (
              <TableHead
                key={j}
                className={cn(
                  "sticky top-12 z-20 min-w-56 bg-muted",
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
          {data.months.map((month, i) => {
            const isCurrent = isSameMonth(new Date(month.date), today);
            return (
              // Keying by slot index (not `month.id`) lets React reuse the row
              // and cell instances when the planning year changes — the grid
              // always has the same 12 month rows × N account columns, so
              // year-swap becomes a prop update instead of unmount + remount.
              <TableRow key={i} className="align-top">
                <TableHead
                  scope="row"
                  className={cn(
                    "sticky left-0 z-10 relative w-8 min-w-8 max-w-8 bg-background p-0 font-medium",
                    isCurrent && "text-primary",
                    cellBorder,
                  )}
                >
                  <div className="absolute inset-0 flex items-center justify-center">
                    <span className="[writing-mode:vertical-rl] rotate-180 whitespace-nowrap">
                      {formatMonth(month.date)}
                    </span>
                  </div>
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
                            No planning accounts yet. Add one to start
                            projecting balances across the year.
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
                        key={j}
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
                          accountId={accounts[j].id}
                          accounts={accounts}
                          liabilities={liabilities}
                          investableAssets={investableAssets}
                        />
                      </TableCell>
                    ))}
              </TableRow>
            );
          })}
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
  accountId,
  accounts,
  liabilities,
  investableAssets,
}: {
  data: FragmentOf<typeof PlanningMonthAccountCellDocument>;
  monoRight: string;
  showStart: boolean;
  monthId: string;
  year: string;
  accountId: string;
  accounts: PlanningYearData["accounts"];
  liabilities: LiabilityOption[];
  investableAssets: AssetOption[];
}) {
  const cell = readFragment(PlanningMonthAccountCellDocument, data);
  return (
    <div className="group flex h-full flex-col divide-y divide-border">
      {showStart && (
        <div className="flex items-baseline justify-end bg-muted/30 px-2 py-1">
          <ProvisionalFigure
            data={cell.valueStart}
            provisional={cell.valueStartProvisional}
            className={monoRight}
            label="opening"
          />
        </div>
      )}
      <ul className="flex-1">
        {cell.transactions.length === 0 && (
          <li className="px-2 py-1 text-[10px] text-muted-foreground">—</li>
        )}
        {cell.transactions.map((tx, i) => (
          <TransactionRow
            // Keying by slot index lets React reuse row instances across year
            // switches — each cell typically holds a similar number of rows,
            // so most prop swaps avoid mount / unmount entirely. The row
            // resets its local edit / delete state when `tx.id` changes (see
            // the effect in `TransactionRow`).
            key={i}
            data={tx}
            monoRight={monoRight}
            monthId={monthId}
            year={year}
            accountId={accountId}
            accounts={accounts}
            liabilities={liabilities}
            investableAssets={investableAssets}
          />
        ))}
      </ul>
      <div className="flex justify-end gap-0.5 bg-muted/20 px-1 py-0.5">
        <CreateTransactionTrigger
          kind="adhoc"
          monthId={monthId}
          accountId={accountId}
          accounts={accounts}
          liabilities={liabilities}
          investableAssets={investableAssets}
        />
        <CreateTransactionTrigger
          kind="transfer"
          monthId={monthId}
          accountId={accountId}
          accounts={accounts}
          liabilities={liabilities}
          investableAssets={investableAssets}
        />
        <CreateTransactionTrigger
          kind="liability"
          monthId={monthId}
          accountId={accountId}
          accounts={accounts}
          liabilities={liabilities}
          investableAssets={investableAssets}
        />
        <CreateTransactionTrigger
          kind="investment"
          monthId={monthId}
          accountId={accountId}
          accounts={accounts}
          liabilities={liabilities}
          investableAssets={investableAssets}
        />
      </div>
      <div className="flex items-baseline justify-end bg-muted/30 px-2 py-1">
        <ProvisionalFigure
          data={cell.valueEnd}
          provisional={cell.valueEndProvisional}
          className={monoRight}
          label="closing"
        />
      </div>
    </div>
  );
}

/** `Figure` with a provisional-vs-recorded affordance: projected values render italic / muted with a dashed underline and a tooltip explaining they aren't from a net-worth snapshot; recorded values render bold without any extra chrome. */
function ProvisionalFigure({
  data,
  provisional,
  className,
  label,
}: {
  data: FragmentOf<typeof FigureDocument>;
  provisional: boolean;
  className: string;
  label: "opening" | "closing";
}) {
  if (!provisional) {
    return <Figure data={data} className={cn(className, "font-bold")} />;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            className,
            "cursor-help italic text-muted-foreground underline decoration-dotted underline-offset-2",
          )}
        >
          <Figure data={data} />
        </span>
      </TooltipTrigger>
      <TooltipContent>
        Projected {label} balance — no net-worth snapshot has been recorded for
        this month, so this is rolled forward from prior data. Record an entry
        to anchor the number.
      </TooltipContent>
    </Tooltip>
  );
}

function TransactionRow({
  data,
  monoRight,
  monthId,
  year: _year,
  accountId,
  accounts,
  liabilities,
  investableAssets,
}: {
  data: FragmentOf<typeof PlanningTransactionRowDocument>;
  monoRight: string;
  monthId: string;
  year: string;
  accountId: string;
  accounts: PlanningYearData["accounts"];
  liabilities: LiabilityOption[];
  investableAssets: AssetOption[];
}) {
  const tx = readFragment(PlanningTransactionRowDocument, data);
  const [editOpen, setEditOpen] = useState(false);
  // Lazy-mount the edit `Popover` — each cell can have many transactions, and
  // eagerly mounting one `Popover` (+ its context providers) per row inflates
  // grid re-render cost. Render a bare icon button until the user first opens
  // the editor.
  const [everOpened, setEverOpened] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  // Rows are keyed by slot index so React can reuse instances across year
  // switches — reset any in-flight per-row UI state when the underlying
  // transaction identity changes, or the user would see an open editor /
  // pending delete for a different row.
  useEffect(() => {
    setEditOpen(false);
    setEverOpened(false);
    setDeletePending(false);
  }, [tx.id]);
  const [update] = useMutation(TransactionUpdateDocument, {
    // `"active"` refetches every currently-watched query. A derived-earnings
    // edit can materialise a payslip, so any open `/planning/$year/payslips`
    // dialog (or anything else observing this data) also needs to see the
    // new row without us having to name every downstream query here.
    refetchQueries: "active",
  });
  const [remove] = useMutation(TransactionDeleteDocument, {
    // `"active"` refetches every currently-watched query. A derived-earnings
    // edit can materialise a payslip, so any open `/planning/$year/payslips`
    // dialog (or anything else observing this data) also needs to see the
    // new row without us having to name every downstream query here.
    refetchQueries: "active",
  });
  // Lazy-loaded frequently-used targets for this row's source account —
  // fetched only when the edit popover is opened.
  const frequentQuery = useQuery(PlanningFrequentTargetsDocument, {
    variables: { accountId },
    skip: !editOpen,
    fetchPolicy: "cache-and-network",
  });
  const frequentLiabilityIds =
    frequentQuery.data?.transactionLiabilitiesFrequent?.map((l) => l.id) ?? [];
  const frequentAssetIds =
    frequentQuery.data?.transactionAssetsFrequent?.map((a) => a.id) ?? [];

  const onSaveEdit = async (patch: FullFormValues) => {
    const signed = patch.direction === "+" ? patch.amount : -patch.amount;
    await update({
      variables: {
        monthId,
        id: tx.id,
        name: patch.name,
        amount: { amount: signed, currency: tx.amount.currency },
        toAccountId: patch.toAccountId,
        liabilityId: patch.liabilityId,
        assetId: patch.assetId,
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
        "group/row relative flex items-center gap-1 px-2 py-1",
        tx.isProvisional && "italic text-muted-foreground",
      )}
    >
      <TransactionKindIcon tx={tx} />
      <span className="flex-1 truncate">{tx.name}</span>
      <Figure data={tx.amount} className={monoRight} />
      {tx.isEditable && (
        // Absolutely-positioned overlay so the row never reserves horizontal
        // space for the action icons — they only appear on hover (or while a
        // delete confirmation is open). The small gradient fade on the left
        // keeps the amount from bleeding under the buttons at dense widths.
        <span
          className={cn(
            "pointer-events-none absolute inset-y-0 right-0 flex items-center gap-0.5 bg-gradient-to-l from-background via-background to-transparent pr-2 pl-6 transition-opacity",
            deletePending
              ? "pointer-events-auto opacity-100"
              : "opacity-0 group-hover/row:pointer-events-auto group-hover/row:opacity-100",
          )}
        >
          {!deletePending && !everOpened && (
            <IconButton
              aria-label={`Edit ${tx.name}`}
              onClick={() => {
                setEverOpened(true);
                setEditOpen(true);
              }}
            >
              <Pencil className="size-3" />
            </IconButton>
          )}
          {!deletePending && everOpened && (
            <Popover open={editOpen} onOpenChange={setEditOpen}>
              <PopoverTrigger asChild>
                <IconButton aria-label={`Edit ${tx.name}`}>
                  <Pencil className="size-3" />
                </IconButton>
              </PopoverTrigger>
              <PopoverContent className="w-80" align="end">
                <FullTransactionForm
                  submitLabel="Save"
                  initial={{
                    name: tx.name,
                    amount: Math.abs(tx.amount.amount),
                    direction: tx.amount.amount < 0 ? "-" : "+",
                    toAccountId: tx.toAccount?.id ?? null,
                    liabilityId: tx.liability?.id ?? null,
                    assetId: tx.asset?.id ?? null,
                  }}
                  accounts={accounts}
                  liabilities={liabilities}
                  investableAssets={investableAssets}
                  excludeAccountId={accountId}
                  frequentLiabilityIds={frequentLiabilityIds}
                  frequentAssetIds={frequentAssetIds}
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

/** Small leading icon on a transaction row that mirrors the `CreateTransactionTrigger` icon
 * for the corresponding kind. Rendered in a lighter tone than the triggers so
 * it reads as metadata, not an action. Shown only when the transaction has a
 * resolvable kind (transfer / liability payment / investment); other rows
 * (plain outflows, payslip gross, bills) render no icon. */
function TransactionKindIcon({
  tx,
}: {
  tx: ResultOf<typeof PlanningTransactionRowDocument>;
}) {
  const cls = "size-3 shrink-0 text-muted-foreground/60";
  if (tx.toAccount) return <ArrowUpRight className={cls} />;
  if (tx.fromAccount) return <ArrowDownLeft className={cls} />;
  if (tx.liability) {
    return tx.liability.type === "CREDIT_CARD" ? (
      <CreditCard className={cls} />
    ) : (
      <Landmark className={cls} />
    );
  }
  if (tx.asset) {
    return tx.asset.type === "PENSION" ? (
      <PiggyBank className={cls} />
    ) : (
      <ChartCandlestick className={cls} />
    );
  }
  if (tx.isBill) return <ScrollText className={cls} />;
  if (tx.isPayslipGross) return <HandCoins className={cls} />;
  return null;
}

/** Compact ghost-styled button sized to fit inside a dense transaction row. */
function IconButton({ className, ...props }: React.ComponentProps<"button">) {
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

type CreateKind = "adhoc" | "transfer" | "liability" | "investment";

const CREATE_KIND_META: Record<
  CreateKind,
  {
    label: string;
    icon: React.ReactNode;
  }
> = {
  adhoc: {
    label: "Add ad-hoc transaction",
    icon: <Plus className="size-3" />,
  },
  transfer: {
    label: "Add transfer",
    icon: <ArrowUpRight className="size-3" />,
  },
  liability: {
    label: "Add credit-card / loan payment",
    icon: <Landmark className="size-3" />,
  },
  investment: {
    label: "Add investment",
    icon: <PiggyBank className="size-3" />,
  },
};

function CreateTransactionTrigger({
  kind,
  monthId,
  accountId,
  accounts,
  liabilities,
  investableAssets,
}: {
  kind: CreateKind;
  monthId: string;
  accountId: string;
  accounts: PlanningYearData["accounts"];
  liabilities: LiabilityOption[];
  investableAssets: AssetOption[];
}) {
  const [open, setOpen] = useState(false);
  // Lazy-mount the Radix `Popover` — rendering a bare `IconButton` until the
  // user first opens the trigger. With 4 create-triggers per cell and ~72
  // cells, eagerly mounting `Popover` (plus its `PopperProvider` /
  // `TooltipProvider` context chain) adds hundreds of components to every
  // grid re-render; deferring keeps year-switch re-renders snappy.
  const [everOpened, setEverOpened] = useState(false);
  const [create] = useMutation(TransactionCreateDocument, {
    // `"active"` refetches every currently-watched query. A derived-earnings
    // edit can materialise a payslip, so any open `/planning/$year/payslips`
    // dialog (or anything else observing this data) also needs to see the
    // new row without us having to name every downstream query here.
    refetchQueries: "active",
  });
  // Only kinds whose dropdown shows a frequency section need this —
  // transfer has no "frequently used" bucket.
  const needsFrequent =
    kind === "liability" || kind === "investment" || kind === "adhoc";
  const frequentQuery = useQuery(PlanningFrequentTargetsDocument, {
    variables: { accountId },
    skip: !open || !needsFrequent,
    // Re-read on every open so a just-created transaction shows up in the
    // "Frequently used" list next time the popover appears.
    fetchPolicy: "cache-and-network",
  });
  const frequentLiabilityIds =
    frequentQuery.data?.transactionLiabilitiesFrequent?.map((l) => l.id) ?? [];
  const frequentAssetIds =
    frequentQuery.data?.transactionAssetsFrequent?.map((a) => a.id) ?? [];

  const onKindedSubmit = async (v: {
    name: string;
    amount: number;
    targetId: string;
  }) => {
    await create({
      variables: {
        monthId,
        accountId,
        name: v.name,
        amount: { amount: -v.amount, currency: "GBP" },
        toAccountId: kind === "transfer" ? v.targetId : null,
        liabilityId: kind === "liability" ? v.targetId : null,
        assetId: kind === "investment" ? v.targetId : null,
      },
    });
    toast.success("Transaction added");
    setOpen(false);
  };

  const onAdHocSubmit = async (v: FullFormValues) => {
    const signed = v.direction === "+" ? v.amount : -v.amount;
    await create({
      variables: {
        monthId,
        accountId,
        name: v.name,
        amount: { amount: signed, currency: "GBP" },
        toAccountId: v.toAccountId,
        liabilityId: v.liabilityId,
        assetId: v.assetId,
      },
    });
    toast.success("Transaction added");
    setOpen(false);
  };

  const meta = CREATE_KIND_META[kind];

  if (!everOpened) {
    return (
      <IconButton
        aria-label={meta.label}
        onClick={() => {
          setEverOpened(true);
          setOpen(true);
        }}
      >
        {meta.icon}
      </IconButton>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <IconButton aria-label={meta.label}>{meta.icon}</IconButton>
      </PopoverTrigger>
      <PopoverContent className="w-80" align="end">
        {kind === "adhoc" ? (
          <FullTransactionForm
            submitLabel="Add"
            accounts={accounts}
            liabilities={liabilities}
            investableAssets={investableAssets}
            excludeAccountId={accountId}
            frequentLiabilityIds={frequentLiabilityIds}
            frequentAssetIds={frequentAssetIds}
            onSubmit={onAdHocSubmit}
            onCancel={() => setOpen(false)}
          />
        ) : (
          <CreateTransactionForm
            kind={kind}
            accounts={accounts}
            liabilities={liabilities}
            investableAssets={investableAssets}
            excludeAccountId={accountId}
            frequentLiabilityIds={frequentLiabilityIds}
            frequentAssetIds={frequentAssetIds}
            onSubmit={onKindedSubmit}
            onCancel={() => setOpen(false)}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

type FullFormValues = {
  name: string;
  amount: number;
  direction: "+" | "-";
  toAccountId: string | null;
  liabilityId: string | null;
  assetId: string | null;
};

const NONE = "__none__" as const;

function FullTransactionForm({
  initial,
  submitLabel,
  accounts,
  liabilities,
  investableAssets,
  excludeAccountId,
  frequentLiabilityIds,
  frequentAssetIds,
  onSubmit,
  onCancel,
}: {
  initial?: FullFormValues;
  submitLabel: string;
  accounts: PlanningYearData["accounts"];
  liabilities: LiabilityOption[];
  investableAssets: AssetOption[];
  excludeAccountId: string;
  frequentLiabilityIds: string[];
  frequentAssetIds: string[];
  onSubmit: (v: FullFormValues) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [amount, setAmount] = useState(initial ? String(initial.amount) : "");
  const [direction, setDirection] = useState<"+" | "-">(
    initial?.direction ?? "-",
  );
  const [toAccountId, setToAccountId] = useState<string>(
    initial?.toAccountId ?? NONE,
  );
  const [liabilityId, setLiabilityId] = useState<string>(
    initial?.liabilityId ?? NONE,
  );
  const [assetId, setAssetId] = useState<string>(initial?.assetId ?? NONE);

  const hasTarget =
    toAccountId !== NONE || liabilityId !== NONE || assetId !== NONE;
  // When a target is set the transaction is implicitly an outflow — force
  // the sign negative and lock the dropdown so users can't create an
  // inconsistent record.
  const effectiveDirection: "+" | "-" = hasTarget ? "-" : direction;

  const parsed = Number(amount);
  const disabled = !name.trim() || !Number.isFinite(parsed) || parsed <= 0;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (disabled) return;
    await onSubmit({
      name: name.trim(),
      amount: parsed,
      direction: effectiveDirection,
      toAccountId: toAccountId === NONE ? null : toAccountId,
      liabilityId: liabilityId === NONE ? null : liabilityId,
      assetId: assetId === NONE ? null : assetId,
    });
  };

  const transferTargets = accounts.filter((a) => a.id !== excludeAccountId);
  const liabilityPartition = partitionFrequent(
    liabilities,
    frequentLiabilityIds,
  );
  const assetPartition = partitionFrequent(investableAssets, frequentAssetIds);

  // Mutex: picking one of the three target kinds clears the other two.
  const onSelectToAccount = (v: string) => {
    setToAccountId(v);
    if (v !== NONE) {
      setLiabilityId(NONE);
      setAssetId(NONE);
    }
  };
  const onSelectLiability = (v: string) => {
    setLiabilityId(v);
    if (v !== NONE) {
      setToAccountId(NONE);
      setAssetId(NONE);
    }
  };
  const onSelectAsset = (v: string) => {
    setAssetId(v);
    if (v !== NONE) {
      setToAccountId(NONE);
      setLiabilityId(NONE);
    }
  };

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
        <div className="flex items-center">
          <Select
            value={effectiveDirection}
            onValueChange={(v) => setDirection(v as "+" | "-")}
            disabled={hasTarget}
          >
            <SelectTrigger className="w-14 rounded-r-none border-r-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="-">−</SelectItem>
              <SelectItem value="+">+</SelectItem>
            </SelectContent>
          </Select>
          <Input
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0"
            currency="GBP"
            className="flex-1 rounded-l-none"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Transfer to (optional)</Label>
        <Select value={toAccountId} onValueChange={onSelectToAccount}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>None</SelectItem>
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
        <Select value={liabilityId} onValueChange={onSelectLiability}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>None</SelectItem>
            {liabilityPartition.frequent.length > 0 && (
              <>
                <SelectGroup>
                  <SelectLabel>Frequently used</SelectLabel>
                  {liabilityPartition.frequent.map((o) => (
                    <SelectItem key={o.id} value={o.id}>
                      {o.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
                {liabilityPartition.rest.length > 0 && <SelectSeparator />}
              </>
            )}
            {liabilityPartition.rest.length > 0 && (
              <SelectGroup>
                {liabilityPartition.frequent.length > 0 && (
                  <SelectLabel>All</SelectLabel>
                )}
                {liabilityPartition.rest.map((o) => (
                  <SelectItem key={o.id} value={o.id}>
                    {o.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            )}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Invests into asset (optional)</Label>
        <Select value={assetId} onValueChange={onSelectAsset}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>None</SelectItem>
            {assetPartition.frequent.length > 0 && (
              <>
                <SelectGroup>
                  <SelectLabel>Frequently used</SelectLabel>
                  {assetPartition.frequent.map((o) => (
                    <SelectItem key={o.id} value={o.id}>
                      {o.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
                {assetPartition.rest.length > 0 && <SelectSeparator />}
              </>
            )}
            {assetPartition.rest.length > 0 && (
              <SelectGroup>
                {assetPartition.frequent.length > 0 && (
                  <SelectLabel>All</SelectLabel>
                )}
                {assetPartition.rest.map((o) => (
                  <SelectItem key={o.id} value={o.id}>
                    {o.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            )}
          </SelectContent>
        </Select>
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={disabled}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

function CreateTransactionForm({
  kind,
  accounts,
  liabilities,
  investableAssets,
  excludeAccountId,
  frequentLiabilityIds,
  frequentAssetIds,
  onSubmit,
  onCancel,
}: {
  kind: CreateKind;
  accounts: PlanningYearData["accounts"];
  liabilities: LiabilityOption[];
  investableAssets: AssetOption[];
  excludeAccountId: string;
  frequentLiabilityIds: string[];
  frequentAssetIds: string[];
  onSubmit: (v: {
    name: string;
    amount: number;
    targetId: string;
  }) => void | Promise<void>;
  onCancel: () => void;
}) {
  const options: { id: string; name: string }[] =
    kind === "transfer"
      ? accounts.filter((a) => a.id !== excludeAccountId)
      : kind === "liability"
        ? liabilities
        : investableAssets;
  const frequentIds =
    kind === "liability"
      ? frequentLiabilityIds
      : kind === "investment"
        ? frequentAssetIds
        : [];
  const { frequent, rest } = partitionFrequent(options, frequentIds);

  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [targetId, setTargetId] = useState("");
  const parsed = Number(amount);
  const disabled =
    !name.trim() || !Number.isFinite(parsed) || parsed <= 0 || targetId === "";
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (disabled) return;
    await onSubmit({ name: name.trim(), amount: parsed, targetId });
  };

  const targetLabel =
    kind === "transfer"
      ? "Transfer to"
      : kind === "liability"
        ? "Pays down liability"
        : "Invests into asset";
  const targetPlaceholder =
    kind === "transfer"
      ? "Choose account"
      : kind === "liability"
        ? "Choose liability"
        : "Choose asset";

  const onTargetChange = (value: string) => {
    setTargetId(value);
    // Prefill name from the chosen target when the user hasn't typed anything
    // yet — a small nicety for the liability / investment flows where the row
    // label almost always mirrors the account name.
    if (!name.trim()) {
      const opt = options.find((o) => o.id === value);
      if (opt) setName(opt.name);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="space-y-1">
        <Label className="text-xs">{targetLabel}</Label>
        <Select value={targetId} onValueChange={onTargetChange}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder={targetPlaceholder} />
          </SelectTrigger>
          <SelectContent>
            {frequent.length > 0 && (
              <>
                <SelectGroup>
                  <SelectLabel>Frequently used</SelectLabel>
                  {frequent.map((o) => (
                    <SelectItem key={o.id} value={o.id}>
                      {o.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
                {rest.length > 0 && <SelectSeparator />}
              </>
            )}
            {rest.length > 0 && (
              <SelectGroup>
                {frequent.length > 0 && <SelectLabel>All</SelectLabel>}
                {rest.map((o) => (
                  <SelectItem key={o.id} value={o.id}>
                    {o.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            )}
          </SelectContent>
        </Select>
      </div>
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

/** Split `options` into a `frequent` list (in `frequentIds` order) and a
 * `rest` list sorted alphabetically by name. Options whose id appears in
 * `frequentIds` never appear in `rest`. */
function partitionFrequent<T extends { id: string; name: string }>(
  options: T[],
  frequentIds: string[],
): { frequent: T[]; rest: T[] } {
  const byId = new Map(options.map((o) => [o.id, o]));
  const frequent = frequentIds
    .map((id) => byId.get(id))
    .filter((o): o is T => o != null);
  const frequentSet = new Set(frequent.map((o) => o.id));
  const rest = options
    .filter((o) => !frequentSet.has(o.id))
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
  return { frequent, rest };
}

function formatMonth(d: string): string {
  return new Date(d).toLocaleDateString(undefined, {
    month: "short",
    year: "numeric",
  });
}

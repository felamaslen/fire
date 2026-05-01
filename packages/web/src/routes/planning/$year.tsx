import { useMutation, useQuery } from "@apollo/client/react";
import {
  createFileRoute,
  Link,
  Outlet,
  useNavigate,
} from "@tanstack/react-router";
import { isSameMonth } from "date-fns/isSameMonth";
import { startOfMonth } from "date-fns/startOfMonth";
import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  Briefcase,
  ChartCandlestick,
  ChevronLeft,
  ChevronRight,
  CornerDownRight,
  CreditCard,
  HandCoins,
  Landmark,
  Menu,
  PiggyBank,
  Plus,
  Scale,
  ScrollText,
  Trash2,
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
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
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
      isProjected
      isProvisional
      isEditable
      isBill
      isPayslipGross
      isPayslipDeduction
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
        amount
        ...Figure
      }
      valueEndProvisional
      target {
        amount
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
    $isProvisional: Boolean
  ) {
    transactionCreate(
      monthId: $monthId
      amount: $amount
      name: $name
      accountId: $accountId
      toAccountId: $toAccountId
      liabilityId: $liabilityId
      assetId: $assetId
      isProvisional: $isProvisional
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
    $isProvisional: Boolean
  ) {
    transactionUpdate(
      monthId: $monthId
      id: $id
      amount: $amount
      name: $name
      toAccountId: $toAccountId
      liabilityId: $liabilityId
      assetId: $assetId
      isProvisional: $isProvisional
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
  // Fill the viewport below the fixed `NavHeader` with a flex column whose
  // middle pane is the only horizontally-scrollable region. Without this,
  // the (wider-than-viewport) table lives in the main body scroll on
  // mobile — which expands the body past the viewport and drags the fixed
  // `NavHeader` along with it.
  return (
    <main className="flex h-[calc(100svh-2rem)] flex-col sm:h-[calc(100svh-2.5rem)]">
      <div id="planning-scroll" className="min-h-0 flex-1 overflow-auto">
        <PlanningYearPage year={year} />
      </div>
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
  // Non-suspense query: show the spinner only on initial load. During
  // refetches — e.g. after a transaction edit triggers
  // `refetchQueries: "active"` — Apollo keeps `data` populated with the
  // previous result, so the grid stays rendered without flashing.
  const { data, loading } = useQuery(PlanningYearViewDocument, {
    variables: { id: deferredYear },
  });
  const isStale = deferredYear !== year;
  if (!data) {
    return loading ? (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    ) : null;
  }
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
        "space-y-3 p-2 transition-opacity sm:space-y-6 sm:p-8",
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
      // Scroll happens inside the planning pane, not the viewport — watch
      // relative to that element so the title is treated as "hidden" when
      // it scrolls off the top of the pane.
      { root: document.getElementById("planning-scroll") },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <>
      <h1
        ref={titleRef}
        className="sticky left-0 flex w-fit items-center gap-2 px-1 text-lg font-semibold tracking-tight sm:px-0 sm:text-2xl"
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
            Planning · {fyLabelShort(year)}
          </span>
        </NavHeaderTitle>
      )}
      <NavHeaderActions>
        <div className="hidden sm:contents">
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
        </div>
        <MobileManageMenu year={year} />
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

function MobileManageMenu({ year }: { year: string }) {
  const [open, setOpen] = useState(false);
  const items: { to: ManageRoute; label: string; icon: React.ReactNode }[] = [
    {
      to: "/planning/$year/accounts",
      label: "Accounts",
      icon: <PiggyBank className="size-5" />,
    },
    {
      to: "/planning/$year/earnings",
      label: "Earnings",
      icon: <Briefcase className="size-5" />,
    },
    {
      to: "/planning/$year/payslips",
      label: "Payslips",
      icon: <HandCoins className="size-5" />,
    },
    {
      to: "/planning/$year/bills",
      label: "Bills",
      icon: <ScrollText className="size-5" />,
    },
    {
      to: "/planning/$year/tax-rates",
      label: "Tax rates",
      icon: <Scale className="size-5" />,
    },
  ];
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Manage planning year"
          className="h-7 w-7 sm:hidden"
        >
          <Menu className="size-5" />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-xs">
        <DialogHeader>
          <DialogTitle>Manage</DialogTitle>
        </DialogHeader>
        <ul className="flex flex-col gap-1">
          {items.map((it) => (
            <li key={it.to}>
              <Button
                asChild
                variant="ghost"
                className="w-full justify-start gap-3"
                onClick={() => setOpen(false)}
              >
                <Link to={it.to} params={{ year }}>
                  {it.icon}
                  {it.label}
                </Link>
              </Button>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
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
    <nav className="z-40 shrink-0 overflow-x-auto border-t bg-background/95 px-2 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:px-4">
      <ul
        className={cn(
          "flex flex-nowrap items-center gap-1 transition-opacity",
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
                "sticky top-0 left-0 z-30 w-6 min-w-6 max-w-6 bg-muted",
                cellBorder,
              )}
            />
            {accounts.map((a, j) => (
              <TableHead
                key={j}
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
          {data.months.map((month, i) => {
            const monthDate = new Date(month.date);
            const isCurrent = isSameMonth(monthDate, today);
            const isPast =
              !isCurrent && startOfMonth(monthDate) < startOfMonth(today);
            return (
              // Keying by slot index (not `month.id`) lets React reuse the row
              // and cell instances when the planning year changes — the grid
              // always has the same 12 month rows × N account columns, so
              // year-swap becomes a prop update instead of unmount + remount.
              <TableRow key={i} className="align-top">
                <TableHead
                  scope="row"
                  className={cn(
                    "sticky left-0 z-10 w-6 min-w-6 max-w-6 p-0 font-medium",
                    isCurrent
                      ? "bg-yellow-200 text-yellow-950 dark:bg-yellow-800 dark:text-yellow-50"
                      : isPast
                        ? "bg-muted text-muted-foreground"
                        : "bg-background",
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
      <div
        className={cn(
          "flex items-baseline justify-end px-2 py-1",
          closingHighlight(
            cell.valueEnd.amount,
            cell.target?.amount ?? null,
            cell.valueEndProvisional,
          ) ?? "bg-muted/30",
        )}
      >
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

/** Background-colour class for the month-end cell: red when the value is projected and negative, yellow when projected and below the target, green when projected and at-or-above the target, otherwise null (no highlight — keeps the default muted band). Recorded (non-projected) values never get highlighted regardless of target. */
function closingHighlight(
  valueEnd: number,
  target: number | null,
  provisional: boolean,
): string | null {
  if (!provisional) return null;
  if (valueEnd < 0) return "bg-red-500/10";
  if (target == null) return null;
  if (valueEnd < target) return "bg-yellow-500/10";
  if (valueEnd >= target * 1.5) return "bg-blue-500/10";
  return "bg-green-500/10";
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
  // Lazy-mount the edit `Dialog` — each cell can have many transactions, and
  // eagerly mounting one `Dialog` (+ its context providers) per row inflates
  // grid re-render cost. Render a bare clickable row until the user first
  // opens the editor.
  const [everOpened, setEverOpened] = useState(false);
  // Rows are keyed by slot index so React can reuse instances across year
  // switches — reset any in-flight per-row UI state when the underlying
  // transaction identity changes, or the user would see an open editor for a
  // different row.
  useEffect(() => {
    setEditOpen(false);
    setEverOpened(false);
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
        isProvisional: patch.isProvisional,
      },
    });
    toast.success("Saved");
    setEditOpen(false);
  };
  const onDelete = async () => {
    await remove({ variables: { monthId, id: tx.id } });
    toast.success("Deleted");
    setEditOpen(false);
  };

  const onSaveAmount = async (signed: number) => {
    await update({
      variables: {
        monthId,
        id: tx.id,
        amount: { amount: signed, currency: tx.amount.currency },
      },
    });
    toast.success("Saved");
  };

  const rowBody = (
    <>
      <TransactionKindIcon tx={tx} />
      <span className="flex-1 truncate">
        {tx.name}
        {tx.isProvisional && (
          <span className="ml-1.5 rounded-sm border border-amber-500/60 bg-amber-500/10 px-1 py-px align-baseline text-[9px] font-medium tracking-wide text-amber-700 uppercase">
            Provisional
          </span>
        )}
      </span>
      <AmountCell
        tx={tx}
        monoRight={monoRight}
        onSave={onSaveAmount}
        editable={tx.isEditable}
      />
    </>
  );
  const rowClass = cn(
    "group/row flex w-full items-center gap-1 px-2 py-1 text-left",
    tx.isEditable
      ? "cursor-pointer hover:bg-accent/40 focus-visible:outline-none focus-visible:bg-accent/40"
      : "cursor-default",
    // Engine-generated projections (predicted bills, payslips, …) read as
    // muted italic — the existing convention.
    tx.isProjected && "italic text-muted-foreground",
    // User-authored *provisional* rows are real DB rows but drafts. Distinct
    // from both projected (italic + muted) and actual (plain): a dashed
    // accent stripe down the left edge plus a small tag in the row body, so
    // the row stays full-weight legible (you'll likely come back and
    // commit / delete it).
    tx.isProvisional && "border-l-2 border-dashed border-amber-500 pl-[0.4rem]",
    // Indent payslip deductions so they read as children of the gross row
    // rendered immediately above them.
    tx.isPayslipDeduction && "pl-4",
  );
  const openDialog = () => {
    setEverOpened(true);
    setEditOpen(true);
  };
  const rowKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openDialog();
    }
  };

  if (!tx.isEditable) {
    return (
      <li>
        <Tooltip delayDuration={1000}>
          <TooltipTrigger asChild>
            <div className={rowClass}>{rowBody}</div>
          </TooltipTrigger>
          <TooltipContent>This transaction is not editable.</TooltipContent>
        </Tooltip>
      </li>
    );
  }

  if (!everOpened) {
    return (
      <li>
        <div
          role="button"
          tabIndex={0}
          className={rowClass}
          onClick={openDialog}
          onKeyDown={rowKeyDown}
        >
          {rowBody}
        </div>
      </li>
    );
  }

  return (
    <li>
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogTrigger asChild>
          <div
            role="button"
            tabIndex={0}
            className={rowClass}
            onKeyDown={rowKeyDown}
          >
            {rowBody}
          </div>
        </DialogTrigger>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Transaction</DialogTitle>
          </DialogHeader>
          <FullTransactionForm
            submitLabel="Save"
            initial={{
              name: tx.name,
              amount: Math.abs(tx.amount.amount),
              direction: tx.amount.amount < 0 ? "-" : "+",
              toAccountId: tx.toAccount?.id ?? null,
              liabilityId: tx.liability?.id ?? null,
              assetId: tx.asset?.id ?? null,
              isProvisional: tx.isProvisional,
            }}
            accounts={accounts}
            liabilities={liabilities}
            investableAssets={investableAssets}
            excludeAccountId={accountId}
            frequentLiabilityIds={frequentLiabilityIds}
            frequentAssetIds={frequentAssetIds}
            onDelete={onDelete}
            onSubmit={onSaveEdit}
            onCancel={() => setEditOpen(false)}
          />
        </DialogContent>
      </Dialog>
    </li>
  );
}

/**
 * Amount column for a transaction row. On mobile this is a plain `Figure` —
 * the surrounding row handles the click, opening the full edit dialog. On
 * desktop (`sm+`) clicking the amount swaps it for a small inline input so
 * quick number tweaks don't need the modal. The sign is preserved from the
 * original amount; flipping sign still goes through the dialog.
 */
function AmountCell({
  tx,
  monoRight,
  onSave,
  editable,
}: {
  tx: ResultOf<typeof PlanningTransactionRowDocument>;
  monoRight: string;
  onSave: (signed: number) => Promise<void>;
  editable: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");

  if (!editable) return <Figure data={tx.amount} className={monoRight} />;

  if (editing) {
    const commit = async () => {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < 0) {
        setEditing(false);
        return;
      }
      const sign = tx.amount.amount < 0 ? -1 : 1;
      const signed = parsed * sign;
      setEditing(false);
      if (signed !== tx.amount.amount) await onSave(signed);
    };
    return (
      <input
        autoFocus
        type="number"
        step="0.01"
        min="0"
        inputMode="decimal"
        className={cn(
          monoRight,
          "w-24 rounded border border-input bg-background px-1 py-0 text-xs outline-none focus:ring-1 focus:ring-ring",
        )}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => {
          void commit();
        }}
        onKeyDown={(e) => {
          // Don't let Enter/Space/Escape bubble up to the row handler, which
          // would open the full edit dialog.
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            void commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setEditing(false);
          }
        }}
        onClick={(e) => e.stopPropagation()}
      />
    );
  }

  return (
    <>
      <Figure data={tx.amount} className={cn(monoRight, "sm:hidden")} />
      <button
        type="button"
        className={cn(
          monoRight,
          "hidden cursor-text rounded px-0.5 hover:bg-accent hover:underline sm:inline",
        )}
        aria-label="Edit amount"
        onClick={(e) => {
          e.stopPropagation();
          setValue(Math.abs(tx.amount.amount).toString());
          setEditing(true);
        }}
      >
        <Figure data={tx.amount} />
      </button>
    </>
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
  // Deductions hang off the immediately-preceding payslip-gross row, so the
  // leading slot shows a child-of-parent corner glyph instead of the row's
  // own kind icon — mirrors how a tree view nests children under a parent.
  if (tx.isPayslipDeduction) return <CornerDownRight className={cls} />;
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
        isProvisional: v.isProvisional,
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
      <PopoverContent className="w-80 bg-popover/80" align="end">
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
  isProvisional: boolean;
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
  disabled: readOnly = false,
  onDelete,
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
  disabled?: boolean;
  onDelete?: () => void | Promise<void>;
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
  const [isProvisional, setIsProvisional] = useState<boolean>(
    initial?.isProvisional ?? false,
  );

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
      isProvisional,
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
          disabled={readOnly}
        />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Amount</Label>
        <div className="flex items-center">
          <Select
            value={effectiveDirection}
            onValueChange={(v) => setDirection(v as "+" | "-")}
            disabled={hasTarget || readOnly}
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
            disabled={readOnly}
          />
        </div>
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Transfer to (optional)</Label>
        <Select
          value={toAccountId}
          onValueChange={onSelectToAccount}
          disabled={readOnly}
        >
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
        <Select
          value={liabilityId}
          onValueChange={onSelectLiability}
          disabled={readOnly}
        >
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
        <Select
          value={assetId}
          onValueChange={onSelectAsset}
          disabled={readOnly}
        >
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
      <label className="flex items-start gap-2 text-sm">
        <Checkbox
          checked={isProvisional}
          onCheckedChange={(c) => setIsProvisional(c === true)}
          disabled={readOnly}
          className="mt-0.5"
        />
        <span>
          <span className="font-medium">Provisional</span>
          <span className="ml-1 text-xs text-muted-foreground">
            — draft only. Counts in the planner's balance projections but
            doesn't show up in actual-money aggregates.
          </span>
        </span>
      </label>
      <div className="flex items-center justify-end gap-2">
        {onDelete && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mr-auto text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={() => {
              void onDelete();
            }}
          >
            <Trash2 className="size-4" />
            Delete
          </Button>
        )}
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          {readOnly ? "Close" : "Cancel"}
        </Button>
        {!readOnly && (
          <Button type="submit" size="sm" disabled={disabled}>
            {submitLabel}
          </Button>
        )}
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

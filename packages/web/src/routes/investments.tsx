import { useQuery, useSuspenseQuery } from "@apollo/client/react";
import {
  createFileRoute,
  Outlet,
  redirect,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { ArrowDown, ArrowUp, Check, ExternalLink, Plus } from "lucide-react";
import {
  type ComponentProps,
  Suspense,
  useCallback,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
} from "react";
import { z } from "zod";

import { Figure, FigureDocument } from "@/components/figure";
import {
  AllocationsSection,
  AllocationsSectionInvestmentFragment,
  AllocationsSectionPortfolioFragment,
} from "@/components/investments/allocations-section";
import {
  CashContributionsAvailableFragment,
  CashContributionsSection,
} from "@/components/investments/cash-contributions-section";
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
import { NavHeaderTitle } from "@/components/nav-header";
import { Spinner } from "@/components/spinner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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
import {
  type FragmentOf,
  graphql,
  readFragment,
  type ResultOf,
  type VariablesOf,
} from "@/graphql";
import { cn } from "@/lib/cn";
import { formatUnitPrice } from "@/lib/format";

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
      unitPriceCached {
        ...Figure
      }
      unitPriceCachedAt
      unitPriceLatest {
        price {
          ...Figure
        }
        capturedAt
        tickAt
      }
      position(filterAssetIdIn: $filterAssetIdIn) {
        units
        totalValue {
          ...Figure
        }
        totalGain {
          amount
          ...Figure
        }
        percentGain
        reinvested {
          value {
            amount
            ...Figure
          }
        }
      }
      ...InvestmentForm
    }
  `,
  [FigureDocument, InvestmentFormDocument],
);

export const InvestmentsListDocument = graphql(
  `
    query InvestmentsList(
      $first: Int
      $sort: InvestmentSort
      $filterAssetIdIn: [ID!]
      $filterIsSold: Boolean
    ) {
      investments(
        first: $first
        sort: $sort
        filterAssetIdIn: $filterAssetIdIn
        filterIsSold: $filterIsSold
      ) {
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

const PortfolioFilterOptionsFragment = graphql(`
  fragment PortfolioFilterOptions on NetWorthCategoryAsset {
    id
    name
    type
    isDefunct
    transferOut {
      id
      date
      assetTo {
        id
        name
      }
    }
  }
`);

type PortfolioFilterOption = ResultOf<typeof PortfolioFilterOptionsFragment>;

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
      $candleUnit: PortfolioCandleUnit!
      $candleLength: Int!
      $candlestick: Boolean!
      $stack: Boolean!
      $skipLive: Boolean!
      $filterAssetIdIn: [ID!]
      $filterIsSold: Boolean
    ) {
      investments(
        first: $first
        sort: $sort
        filterAssetIdIn: $filterAssetIdIn
        filterIsSold: $filterIsSold
      ) {
        edges {
          node {
            id
            ...InvestmentRow
            ...InvestmentForm
            ...AllocationsSectionInvestment
          }
        }
      }
      portfolio(filterAssetIdIn: $filterAssetIdIn, skipLive: $skipLive) {
        ...PortfolioHeadline
        ...PortfolioChartPortfolio
        ...CashContributionsAvailable
      }
      allocationsPortfolio: portfolio(filterAssetIdIn: $filterAssetIdIn) {
        ...AllocationsSectionPortfolio
      }
      investmentPortfolios {
        ...PortfolioFilterOptions
      }
      allocationsInvestments: investments(first: 1000) {
        edges {
          node {
            id
            ...AllocationsSectionInvestment
          }
        }
      }
      portfolios(filterAssetIdIn: $filterAssetIdIn, skipLive: $skipLive)
        @include(if: $stack) {
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
    CashContributionsAvailableFragment,
    AllocationsSectionInvestmentFragment,
    AllocationsSectionPortfolioFragment,
    PortfolioFilterOptionsFragment,
  ],
);

function PortfolioFilterDropdown({
  value,
  onChange,
  options,
}: {
  value: string[];
  onChange: (ids: string[]) => void;
  options: PortfolioFilterOption[];
}) {
  const selected = new Set(value);
  const allSelected = value.length === 0;
  const label = allSelected
    ? "All"
    : value.length === 1
      ? (options.find((o) => o.id === value[0])?.name ?? "1 selected")
      : `${value.length} selected`;

  const active = options.filter((o) => !o.isDefunct);
  const defunct = options.filter((o) => o.isDefunct);

  // Click on the checkbox: toggle that option's inclusion in the current
  // multi-selection. Click anywhere else on the row: collapse to "only this
  // one selected".
  const toggleInclusion = (id: string) => {
    const next = new Set(allSelected ? options.map((o) => o.id) : selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    if (next.size === 0 || next.size === options.length) onChange([]);
    else onChange([...next]);
  };
  const selectOnly = (id: string) => onChange([id]);

  const renderOption = (o: PortfolioFilterOption) => {
    const isSelected = allSelected || selected.has(o.id);
    return (
      <div
        key={o.id}
        role="button"
        tabIndex={0}
        onClick={() => selectOnly(o.id)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            selectOnly(o.id);
          }
        }}
        className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
      >
        <Checkbox
          checked={isSelected}
          onClick={(e) => e.stopPropagation()}
          onCheckedChange={() => toggleInclusion(o.id)}
          aria-label={`Toggle ${o.name}`}
        />
        <span className="truncate">{o.name}</span>
      </div>
    );
  };

  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span>Portfolio</span>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="h-8 w-40 justify-between text-xs font-normal"
          >
            <span className="truncate">{label}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-56 p-1">
          <button
            type="button"
            onClick={() => onChange([])}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
          >
            <span className="flex h-4 w-4 items-center justify-center">
              {allSelected && <Check className="h-3.5 w-3.5" />}
            </span>
            All
          </button>
          <div className="my-1 h-px bg-border" />
          {active.map(renderOption)}
          {defunct.length > 0 && (
            <>
              <div className="my-1 flex items-center gap-2 px-2 text-[10px] uppercase tracking-wide text-muted-foreground">
                <span className="h-px flex-1 bg-border" />
                Defunct
                <span className="h-px flex-1 bg-border" />
              </div>
              {defunct.map(renderOption)}
            </>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}

type InvestmentRowNode = NonNullable<
  ResultOf<typeof InvestmentsListDocument>["investments"]
>["edges"][number]["node"];

type SortKind = "createdAt" | "value" | "gainAbs" | "gainPercent";
type SortDirection = "ASC" | "DESC";
type SortState = { kind: SortKind; dir: SortDirection };

const RANGES = ["all", "5y", "3y", "1y", "ytd", "3m"] as const;
type Range = (typeof RANGES)[number];

const CANDLE_SLUGS = ["3d", "1w", "2w", "1m", "3m"] as const;
type CandleSlug = (typeof CANDLE_SLUGS)[number];

const investmentsSearchSchema = z.object({
  range: z.enum(RANGES).optional().catch(undefined),
  candle: z.enum(CANDLE_SLUGS).optional().catch(undefined),
  mode: z.enum(["line", "candle"]).optional().catch(undefined),
  stack: z.coerce.boolean().optional().catch(undefined),
  sort: z.enum(["value", "gainAbs", "gainPercent"]).optional().catch(undefined),
  dir: z.enum(["asc", "desc"]).optional().catch(undefined),
  "filter-portfolio-id": z.string().min(1).optional().catch(undefined),
});

type InvestmentsSearch = z.infer<typeof investmentsSearchSchema>;

const SEARCH_STORAGE_KEY = "fire.investments.search";

export const Route = createFileRoute("/investments")({
  component: InvestmentsDialogLayout,
  validateSearch: investmentsSearchSchema,
  // Hydrate persisted UI state from localStorage into the URL *before* the
  // component mounts. Doing this in `beforeLoad` (not a post-mount effect)
  // means the very first render already sees the final `search`, so
  // `useSuspenseQuery` fires once per page load instead of firing, then
  // re-firing after the post-mount `navigate()` re-renders the tree.
  beforeLoad: ({ location, search }) => {
    if (location.pathname !== "/investments") return;
    if (hasAnySearch(search)) return;
    const persisted = loadPersistedSearch();
    if (!hasAnySearch(persisted)) return;
    throw redirect({ to: "/investments", search: persisted, replace: true });
  },
});

export const investmentsRefetch = ["InvestmentsList"];

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
  period: "YEAR" | "MONTH" | "YTD" | "ALL";
  length: number | null;
} {
  switch (r) {
    case "all":
      return { period: "ALL", length: null };
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
  const candle = s.candle ?? "1w";
  return {
    periodIdx: RANGES.indexOf(range),
    candleIdx: CANDLE_SLUGS.indexOf(candle),
    mode: s.mode === "candle" ? "candlestick" : "line",
    stack: s.stack ?? false,
  };
}

function chartToSearch(
  c: PortfolioChartSettings,
): Pick<InvestmentsSearch, "range" | "candle" | "mode" | "stack"> {
  const range = RANGES[c.periodIdx] ?? "5y";
  const candle = CANDLE_SLUGS[c.candleIdx] ?? "1w";
  return {
    range: range === "5y" ? undefined : range,
    candle: candle === "1w" ? undefined : candle,
    mode: c.mode === "candlestick" ? "candle" : undefined,
    stack: c.stack ? true : undefined,
  };
}

/** Width in `PortfolioCandleUnit`s per candle, e.g. `"3d"` → `{ unit: "DAY", length: 3 }`. Used to turn the URL's `candle` slug into the backend's `candlestick(unit, length)` arguments. */
function candleSlugToUnit(slug: CandleSlug): {
  unit: "DAY" | "WEEK" | "MONTH";
  length: number;
} {
  switch (slug) {
    case "3d":
      return { unit: "DAY", length: 3 };
    case "1w":
      return { unit: "WEEK", length: 1 };
    case "2w":
      return { unit: "WEEK", length: 2 };
    case "1m":
      return { unit: "MONTH", length: 1 };
    case "3m":
      return { unit: "MONTH", length: 3 };
  }
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

function parsePortfolioIds(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(",").filter((s) => s.length > 0);
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
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [titleVisible, setTitleVisible] = useState(true);
  useEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => setTitleVisible(entry.isIntersecting),
      { rootMargin: "-40px 0px 0px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-3 p-3 sm:gap-6 sm:p-6">
      <h1
        ref={titleRef}
        className="text-lg font-semibold tracking-tight sm:text-2xl"
      >
        Investments
      </h1>
      {!titleVisible && (
        <NavHeaderTitle>
          <span className="text-sm font-semibold tracking-tight">
            Investments
          </span>
        </NavHeaderTitle>
      )}
      <Suspense fallback={<Spinner />}>
        <InvestmentsPageContent />
      </Suspense>
      <Outlet />
    </main>
  );
}

// Persisted UI options (chart period/mode/stack, sort) live in the URL
// search params; `beforeLoad` seeds them from localStorage on first visit.
// Any URL-driven change gets mirrored back to localStorage.
function InvestmentsPageContent() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  // Only persist when the router is actually on `/investments` — if a child
  // route (`/investments/$id`) is active, its search params belong to the
  // child, not the list view.
  const isOnListPage = useRouterState({
    select: (s) => s.location.pathname === "/investments",
  });

  useEffect(() => {
    if (!isOnListPage) return;
    window.localStorage.setItem(SEARCH_STORAGE_KEY, JSON.stringify(search));
  }, [search, isOnListPage]);

  const chart = searchToChart(search);
  const sort = searchToSort(search);
  const filterAssetIds = parsePortfolioIds(search["filter-portfolio-id"]);
  // The allocations widget and per-investment detail (transaction list /
  // position lookup on `Investment.transactionsPaged` and `position`) are
  // single-wrapper-scoped, so they only act on a unambiguously-selected
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
  const setFilterAssetIds = (ids: string[]) => {
    void navigate({
      search: (prev) => {
        const next = { ...prev } as InvestmentsSearch;
        if (ids.length > 0) next["filter-portfolio-id"] = ids.join(",");
        else delete next["filter-portfolio-id"];
        return next;
      },
      replace: true,
    });
  };

  // Freeze the initial suspense-query variables so later set* calls don't
  // re-suspend the page — children refetch via their own `useQuery`. The
  // `search` captured here is already the hydrated copy thanks to the route's
  // `beforeLoad`, so the first render has the final variables and no
  // post-mount `navigate()` re-runs the suspense query.
  const [initialVars] = useState(() => {
    const c = searchToChart(search);
    const s = searchToSort(search);
    const { period, length } = rangeToPeriod(RANGES[c.periodIdx] ?? "5y");
    const { unit: candleUnit, length: candleLength } = candleSlugToUnit(
      CANDLE_SLUGS[c.candleIdx] ?? "1w",
    );
    const ids = parsePortfolioIds(search["filter-portfolio-id"]);
    return {
      first: 100,
      sort: toSortInput(s.kind, s.dir),
      period,
      length,
      candleUnit,
      candleLength,
      candlestick: c.mode === "candlestick",
      stack: c.stack,
      skipLive: true,
      filterAssetIdIn: ids.length > 0 ? ids : null,
      filterIsSold: loadHideSold() ? false : null,
    };
  });
  // Fire-and-forget prewarm. The page never reads this query's `data` —
  // it only exists to populate the cache so each child's own `useQuery` /
  // `useSuspenseQuery` resolves synchronously. We deliberately don't
  // `useSuspenseQuery` here: under React 18 + Apollo's queryRef lifecycle
  // we were seeing the same operation fire twice on initial load (also in
  // production), and a non-suspending fetch sidesteps that entirely while
  // still warming the cache before any child mounts and reads it.
  const { data: pageData } = useQuery(InvestmentsPageDocument, {
    variables: initialVars,
  });
  const portfolioOptions: PortfolioFilterOption[] =
    pageData?.investmentPortfolios?.map((p) =>
      readFragment(PortfolioFilterOptionsFragment, p),
    ) ?? [];
  const singleSelected =
    filterAssetIds.length === 1
      ? (portfolioOptions.find((o) => o.id === filterAssetIds[0]) ?? null)
      : null;
  const selectedLabel =
    filterAssetIds.length === 0
      ? null
      : singleSelected
        ? singleSelected.name
        : "Selected portfolios";
  const transferredOut = singleSelected?.transferOut ?? null;

  return (
    <>
      <PortfolioHeadline
        filterAssetIds={filterAssetIds}
        rightSlot={
          <PortfolioFilterDropdown
            value={filterAssetIds}
            onChange={setFilterAssetIds}
            options={portfolioOptions}
          />
        }
      />
      {transferredOut && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm dark:border-amber-900/40 dark:bg-amber-900/10">
          This portfolio was transferred to{" "}
          <strong>{transferredOut.assetTo.name}</strong> on{" "}
          <span className="tabular-nums">{transferredOut.date}</span>. Holdings,
          cash, and totals are frozen at the day before the transfer.
        </div>
      )}
      <PortfolioSection
        filterAssetIds={filterAssetIds}
        selectedLabel={selectedLabel}
        settings={chart}
        onChange={setChart}
        transferOut={transferredOut}
        bottomSlot={<AllocationsSection filterAssetIds={filterAssetIds} />}
      />
      {filterAssetIds.length === 1 && (
        <Suspense fallback={<Spinner />}>
          <CashContributionsSection assetId={filterAssetIds[0]!} />
        </Suspense>
      )}
      <InvestmentsList
        sort={sort}
        onSortChange={setSort}
        filterAssetIds={filterAssetIds}
        transferredOut={transferredOut !== null}
      />
    </>
  );
}

function InvestmentsList({
  sort,
  onSortChange,
  filterAssetIds,
  transferredOut,
}: {
  sort: SortState;
  onSortChange: (next: SortState) => void;
  filterAssetIds: string[];
  /** When `true`, the selected portfolio has been transferred out — every
   * investment is treated as sold (`hideSold` is forced on, the toggle is
   * disabled, and the "New investment" button is disabled). */
  transferredOut: boolean;
}) {
  const setSort = (updater: (prev: SortState) => SortState) =>
    onSortChange(updater(sort));
  const [hideSold, setHideSold] = useHideSold();
  // Transferred-out portfolios force-hide sold investments (every position
  // is conceptually sold at the transfer date). The toggle becomes a no-op.
  const effectiveHideSold = transferredOut || hideSold;

  // Defer sort / filter changes through `useDeferredValue` so switching
  // suspends the fetch in a non-interrupting pass — the previous rows
  // stay mounted until the new data arrives. Using plain scalars (not
  // the wrapping `sort` object) keeps the deferred identity stable
  // across unrelated page re-renders (e.g. chart mode changes updating
  // the URL search), so those don't re-trigger the query.
  const deferredKind = useDeferredValue(sort.kind);
  const deferredDir = useDeferredValue(sort.dir);
  const filterAssetIdsKey = filterAssetIds.join(",");
  const deferredFilterAssetIdsKey = useDeferredValue(filterAssetIdsKey);
  const deferredFilterAssetIdIn =
    deferredFilterAssetIdsKey.length > 0
      ? deferredFilterAssetIdsKey.split(",")
      : null;
  const deferredHideSold = useDeferredValue(effectiveHideSold);
  const loading =
    deferredKind !== sort.kind ||
    deferredDir !== sort.dir ||
    deferredFilterAssetIdsKey !== filterAssetIdsKey ||
    deferredHideSold !== effectiveHideSold;
  const { data } = useSuspenseQuery(InvestmentsListDocument, {
    variables: {
      first: 100,
      sort: toSortInput(deferredKind, deferredDir),
      filterAssetIdIn: deferredFilterAssetIdIn,
      filterIsSold: deferredHideSold ? false : null,
    },
  });
  const rows: InvestmentRowNode[] =
    data.investments?.edges.map((e) => e.node) ?? [];

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
        <label
          className={cn(
            "flex items-center gap-2 text-sm",
            transferredOut && "text-muted-foreground",
          )}
        >
          <input
            type="checkbox"
            checked={effectiveHideSold}
            disabled={transferredOut}
            onChange={(e) => setHideSold(e.target.checked)}
            className="accent-foreground disabled:opacity-50"
          />
          Hide sold or transferred investments
        </label>
        <Button
          onClick={() => setCreateOpen(true)}
          disabled={transferredOut}
          title={
            transferredOut
              ? "This portfolio has been transferred out — book new transactions on the destination wrapper."
              : undefined
          }
        >
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
              <TableHead className="w-full">Name</TableHead>
              <TableHead className="hidden sm:table-cell">Ticker</TableHead>
              <TableHead className="text-right">Units</TableHead>
              <TableHead className="hidden text-right sm:table-cell">
                Price
              </TableHead>
              <TableHead className="text-right sm:hidden">
                <SortHeader
                  label="Value / Gain"
                  kind="value"
                  sort={sort}
                  onToggle={toggle}
                />
              </TableHead>
              <TableHead className="hidden text-right sm:table-cell">
                <SortHeader
                  label="Value"
                  kind="value"
                  sort={sort}
                  onToggle={toggle}
                />
              </TableHead>
              <TableHead className="hidden text-right sm:table-cell">
                <SortHeader
                  label="Gain"
                  kind="gainAbs"
                  sort={sort}
                  onToggle={toggle}
                />
              </TableHead>
              <TableHead className="hidden text-right sm:table-cell">
                <SortHeader
                  label="%"
                  kind="gainPercent"
                  sort={sort}
                  onToggle={toggle}
                />
              </TableHead>
              <TableHead className="hidden text-right sm:table-cell">
                DRIP
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const id = readFragment(InvestmentRowDocument, row).id;
              return (
                <InvestmentRow
                  key={row.id}
                  data={row}
                  onOpen={() =>
                    void navigate({
                      to: "/investments/$id",
                      params: { id },
                      search: (prev) => prev,
                      resetScroll: false,
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
        <Suspense fallback={<Spinner />}>
          <InvestmentForm
            existing={null}
            onDone={onClose}
            refetchQueries={investmentsRefetch}
          />
        </Suspense>
      </DialogContent>
    </Dialog>
  );
}

const HIDE_SOLD_STORAGE_KEY = "fire.investments.hideSold";

function loadHideSold(): boolean {
  if (typeof window === "undefined") return true;
  const raw = window.sessionStorage.getItem(HIDE_SOLD_STORAGE_KEY);
  return raw === null ? true : raw === "1";
}

function useHideSold(): [boolean, (v: boolean) => void] {
  const [hideSold, setHideSoldState] = useState<boolean>(loadHideSold);
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

function UnitPrice({
  live,
  cached,
  cachedAt,
  prefix,
}: {
  live: {
    price: FragmentOf<typeof FigureDocument>;
    capturedAt: string;
    tickAt: string;
  } | null;
  cached: FragmentOf<typeof FigureDocument> | null;
  cachedAt: string | null;
  prefix?: string;
}) {
  const priceFragment = live?.price ?? cached;
  if (!priceFragment) return <span className="text-muted-foreground">—</span>;
  const price = readFragment(FigureDocument, priceFragment);
  const isLive = live !== null;
  // Tooltip + age colour reflect when we last refreshed the quote
  // (`capturedAt` for live, `cachedAt` for the daily-close fallback) — this is
  // the freshness signal. The clock-icon hands point at `tickAt` (the actual
  // price tick) so you can see at a glance what wall-clock time the price is
  // from.
  const refreshedAt = isLive ? live.capturedAt : cachedAt;
  const handsAt = isLive ? live.tickAt : cachedAt;
  const now = useNow(30_000);
  const liveAgeMs =
    isLive && live.capturedAt ? now - new Date(live.capturedAt).getTime() : 0;
  // 0–60s = green (hue 140), ≥5min = yellow (hue 50), linear in between.
  const t = Math.min(1, Math.max(0, (liveAgeMs - 60_000) / (300_000 - 60_000)));
  const liveHue = 140 - t * 90;
  return (
    <span className="inline-flex items-center gap-1">
      {prefix}
      {formatUnitPrice(price.currency, price.amount)}
      {refreshedAt && (
        <Tooltip>
          <TooltipTrigger asChild>
            <TimeClockIcon
              at={handsAt ? new Date(handsAt) : null}
              className={cn(
                "h-3 w-3 shrink-0",
                !isLive && "text-muted-foreground",
              )}
              style={isLive ? { color: `hsl(${liveHue} 70% 40%)` } : undefined}
            />
          </TooltipTrigger>
          <TooltipContent>
            {isLive ? (
              <div className="grid grid-cols-[auto_auto] gap-x-2">
                <span className="text-muted-foreground">Refreshed</span>
                <span>{new Date(live.capturedAt).toLocaleString("en-GB")}</span>
                <span className="text-muted-foreground">Quote date</span>
                <span>{new Date(live.tickAt).toLocaleString("en-GB")}</span>
              </div>
            ) : (
              <>Recorded {new Date(refreshedAt).toLocaleString("en-GB")}</>
            )}
          </TooltipContent>
        </Tooltip>
      )}
    </span>
  );
}

/** Lucide-style 24×24 clock face whose hour and minute hands point at `at`. Falls back to a static face (no hands) when `at` is null. Spreads `...rest` onto the underlying `<svg>` so it composes with Radix's `asChild` slot pattern (the Tooltip trigger needs to inject pointer / focus handlers + a ref). */
function TimeClockIcon({
  at,
  ...rest
}: {
  at: Date | null;
} & ComponentProps<"svg">) {
  const hands = at
    ? (() => {
        const h = (at.getHours() % 12) + at.getMinutes() / 60;
        const m = at.getMinutes();
        const hourAng = (h / 12) * 2 * Math.PI - Math.PI / 2;
        const minAng = (m / 60) * 2 * Math.PI - Math.PI / 2;
        return {
          hx: 12 + Math.cos(hourAng) * 4,
          hy: 12 + Math.sin(hourAng) * 4,
          mx: 12 + Math.cos(minAng) * 7,
          my: 12 + Math.sin(minAng) * 7,
        };
      })()
    : null;
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...rest}
    >
      <circle cx={12} cy={12} r={10} />
      {hands && (
        <>
          <line x1={12} y1={12} x2={hands.hx} y2={hands.hy} />
          <line x1={12} y1={12} x2={hands.mx} y2={hands.my} />
        </>
      )}
    </svg>
  );
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function InvestmentRow({
  data,
  onOpen,
}: {
  data: FragmentOf<typeof InvestmentRowDocument>;
  onOpen: () => void;
}) {
  const inv = readFragment(InvestmentRowDocument, data);
  const gainColor = gainSignColor(inv.position.totalGain?.amount);
  const ticker =
    inv.asset.__typename === "InvestmentStock" ? inv.asset.code : null;

  return (
    <TableRow className="cursor-pointer" onClick={onOpen}>
      <TableCell className="max-w-0 align-middle font-medium">
        <span className="flex items-center gap-1.5">
          <span className="truncate sm:hidden">{ticker ?? inv.name}</span>
          <span className="hidden truncate sm:inline">{inv.name}</span>
          {inv.asset.__typename === "InvestmentFund" && (
            <a
              href={inv.asset.url}
              target="_blank"
              rel="noreferrer noopener"
              onClick={(e) => e.stopPropagation()}
              className="shrink-0 text-muted-foreground hover:text-foreground"
              aria-label="Open fund page"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
        </span>
      </TableCell>
      <TableCell className="hidden text-xs text-muted-foreground align-middle sm:table-cell">
        {ticker ?? ""}
      </TableCell>
      <TableCell className="text-right align-middle tabular-nums">
        <span className="flex flex-col items-end leading-tight">
          <span>{inv.position.units}</span>
          <span className="text-xs text-muted-foreground sm:hidden">
            <UnitPrice
              live={inv.unitPriceLatest}
              cached={inv.unitPriceCached}
              cachedAt={inv.unitPriceCachedAt}
              prefix="@ "
            />
          </span>
        </span>
      </TableCell>
      <TableCell className="hidden text-right tabular-nums align-middle sm:table-cell">
        <UnitPrice
          live={inv.unitPriceLatest}
          cached={inv.unitPriceCached}
          cachedAt={inv.unitPriceCachedAt}
        />
      </TableCell>
      <TableCell className="text-right align-middle sm:hidden">
        <div className="flex flex-col items-end leading-tight">
          <span className="tabular-nums">
            {inv.position.totalValue ? (
              <Figure data={inv.position.totalValue} compact />
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </span>
          <span className={cn("text-xs tabular-nums", gainColor)}>
            {inv.position.totalGain ? (
              <Figure data={inv.position.totalGain} compact />
            ) : (
              "—"
            )}
            {inv.position.percentGain != null && (
              <span className="ml-1">
                ({(inv.position.percentGain * 100).toFixed(1)}%)
              </span>
            )}
          </span>
          {inv.position.reinvested.value &&
            inv.position.reinvested.value.amount !== 0 && (
              <span className="text-xs tabular-nums text-muted-foreground">
                DRIP <Figure data={inv.position.reinvested.value} compact />
              </span>
            )}
        </div>
      </TableCell>
      <TableCell className="hidden text-right align-middle sm:table-cell">
        {inv.position.totalValue ? (
          <Figure data={inv.position.totalValue} compact />
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell
        className={cn(
          "hidden text-right align-middle sm:table-cell",
          gainColor,
        )}
      >
        {inv.position.totalGain ? (
          <Figure data={inv.position.totalGain} compact />
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell
        className={cn(
          "hidden text-right tabular-nums align-middle sm:table-cell",
          gainColor,
        )}
      >
        {inv.position.percentGain == null
          ? "—"
          : `${(inv.position.percentGain * 100).toFixed(2)}%`}
      </TableCell>
      <TableCell className="hidden text-right tabular-nums align-middle text-muted-foreground sm:table-cell">
        {inv.position.reinvested.value &&
        inv.position.reinvested.value.amount !== 0 ? (
          <Figure data={inv.position.reinvested.value} compact />
        ) : (
          "—"
        )}
      </TableCell>
    </TableRow>
  );
}

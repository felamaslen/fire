import { useQuery } from "@apollo/client/react";
import { useEffect, useRef, useState } from "react";

import { Figure, FigureDocument } from "@/components/figure";
import { cn } from "@/lib/cn";

import { graphql, readFragment } from "../../graphql";

export const PortfolioHeadlineFragment = graphql(
  `
    fragment PortfolioHeadline on Portfolio {
      id
      currency
      totalValue {
        ...Figure
      }
      totalGain {
        amount
        ...Figure
      }
      xirr
      dailyGainValue {
        amount
        ...Figure
      }
      dailyGainPercent
    }
  `,
  [FigureDocument],
);

/**
 * Poll document for the headline — always with `skipLive: false` so the
 * returned Portfolio values reflect the real live-quote picture, independent
 * of the page-level query's `skipLive: true` snapshot. Also re-fetches each
 * non-sold holding's `position(filterAssetId)` so rows in the table (which
 * read `Investment:id → position(filterAssetId: X)` from Apollo's normalised
 * cache) update in-place when the poll lands — no per-row refetch needed.
 */
const PortfolioHeadlineLiveDocument = graphql(
  `
    query PortfolioHeadlineLive($filterAssetId: ID, $filterAssetIdIn: [ID!]) {
      portfolio(filterAssetIdIn: $filterAssetIdIn, skipLive: false) {
        ...PortfolioHeadline
      }
      investments(first: 1000, filterAssetId: $filterAssetId) {
        edges {
          node {
            id
            position(filterAssetId: $filterAssetId) {
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
          }
        }
      }
    }
  `,
  [PortfolioHeadlineFragment, FigureDocument],
);

/**
 * Cache-only read of the `skipLive: true` snapshot the page-level
 * `InvestmentsPage` query already populated. Used to render the headline
 * synchronously on first mount — the live fetch is delayed ~1s so the user
 * sees yesterday's close first and then the flash when today's live value
 * lands, instead of the two arriving simultaneously.
 */
const PortfolioHeadlineCachedDocument = graphql(
  `
    query PortfolioHeadlineCached($filterAssetIdIn: [ID!]) {
      portfolio(filterAssetIdIn: $filterAssetIdIn, skipLive: true) {
        ...PortfolioHeadline
      }
    }
  `,
  [PortfolioHeadlineFragment],
);

type FlashDirection = "up" | "down" | "same" | null;

/**
 * Flash direction hook for the daily-gain cell:
 *
 * - When a value first becomes available (after the `skipLive: true` snapshot, which reports `null`, is replaced by the live fetch), flash based on the value's sign — blue for up, red for down, yellow for zero.
 * - On every later poll, flash based on the delta — blue if the number rose, red if it fell, yellow if it didn't move (so the user still gets feedback that the poll landed).
 *
 * Each flash lasts ~1.2 s then decays back to `null`.
 */
function useDailyGainFlash(current: number | null | undefined): FlashDirection {
  const prevValueRef = useRef<number | null | undefined>(undefined);
  const [flash, setFlash] = useState<FlashDirection>(null);

  useEffect(() => {
    const prev = prevValueRef.current;
    prevValueRef.current = current;

    if (current == null) return;

    let dir: FlashDirection;
    if (prev == null) {
      // First render with a concrete value — either the very first sample
      // or the live fetch landing after a `null` cached snapshot. Flash
      // based on the sign so the user sees the arrival.
      if (current > 0) dir = "up";
      else if (current < 0) dir = "down";
      else dir = "same";
    } else if (current > prev) dir = "up";
    else if (current < prev) dir = "down";
    else dir = "same";

    setFlash(dir);
    const t = setTimeout(() => setFlash(null), 1200);
    return () => clearTimeout(t);
  }, [current]);

  return flash;
}

export function PortfolioHeadline({
  filterAssetIds,
  rightSlot,
}: {
  filterAssetIds: string[];
  rightSlot?: React.ReactNode;
}) {
  const filterAssetIdIn = filterAssetIds.length > 0 ? filterAssetIds : null;
  // Per-row position refresh only works with a singular `filterAssetId` —
  // when 0 or 2+ portfolios are selected, fall back to the unfiltered
  // positions (which the investments list shows anyway).
  const filterAssetId = filterAssetIds.length === 1 ? filterAssetIds[0] : null;

  // First render: read the `skipLive: true` snapshot the page-level query
  // already populated. Synchronous cache hit — the headline renders
  // yesterday's close values immediately.
  const cachedQuery = useQuery(PortfolioHeadlineCachedDocument, {
    variables: { filterAssetIdIn },
    fetchPolicy: "cache-only",
  });

  // Delay the first live fetch by ~1 s so the user sees yesterday's values
  // land first, then watches the flash when today's live total arrives.
  // Without this, both arrive in the same paint and the flash is invisible.
  const [fetchLive, setFetchLive] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setFetchLive(true), 1000);
    return () => clearTimeout(t);
  }, []);

  // Live fetch (skipLive: false). Separate cache key from the cached doc
  // (Apollo keys fields by arg), so this always hits the server once on
  // first enable, then polls every 30 s. The same query also re-fetches
  // each non-sold holding's `position(filterAssetId)` so the investments
  // table (which reads `Investment:id → position(filterAssetId)` from
  // Apollo's normalised cache) refreshes in place without its own poll.
  const liveQuery = useQuery(PortfolioHeadlineLiveDocument, {
    variables: { filterAssetId, filterAssetIdIn },
    pollInterval: 30_000,
    notifyOnNetworkStatusChange: false,
    skip: !fetchLive,
  });

  // Prefer the live data once it lands; fall back to the cached snapshot
  // while we're still in the pre-fetch delay or the first live response is
  // in flight.
  const raw =
    liveQuery.data?.portfolio ??
    liveQuery.previousData?.portfolio ??
    cachedQuery.data?.portfolio;
  const portfolio = raw ? readFragment(PortfolioHeadlineFragment, raw) : null;
  const flash = useDailyGainFlash(portfolio?.dailyGainValue?.amount);

  return (
    <section className="flex flex-col gap-y-1 rounded-md border px-2 py-1 text-xs sm:flex-row sm:flex-wrap sm:gap-x-6 sm:gap-y-2 sm:px-4 sm:py-2 sm:text-sm">
      <Stat label="Value">
        {portfolio?.totalValue ? <Figure data={portfolio.totalValue} /> : "—"}
      </Stat>
      <Stat
        label="Total gain"
        colorSign={portfolio?.totalGain?.amount}
        sub={
          portfolio?.xirr != null
            ? `${(portfolio.xirr * 100).toFixed(2)}% / yr`
            : null
        }
      >
        {portfolio?.totalGain ? <Figure data={portfolio.totalGain} /> : "—"}
      </Stat>
      <Stat
        label="Today"
        flash={flash}
        colorSign={portfolio?.dailyGainValue?.amount}
        sub={
          portfolio?.dailyGainPercent != null
            ? `${(portfolio.dailyGainPercent * 100).toFixed(2)}%`
            : null
        }
      >
        {portfolio?.dailyGainValue ? (
          <Figure data={portfolio.dailyGainValue} />
        ) : (
          "—"
        )}
      </Stat>
      {rightSlot ? (
        <div className="ml-auto flex items-center">{rightSlot}</div>
      ) : null}
    </section>
  );
}

function signColor(amount: number | null | undefined): string {
  if (amount == null || amount === 0) return "";
  return amount > 0
    ? "text-sky-600 dark:text-sky-400"
    : "text-red-600 dark:text-red-400";
}

function Stat({
  label,
  sub,
  flash,
  colorSign,
  children,
}: {
  label: string;
  sub?: string | null;
  flash?: FlashDirection;
  colorSign?: number | null;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "-mx-2 flex items-center gap-2 rounded px-2 py-0.5 transition-colors duration-700",
        flash === "up" && "bg-sky-500/20 dark:bg-sky-500/30",
        flash === "down" && "bg-red-500/20 dark:bg-red-500/30",
        flash === "same" && "bg-yellow-400/20 dark:bg-yellow-400/30",
      )}
    >
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn("font-semibold tabular-nums", signColor(colorSign))}>
        {children}
      </span>
      {sub ? (
        <span className={cn("text-xs tabular-nums", signColor(colorSign))}>
          {sub}
        </span>
      ) : null}
    </div>
  );
}

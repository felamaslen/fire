import { useQuery, useSubscription } from "@apollo/client/react";
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
 * Subscription for the live headline + per-row figures. The server pushes a
 * fresh tick every 30 s with `skipLive: false`, plus each currently-held
 * investment's `position(filterAssetIdIn)`, `unitPriceLatest`, and
 * `unitPriceCachedAt`. Apollo normalises by `(typename, id)` so the
 * investments table updates in place — no per-row poll needed.
 */
const PortfolioLiveDocument = graphql(
  `
    subscription PortfolioLive($filterAssetIdIn: [ID!]) {
      portfolioLive(filterAssetIdIn: $filterAssetIdIn) {
        portfolio {
          ...PortfolioHeadline
        }
        investments {
          id
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

  // First render: read the `skipLive: true` snapshot the page-level query
  // already populated. Synchronous cache hit — the headline renders
  // yesterday's close values immediately.
  const cachedQuery = useQuery(PortfolioHeadlineCachedDocument, {
    variables: { filterAssetIdIn },
    fetchPolicy: "cache-only",
  });

  // Delay subscribing by ~1 s so the user sees yesterday's values land
  // first, then watches the flash when today's live total arrives.
  // Without this, both arrive in the same paint and the flash is invisible.
  const [fetchLive, setFetchLive] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setFetchLive(true), 1000);
    return () => clearTimeout(t);
  }, []);

  // Live subscription (server emits every 30 s with `skipLive: false`).
  // Each tick carries refreshed Portfolio aggregates plus every held
  // investment's `position`, `unitPriceLatest`, and `unitPriceCachedAt`.
  // Apollo normalises per-investment fields by id, so the table refreshes
  // in place without its own poll.
  const liveSub = useSubscription(PortfolioLiveDocument, {
    variables: { filterAssetIdIn },
    skip: !fetchLive,
  });

  // Prefer the live tick once it lands; fall back to the cached snapshot
  // while we're still in the pre-subscribe delay or the first event is in
  // flight.
  const raw =
    liveSub.data?.portfolioLive?.portfolio ?? cachedQuery.data?.portfolio;
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

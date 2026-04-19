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
      xirr(skipLive: $skipLive)
      dailyGainValue(skipLive: $skipLive) {
        amount
        ...Figure
      }
      dailyGainPercent(skipLive: $skipLive)
    }
  `,
  [FigureDocument],
);

const PortfolioHeadlineDocument = graphql(
  `
    query PortfolioHeadline($skipLive: Boolean!, $filterAssetIdIn: [ID!]) {
      portfolio(filterAssetIdIn: $filterAssetIdIn) {
        ...PortfolioHeadline
      }
    }
  `,
  [PortfolioHeadlineFragment],
);

type FlashDirection = "up" | "down" | null;

/**
 * Flash direction hook for the daily-gain cell:
 *
 * - On the **first** sample (cached-only, skipLive=true): no flash.
 * - On the **first live** sample (skipLive just flipped to false): flash based
 *   on the sign of the value itself — blue if the day is up, red if it's down.
 * - On **every later** sample (subsequent polls): flash based on the delta —
 *   blue if the number rose since the last poll, red if it fell.
 *
 * Each flash lasts ~1.2 s, then decays back to `null`.
 */
function useDailyGainFlash(
  current: number | null | undefined,
  skipLive: boolean,
): FlashDirection {
  const prevValueRef = useRef<number | null | undefined>(undefined);
  const hasSeenLiveRef = useRef(false);
  const [flash, setFlash] = useState<FlashDirection>(null);

  useEffect(() => {
    const prev = prevValueRef.current;
    prevValueRef.current = current;

    if (current == null || skipLive) return;

    // The effect re-runs the moment `skipLive` flips — at that point the live
    // query is still in flight and `current` is whatever the cached-only
    // fetch returned. Only treat the first *value change* under
    // `skipLive === false` as the actual live sample; otherwise the "first
    // live flash" fires against the cached number.
    if (current === prev) return;

    let dir: FlashDirection = null;
    if (!hasSeenLiveRef.current) {
      hasSeenLiveRef.current = true;
      if (current > 0) dir = "up";
      else if (current < 0) dir = "down";
    } else if (prev !== undefined && prev !== null) {
      dir = current > prev ? "up" : "down";
    }

    if (!dir) return;
    setFlash(dir);
    const t = setTimeout(() => setFlash(null), 1200);
    return () => clearTimeout(t);
  }, [current, skipLive]);

  return flash;
}

export function PortfolioHeadline({
  filterAssetId,
  rightSlot,
}: {
  filterAssetId?: string | null;
  rightSlot?: React.ReactNode;
}) {
  // First fetch without live pricing so the page renders quickly with
  // DB-cached values; after a short delay, swap to live pricing so the flash
  // fires even on a cache hit (the live quote shifts yesterday's close into
  // `pricePrevious` and computes a new delta).
  const [skipLive, setSkipLive] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setSkipLive(false), 800);
    return () => clearTimeout(t);
  }, []);

  const filterAssetIdIn = filterAssetId ? [filterAssetId] : null;
  const { data, previousData } = useQuery(PortfolioHeadlineDocument, {
    variables: { skipLive, filterAssetIdIn },
    pollInterval: 30_000,
    notifyOnNetworkStatusChange: false,
  });
  // Keep the previous render's values mounted while the refetch (e.g. when we
  // flip `skipLive`) is in flight — otherwise the headline briefly empties.
  const raw = (data ?? previousData)?.portfolio;
  const portfolio = raw ? readFragment(PortfolioHeadlineFragment, raw) : null;
  const flash = useDailyGainFlash(portfolio?.dailyGainValue?.amount, skipLive);

  return (
    <section className="flex flex-wrap gap-x-6 gap-y-2 rounded-md border px-4 py-2 text-sm">
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
        "-mx-2 flex items-baseline gap-2 rounded px-2 py-0.5 transition-colors duration-700",
        flash === "up" && "bg-sky-500/20 dark:bg-sky-500/30",
        flash === "down" && "bg-red-500/20 dark:bg-red-500/30",
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

import { useQuery } from "@apollo/client/react";
import { useEffect, useRef, useState } from "react";

import { Figure, FigureDocument } from "@/components/figure";
import { cn } from "@/lib/cn";

import { graphql } from "../../graphql";

const PortfolioHeadlineDocument = graphql(
  `
    query PortfolioHeadline($skipLive: Boolean!) {
      portfolio {
        id
        currency
        totalValue { ...Figure }
        totalGain { amount ...Figure }
        percentGain
        dailyGainValue(skipLive: $skipLive) { amount ...Figure }
        dailyGainPercent(skipLive: $skipLive)
      }
    }
  `,
  [FigureDocument],
);

type FlashDirection = "up" | "down" | null;

/**
 * Compare `current` to the previous rendered value; when it changes, return
 * `"up"` or `"down"` for ~1.2s then fall back to `null`. Ignores the initial
 * render (no flash on first arrival).
 */
function useFlashOnChange(current: number | null | undefined): FlashDirection {
  const prevRef = useRef<number | null | undefined>(undefined);
  const [flash, setFlash] = useState<FlashDirection>(null);

  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = current;
    if (prev === undefined) return; // first render
    if (current == null || prev == null) return;
    if (current === prev) return;
    const dir: FlashDirection = current > prev ? "up" : "down";
    setFlash(dir);
    const t = setTimeout(() => setFlash(null), 1200);
    return () => clearTimeout(t);
  }, [current]);

  return flash;
}

export function PortfolioHeadline() {
  // First fetch without live pricing so the page renders quickly with
  // DB-cached values; after a short delay, swap to live pricing so the flash
  // fires even on a cache hit (the live quote shifts yesterday's close into
  // `pricePrevious` and computes a new delta).
  const [skipLive, setSkipLive] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setSkipLive(false), 800);
    return () => clearTimeout(t);
  }, []);

  const { data, previousData } = useQuery(PortfolioHeadlineDocument, {
    variables: { skipLive },
    pollInterval: 30_000,
    notifyOnNetworkStatusChange: false,
  });
  // Keep the previous render's values mounted while the refetch (e.g. when we
  // flip `skipLive`) is in flight — otherwise the headline briefly empties.
  const portfolio = (data ?? previousData)?.portfolio;
  const flash = useFlashOnChange(portfolio?.dailyGainValue?.amount);

  return (
    <section className="flex flex-wrap gap-x-6 gap-y-2 rounded-md border px-4 py-2 text-sm">
      <Stat label="Value">
        {portfolio?.totalValue ? (
          <Figure data={portfolio.totalValue} />
        ) : (
          "—"
        )}
      </Stat>
      <Stat
        label="Total gain"
        colorSign={portfolio?.totalGain?.amount}
        sub={
          portfolio?.percentGain != null
            ? `${(portfolio.percentGain * 100).toFixed(2)}%`
            : null
        }
      >
        {portfolio?.totalGain ? (
          <Figure data={portfolio.totalGain} />
        ) : (
          "—"
        )}
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
    </section>
  );
}

function signColor(amount: number | null | undefined): string {
  if (amount == null || amount === 0) return "";
  return amount > 0
    ? "text-emerald-600 dark:text-emerald-400"
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
      <span
        className={cn("font-semibold tabular-nums", signColor(colorSign))}
      >
        {children}
      </span>
      {sub ? (
        <span
          className={cn("text-xs tabular-nums", signColor(colorSign))}
        >
          {sub}
        </span>
      ) : null}
    </div>
  );
}

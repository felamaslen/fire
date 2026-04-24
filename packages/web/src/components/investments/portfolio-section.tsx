import { useSuspenseQuery } from "@apollo/client/react";
import { useDeferredValue } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { colorForKey } from "@/lib/color-for-key";

import { graphql, readFragment } from "../../graphql";
import { PortfolioChart, PortfolioChartLegend } from "./portfolio-chart";

export const PortfolioChartPortfolioFragment = graphql(`
  fragment PortfolioChartPortfolio on Portfolio {
    id
    currency
    totalValue {
      amount
      currency
    }
    totalGain {
      amount
      currency
    }
    percentGain
    timeseries(period: $period, length: $length) @skip(if: $candlestick) {
      currency
      initialDate
      points {
        x
        y
      }
    }
    candlestick(unit: $candleUnit, length: $candleLength)
      @include(if: $candlestick) {
      currency
      initialDate
      points {
        x0
        x1
        from
        to
        lo
        hi
      }
    }
  }
`);

const PortfolioChartDocument = graphql(
  `
    query PortfolioChart(
      $period: PortfolioTimePeriod!
      $length: Int
      $candleUnit: PortfolioCandleUnit!
      $candleLength: Int!
      $candlestick: Boolean!
      $stack: Boolean!
      $filterAssetIdIn: [ID!]
    ) {
      portfolio(filterAssetIdIn: $filterAssetIdIn) {
        ...PortfolioChartPortfolio
      }
      portfolios(filterAssetIdIn: $filterAssetIdIn) @include(if: $stack) {
        edges {
          node {
            id
            investment {
              id
              name
              asset {
                ... on InvestmentStock {
                  code
                }
              }
              position(filterAssetIdIn: $filterAssetIdIn) {
                totalValue {
                  amount
                }
              }
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
  [PortfolioChartPortfolioFragment],
);

type Period =
  | { period: "YEAR"; length: number; label: string }
  | { period: "MONTH"; length: number; label: string }
  | { period: "YTD"; length: 0; label: string }
  | { period: "ALL"; length: 0; label: string };

export const PORTFOLIO_PERIODS: Period[] = [
  { period: "ALL", length: 0, label: "All" },
  { period: "YEAR", length: 5, label: "5y" },
  { period: "YEAR", length: 3, label: "3y" },
  { period: "YEAR", length: 1, label: "1y" },
  { period: "YTD", length: 0, label: "YTD" },
  { period: "MONTH", length: 3, label: "3m" },
];

/** Candle widths, ordered from narrowest to widest. `section` groups adjacent buttons with the same base unit so the button group can be rendered with visual separators between days / weeks / months. */
export const PORTFOLIO_CANDLES = [
  { unit: "DAY", length: 3, label: "3D", section: "day" },
  { unit: "WEEK", length: 1, label: "1W", section: "week" },
  { unit: "WEEK", length: 2, label: "2W", section: "week" },
  { unit: "MONTH", length: 1, label: "1M", section: "month" },
  { unit: "MONTH", length: 3, label: "3M", section: "month" },
] as const;

export type PortfolioChartSettings = {
  periodIdx: number;
  candleIdx: number;
  mode: "line" | "candlestick";
  stack: boolean;
};

export function PortfolioSection({
  settings,
  onChange,
  bottomSlot,
  filterAssetIds,
  selectedLabel,
}: {
  settings: PortfolioChartSettings;
  onChange: (next: PortfolioChartSettings) => void;
  bottomSlot?: React.ReactNode;
  filterAssetIds: string[];
  /** Comma-joined names of the selected portfolios, or `null` when all are selected. Used as the line label in the hover tooltip so the user sees which portfolios they've scoped the chart to. */
  selectedLabel: string | null;
}) {
  const { periodIdx, candleIdx, mode, stack } = settings;
  const update = (patch: Partial<PortfolioChartSettings>) =>
    onChange({ ...settings, ...patch });

  const p = PORTFOLIO_PERIODS[periodIdx];
  const candle = PORTFOLIO_CANDLES[candleIdx] ?? PORTFOLIO_CANDLES[2];

  // The draggable allocation bar only renders when exactly one portfolio is
  // selected, so only reserve the taller padding in that case.
  const singleSelection = filterAssetIds.length === 1;

  return (
    <section
      className={cn(
        "relative space-y-0 rounded-lg border sm:space-y-3 sm:p-4",
        singleSelection ? "pb-12 sm:pb-4" : "pb-8 sm:pb-4",
      )}
    >
      <header className="flex flex-col gap-0.5 px-0.5 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-2 sm:px-0">
        <h2 className="sr-only sm:not-sr-only sm:text-sm sm:font-semibold">
          Portfolio
        </h2>
        <div className="flex flex-wrap gap-0.5 text-xs sm:gap-1">
          {mode === "candlestick"
            ? PORTFOLIO_CANDLES.map((c, i) => {
                const prev = i > 0 ? PORTFOLIO_CANDLES[i - 1] : null;
                const sectionBreak = prev && prev.section !== c.section;
                return (
                  <span key={c.label} className="flex gap-0.5 sm:gap-1">
                    {sectionBreak && <span className="mx-1" />}
                    <Button
                      size="sm"
                      variant={i === candleIdx ? "default" : "outline"}
                      onClick={() => update({ candleIdx: i })}
                      className="h-6 px-1.5 text-[10px] sm:h-8 sm:px-3 sm:text-xs"
                    >
                      {c.label}
                    </Button>
                  </span>
                );
              })
            : PORTFOLIO_PERIODS.map((per, i) => (
                <Button
                  key={per.label}
                  size="sm"
                  variant={i === periodIdx ? "default" : "outline"}
                  onClick={() => update({ periodIdx: i })}
                  className="h-6 px-1.5 text-[10px] sm:h-8 sm:px-3 sm:text-xs"
                >
                  {per.label}
                </Button>
              ))}
        </div>
        <div className="flex flex-wrap gap-0.5 text-xs sm:gap-1">
          <Button
            size="sm"
            variant={mode === "line" ? "default" : "outline"}
            onClick={() => update({ mode: "line" })}
            className="h-6 px-1.5 text-[10px] sm:h-8 sm:px-3 sm:text-xs"
          >
            Line
          </Button>
          <Button
            size="sm"
            variant={mode === "candlestick" ? "default" : "outline"}
            onClick={() => update({ mode: "candlestick" })}
            className="h-6 px-1.5 text-[10px] sm:h-8 sm:px-3 sm:text-xs"
          >
            Candle
          </Button>
          <Button
            size="sm"
            variant={stack ? "default" : "outline"}
            disabled={mode === "candlestick"}
            onClick={() => update({ stack: !stack })}
            className="h-6 px-1.5 text-[10px] sm:h-8 sm:px-3 sm:text-xs"
          >
            Stacked
          </Button>
        </div>
      </header>
      <PortfolioChartLoader
        period={p.period}
        length={"length" in p ? p.length : null}
        candleUnit={candle.unit}
        candleLength={candle.length}
        candlestick={mode === "candlestick"}
        stack={stack}
        filterAssetIds={filterAssetIds}
        selectedLabel={selectedLabel}
      />
      {bottomSlot}
    </section>
  );
}

function PortfolioChartLoader({
  period,
  length,
  candleUnit,
  candleLength,
  candlestick,
  stack,
  filterAssetIds,
  selectedLabel,
}: {
  period: "YEAR" | "MONTH" | "YTD" | "ALL";
  length: number | null;
  candleUnit: "DAY" | "WEEK" | "MONTH";
  candleLength: number;
  candlestick: boolean;
  stack: boolean;
  filterAssetIds: string[];
  selectedLabel: string | null;
}) {
  // `useSuspenseQuery` bubbles its suspend up to the page-level Suspense,
  // so the whole page waits for chart data before painting — no layout
  // shift when the chart finally arrives.
  //
  // For subsequent variable changes (mode / period / stack) we'd normally
  // rely on `useTransition` to hold the Suspense fallback, but TanStack
  // Router's internal `useSyncExternalStore` opts out of transitions and
  // the page-level fallback would fire immediately. `useDeferredValue`
  // doesn't depend on how the source updated — it just defers re-reading
  // the new value until its work can complete, keeping the previous
  // render mounted while the suspense resolves.
  const deferredPeriod = useDeferredValue(period);
  const deferredLength = useDeferredValue(length);
  const deferredCandleUnit = useDeferredValue(candleUnit);
  const deferredCandleLength = useDeferredValue(candleLength);
  const deferredCandlestick = useDeferredValue(candlestick);
  const deferredStack = useDeferredValue(stack);
  // Defer via a stable string key so a new-but-equal `string[]` reference
  // from the parent doesn't churn the deferred identity and re-fire the
  // suspense query.
  const filterKey = filterAssetIds.join(",");
  const deferredFilterKey = useDeferredValue(filterKey);
  const deferredFilterAssetIds = deferredFilterKey
    ? deferredFilterKey.split(",")
    : [];
  const pending =
    deferredPeriod !== period ||
    deferredLength !== length ||
    deferredCandleUnit !== candleUnit ||
    deferredCandleLength !== candleLength ||
    deferredCandlestick !== candlestick ||
    deferredStack !== stack ||
    deferredFilterKey !== filterKey;
  const { data } = useSuspenseQuery(PortfolioChartDocument, {
    variables: {
      period: deferredPeriod,
      length: deferredLength,
      candleUnit: deferredCandleUnit,
      candleLength: deferredCandleLength,
      candlestick: deferredCandlestick,
      stack: deferredStack,
      filterAssetIdIn:
        deferredFilterAssetIds.length > 0 ? deferredFilterAssetIds : null,
    },
  });

  const rawPortfolio = data.portfolio;
  const portfolio = rawPortfolio
    ? readFragment(PortfolioChartPortfolioFragment, rawPortfolio)
    : null;

  // Sort per-investment series by current / realised value (descending) so
  // the biggest holdings anchor the bottom of the stack and the legend reads
  // in size order. Labels prefer the stock code (compact), with the full
  // name surfaced via tooltip.
  const perInvestmentSeries = (data.portfolios?.edges ?? [])
    .flatMap((edge) => {
      const ts = edge.node.timeseries;
      if (!ts) return [];
      const inv = edge.node.investment;
      const code =
        inv?.asset?.__typename === "InvestmentStock" ? inv.asset.code : null;
      const label = code ?? inv?.name ?? "?";
      return [
        {
          label,
          tooltip: inv?.name ?? "",
          sortValue: inv?.position.totalValue?.amount ?? 0,
          points: ts.points,
          initialDate: ts.initialDate,
          colorKey: code ?? inv?.name ?? label,
        },
      ];
    })
    .sort((a, b) => b.sortValue - a.sortValue)
    .map((s) => ({
      label: s.label,
      tooltip: s.tooltip,
      color: colorForKey(s.colorKey),
      points: s.points,
      initialDate: s.initialDate,
    }));

  const { lines, stackInitialDate } = deferredStack
    ? stackLines(perInvestmentSeries)
    : {
        lines: portfolio?.timeseries
          ? [
              {
                label: selectedLabel ?? "Portfolio",
                color: "#6366f1",
                points: portfolio.timeseries.points,
              },
            ]
          : [],
        stackInitialDate: portfolio?.timeseries?.initialDate ?? null,
      };

  // Pass the full (x0, x1) bucket span through so the chart can place each
  // candle along the shared time axis instead of evenly distributing them
  // across the plot width.
  const candles = portfolio?.candlestick
    ? {
        points: portfolio.candlestick.points.map((p) => ({
          x0: p.x0,
          x1: p.x1,
          from: p.from,
          to: p.to,
          lo: p.lo,
          hi: p.hi,
        })),
      }
    : null;

  const initialDateStr =
    stackInitialDate ??
    portfolio?.timeseries?.initialDate ??
    portfolio?.candlestick?.initialDate ??
    null;

  const initialDate =
    typeof initialDateStr === "string"
      ? new Date(`${initialDateStr}T00:00:00Z`)
      : undefined;

  return (
    <div
      className={cn(
        "space-y-2 transition-opacity",
        pending && "pointer-events-none opacity-50",
      )}
    >
      <PortfolioChart
        lines={deferredCandlestick ? undefined : lines}
        candles={deferredCandlestick ? candles : null}
        currency={portfolio?.currency ?? "GBP"}
        initialDate={initialDate}
        stacked={!deferredCandlestick && deferredStack}
        className="w-full"
      />
      {!deferredCandlestick && deferredStack && lines.length > 1 && (
        <PortfolioChartLegend lines={lines} />
      )}
    </div>
  );
}

type SeriesIn = {
  label: string;
  tooltip?: string;
  color: string;
  points: { x: number; y: number }[];
  initialDate: string;
};

type SeriesOut = {
  label: string;
  tooltip?: string;
  color: string;
  points: { x: number; y: number }[];
};

/**
 * Turn a list of per-investment series into cumulative stacked lines:
 *
 * 1. Each series carries its own `initialDate`, so `x` (days since that date)
 *    is series-local. Re-anchor every series onto a shared `stackInitialDate`
 *    (the earliest `initialDate` across the set) so `x` is a shared calendar
 *    co-ordinate.
 * 2. Union the re-anchored x domain, filling gaps with each series' nearest
 *    earlier point — or zero when the series hadn't started yet on that day.
 *    This keeps the cumulative running total continuous instead of dropping
 *    to zero on every x an individual series happens not to have a sample for.
 * 3. Cumulate vertically: each output series' `y` at `x` = its own `y` plus
 *    every prior series' `y`. The top line therefore equals the total
 *    portfolio value and no two lines cross.
 */
function stackLines(series: SeriesIn[]): {
  lines: SeriesOut[];
  stackInitialDate: string | null;
} {
  if (series.length === 0) return { lines: [], stackInitialDate: null };

  const ONE_DAY_MS = 86400 * 1000;
  const initialMs = series.map((s) =>
    new Date(`${s.initialDate}T00:00:00Z`).getTime(),
  );
  const globalInitialMs = Math.min(...initialMs);
  const stackInitialDate = new Date(globalInitialMs).toISOString().slice(0, 10);

  // Re-anchor each series to `globalInitialMs`: shift its x by the number of
  // days between its own initialDate and the shared one.
  const reanchored = series.map((s, i) => {
    const offset = Math.round((initialMs[i] - globalInitialMs) / ONE_DAY_MS);
    return s.points.map((p) => ({ x: p.x + offset, y: p.y }));
  });

  // Union of x values across all re-anchored series.
  const xs = new Set<number>();
  for (const pts of reanchored) for (const p of pts) xs.add(p.x);
  const xsSorted = [...xs].sort((a, b) => a - b);

  // For each series, build a lookup and an ordered list so we can carry the
  // last-seen y forward when a specific x is absent.
  const lookup = reanchored.map((pts) => {
    const m = new Map<number, number>();
    for (const p of pts) m.set(p.x, p.y);
    return m;
  });
  const firstX = reanchored.map((pts) => (pts.length ? pts[0].x : Infinity));

  const running = new Map<number, number>();
  for (const x of xsSorted) running.set(x, 0);

  const lines: SeriesOut[] = series.map((s, i) => {
    const m = lookup[i];
    const start = firstX[i];
    let lastY = 0;
    const points = xsSorted.map((x) => {
      if (x < start) {
        lastY = 0;
      } else if (m.has(x)) {
        lastY = m.get(x) ?? 0;
      }
      // else: carry lastY forward (fills gaps within the series' own range).
      const prevTotal = running.get(x) ?? 0;
      const nextTotal = prevTotal + lastY;
      running.set(x, nextTotal);
      return { x, y: nextTotal };
    });
    return { label: s.label, tooltip: s.tooltip, color: s.color, points };
  });

  return { lines, stackInitialDate };
}

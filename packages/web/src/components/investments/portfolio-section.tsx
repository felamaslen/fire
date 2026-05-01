import { useApolloClient, useSuspenseQuery } from "@apollo/client/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
      endCursor
      hasMore
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

/** Standalone fetch for older candlestick pages. The initial page comes through the parent suspense query; on pinch-zoom-out the loader fires this query with `before` = previous page's `endCursor` to backfill. */
const PortfolioCandlestickPageDocument = graphql(`
  query PortfolioCandlestickPage(
    $filterAssetIdIn: [ID!]
    $candleUnit: PortfolioCandleUnit!
    $candleLength: Int!
    $before: ID
  ) {
    portfolio(filterAssetIdIn: $filterAssetIdIn) {
      id
      candlestick(unit: $candleUnit, length: $candleLength, before: $before) {
        initialDate
        endCursor
        hasMore
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
  }
`);

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
  transferOut,
  transfersIn,
}: {
  settings: PortfolioChartSettings;
  onChange: (next: PortfolioChartSettings) => void;
  bottomSlot?: React.ReactNode;
  filterAssetIds: string[];
  /** Comma-joined names of the selected portfolios, or `null` when all are selected. Used as the line label in the hover tooltip so the user sees which portfolios they've scoped the chart to. */
  selectedLabel: string | null;
  /** When the single selected portfolio has an outgoing transfer, render a vertical arrow on the chart at that date pointing to the destination wrapper. */
  transferOut?: {
    date: string;
    assetTo: { name: string };
  } | null;
  /** Each inbound transfer adds an arrow at the transfer date and tints the pre-transfer segment of the chart light-grey (since that history comes from a different wrapper). */
  transfersIn?: ReadonlyArray<{
    date: string;
    assetFrom: { name: string };
  }>;
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
        transferOut={transferOut ?? null}
        transfersIn={transfersIn ?? []}
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
  transferOut,
  transfersIn,
}: {
  period: "YEAR" | "MONTH" | "YTD" | "ALL";
  length: number | null;
  candleUnit: "DAY" | "WEEK" | "MONTH";
  candleLength: number;
  candlestick: boolean;
  stack: boolean;
  filterAssetIds: string[];
  selectedLabel: string | null;
  transferOut: {
    date: string;
    assetTo: { name: string };
  } | null;
  transfersIn: ReadonlyArray<{
    date: string;
    assetFrom: { name: string };
  }>;
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
      // Gate `stack` on `!candlestick`: the candlestick mode never uses
      // the stacked-line series (the toggle is disabled in the UI), and
      // the per-investment `portfolios` edge fetch is the heaviest part
      // of the query.
      stack: deferredStack && !deferredCandlestick,
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

  // Earliest inbound transfer date (when the wrapper has multiple sources,
  // we colour everything before *any* transfer as inbound — there's no clean
  // way to pick which source a particular pre-transfer point came from).
  const earliestTransferIn =
    transfersIn.length > 0
      ? transfersIn
          .map((t) => t.date)
          .reduce((a, b) => (a < b ? a : b), "9999-99-99")
      : null;

  const { lines, stackInitialDate } = deferredStack
    ? stackLines(perInvestmentSeries)
    : (() => {
        if (!portfolio?.timeseries) {
          return { lines: [], stackInitialDate: null };
        }
        const seriesPoints = portfolio.timeseries.points;
        const seriesInitial = portfolio.timeseries.initialDate;
        // Single-source pre-transfer split: render points before the
        // transfer date in light-grey ("inherited from {source}") and
        // post-transfer points in the normal accent colour.
        if (earliestTransferIn) {
          const seriesInitialDate = new Date(`${seriesInitial}T00:00:00Z`);
          const transferDays = Math.round(
            (new Date(`${earliestTransferIn}T00:00:00Z`).getTime() -
              seriesInitialDate.getTime()) /
              86400000,
          );
          // Drop the split if the transfer pre-dates the series (no
          // pre-transfer history would render anyway).
          if (transferDays > 0) {
            // Find the index of the last sample at-or-before the transfer
            // date. Sample dates from the backend may not land exactly on
            // `transferDays`, so we anchor `post` at that same index — the
            // two segments share a point, and the purple line picks up
            // visually flush with where the grey line ended (rather than
            // jumping over a gap to the next sample).
            let splitIdx = -1;
            for (let i = 0; i < seriesPoints.length; i++) {
              if (seriesPoints[i].x <= transferDays) splitIdx = i;
              else break;
            }
            const pre =
              splitIdx >= 0 ? seriesPoints.slice(0, splitIdx + 1) : [];
            const post =
              splitIdx >= 0 ? seriesPoints.slice(splitIdx) : seriesPoints;
            const split: {
              label: string;
              color: string;
              points: typeof seriesPoints;
            }[] = [];
            if (pre.length > 0) {
              // Generic "Pre-transfer" label rather than the source's name —
              // the grey segment may also include the destination's own
              // pre-transfer activity, so naming a single source is
              // misleading. The transfer-in arrow / yellow header already
              // surface which source(s) flowed in.
              split.push({
                label: "Pre-transfer",
                color: "#9ca3af",
                points: pre,
              });
            }
            if (post.length > 0) {
              split.push({
                label: selectedLabel ?? "Portfolio",
                color: "#6366f1",
                points: post,
              });
            }
            return {
              lines: split,
              stackInitialDate: seriesInitial,
            };
          }
        }
        return {
          lines: [
            {
              label: selectedLabel ?? "Portfolio",
              color: "#6366f1",
              points: seriesPoints,
            },
          ],
          stackInitialDate: seriesInitial,
        };
      })();

  // Candlestick state machine: the parent suspense query above gives us
  // the "current window" page (most recent N candles ending today). On
  // pinch-zoom-out we backfill older pages via
  // `PortfolioCandlestickPageDocument` and merge them client-side onto a
  // shared X axis. The initial page lives at index 0; older pages
  // append as the user zooms out further.
  const initialCandlePage: CandlePage | null = portfolio?.candlestick
    ? {
        initialDate: portfolio.candlestick.initialDate,
        endCursor: portfolio.candlestick.endCursor ?? null,
        hasMore: portfolio.candlestick.hasMore,
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
  const {
    candles: paginatedCandles,
    candleInitialDate,
    viewport: candleViewport,
    onZoom,
  } = useCandlestickPagination({
    initialPage: initialCandlePage,
    candlestickEnabled: deferredCandlestick,
    filterAssetIds: deferredFilterAssetIds,
    candleUnit: deferredCandleUnit,
    candleLength: deferredCandleLength,
  });

  // Anchor the X axis on whichever series is actually being rendered:
  // candle x0/x1 are server-relative to `candlestick.initialDate`, while
  // line points are relative to `timeseries.initialDate` (or the
  // `stackLines`-computed shared anchor in stacked mode). Using the
  // wrong one when toggling stacked → candle drags every candle's
  // labelled date back to the earliest stacked-line anchor — visible
  // as "the chart ends years ago" even though candle xMax matches the
  // last bucket.
  const initialDateStr = deferredCandlestick
    ? candleInitialDate
    : (stackInitialDate ?? portfolio?.timeseries?.initialDate ?? null);

  const initialDate =
    typeof initialDateStr === "string"
      ? new Date(`${initialDateStr}T00:00:00Z`)
      : undefined;

  // Derive a chart annotation at the transfer-out date — only when the chart
  // has a calendar anchor and the transfer date falls inside the rendered
  // window. Outside-window transfers are skipped (the chart already ends at
  // the cap, so the marker would just sit on the right edge with no
  // information).
  const annotations = (() => {
    if (!initialDate) return undefined;
    const out: {
      x: number;
      label: string;
      tooltip: string;
      direction: "in" | "out";
    }[] = [];
    const dayOffset = (date: string) =>
      Math.round(
        (new Date(`${date}T00:00:00Z`).getTime() - initialDate.getTime()) /
          86400000,
      );
    if (transferOut) {
      const days = dayOffset(transferOut.date);
      if (days >= 0) {
        out.push({
          x: days,
          label: transferOut.assetTo.name,
          tooltip: `Transferred to ${transferOut.assetTo.name} on ${transferOut.date}`,
          direction: "out",
        });
      }
    }
    for (const t of transfersIn) {
      const days = dayOffset(t.date);
      if (days >= 0) {
        out.push({
          x: days,
          label: t.assetFrom.name,
          tooltip: `Transferred in from ${t.assetFrom.name} on ${t.date}`,
          direction: "in",
        });
      }
    }
    return out.length > 0 ? out : undefined;
  })();

  return (
    <div
      className={cn(
        "space-y-2 transition-opacity",
        pending && "pointer-events-none opacity-50",
      )}
    >
      <PortfolioChart
        lines={deferredCandlestick ? undefined : lines}
        candles={deferredCandlestick ? paginatedCandles : null}
        currency={portfolio?.currency ?? "GBP"}
        initialDate={initialDate}
        viewport={deferredCandlestick ? candleViewport : undefined}
        onZoom={deferredCandlestick ? onZoom : undefined}
        stacked={!deferredCandlestick && deferredStack}
        annotations={annotations}
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

type CandlePoint = {
  x0: number;
  x1: number;
  from: number;
  to: number;
  lo: number;
  hi: number;
};
type CandlePage = {
  initialDate: string;
  endCursor: string | null;
  hasMore: boolean;
  points: CandlePoint[];
};

const ONE_DAY_MS = 86400 * 1000;
/** Scaling factor turning a wheel-event `deltaY` into a zoom-span multiplier via `exp(deltaY × ZOOM_RATE)`. Calibrated by feel: a single notch of a discrete mouse wheel (`deltaY ≈ 100`) zooms by ~1.6×; a trackpad pinch fires many small `deltaY ≈ 1–4` events per second, so the per-frame integration ends up smooth rather than blowing past several years on a single gesture. */
const ZOOM_RATE = 0.005;
/** Wait 1 s after the user stops zooming before firing the older-page fetch. Every zoom event resets this timer, so a long continuous pinch only triggers a single network call once the user settles. */
const BACKFILL_DEBOUNCE_MS = 1000;

/**
 * Owns the candlestick pinch-zoom + cursor-paginated backfill state.
 *
 * Pages start with whatever the parent suspense query loaded (the initial
 * "today's window" page). On `onZoom(+1)` the visible span grows; once
 * it would extend past the leftmost loaded bucket the hook fires a
 * follow-up query keyed off the previous page's `endCursor` and
 * appends the result to `pages`. On `onZoom(-1)` the span shrinks; once
 * it's back at-or-under the initial-page span the viewport overlay is
 * dropped (the chart re-renders against just the initial page, same as
 * before zoom).
 *
 * The merged `candles` returned here has every page's points re-anchored
 * onto the *oldest loaded page's* `initialDate`, so `x0` / `x1` are
 * consistent across pages even as the tail expands. The chart's
 * `viewport` clips the visible portion of that merged series.
 */
function useCandlestickPagination({
  initialPage,
  candlestickEnabled,
  filterAssetIds,
  candleUnit,
  candleLength,
}: {
  initialPage: CandlePage | null;
  candlestickEnabled: boolean;
  filterAssetIds: string[];
  candleUnit: "DAY" | "WEEK" | "MONTH";
  candleLength: number;
}): {
  candles: { points: CandlePoint[] } | null;
  candleInitialDate: string | null;
  viewport: { xMin: number; xMax: number } | undefined;
  onZoom: (deltaY: number) => void;
} {
  const [pages, setPages] = useState<CandlePage[]>([]);
  // `null` = "use the initial page's natural span"; positive number =
  // viewport span override in days.
  const [viewportSpanDays, setViewportSpanDays] = useState<number | null>(null);
  const fetchInFlight = useRef(false);
  const apolloClient = useApolloClient();

  // Reset state whenever the candlestick scope changes (filter, unit,
  // length, or the candlestick toggle flips). Keep `initialPage` *out*
  // of the deps: it's reconstructed as a fresh object literal on every
  // parent render, so depending on it would re-run the effect after
  // every backfill / unrelated re-render. We resolve `initialPage` via
  // a ref at the moment the effect actually decides to reset, so the
  // page-1 data we plant is whatever the parent currently has — not
  // a stale snapshot.
  const filterKey = filterAssetIds.join(",");
  const baselineKey = `${candleUnit}|${candleLength}|${filterKey}|${candlestickEnabled ? "1" : "0"}`;
  const initialPageRef = useRef<CandlePage | null>(initialPage);
  initialPageRef.current = initialPage;
  const lastBaselineRef = useRef<string | null>(null);
  useEffect(() => {
    if (lastBaselineRef.current === baselineKey) return;
    lastBaselineRef.current = baselineKey;
    const fresh = initialPageRef.current;
    setPages(fresh ? [fresh] : []);
    setViewportSpanDays(null);
    fetchInFlight.current = false;
  }, [baselineKey]);

  // Independently of the scope-change reset above, seed `pages` on
  // first mount with the parent's initial page. Match by
  // `initialDate`: if the latest loaded page already starts on the
  // same boundary we'd be seeding, skip the update — `initialPage` is
  // reconstructed as a fresh object literal on every parent render,
  // so checking by reference would loop forever (re-seed → re-render
  // → re-seed). When the boundary genuinely moves (a new bucket
  // ticked over midnight), prepend the fresh page rather than
  // throwing away older backfilled pages.
  useEffect(() => {
    if (!initialPage) return;
    setPages((cur) => {
      if (cur.length === 0) return [initialPage];
      const latestIdx = cur.reduce(
        (best, p, i) =>
          p.initialDate.localeCompare(cur[best].initialDate) > 0 ? i : best,
        0,
      );
      if (cur[latestIdx].initialDate === initialPage.initialDate) return cur;
      return [...cur.filter((_, i) => i !== latestIdx), initialPage];
    });
  }, [initialPage]);

  const merged = useMemo(() => {
    if (pages.length === 0) {
      return {
        points: [] as CandlePoint[],
        oldestInitialDate: null as string | null,
        rightmostX: 0,
      };
    }
    // Sort pages oldest-first so re-anchoring is just `offset` per page.
    const sorted = [...pages].sort((a, b) =>
      a.initialDate.localeCompare(b.initialDate),
    );
    const oldest = sorted[0].initialDate;
    const oldestMs = new Date(`${oldest}T00:00:00Z`).getTime();
    const points: CandlePoint[] = [];
    for (const page of sorted) {
      const pageMs = new Date(`${page.initialDate}T00:00:00Z`).getTime();
      const offset = Math.round((pageMs - oldestMs) / ONE_DAY_MS);
      for (const p of page.points) {
        points.push({
          x0: p.x0 + offset,
          x1: p.x1 + offset,
          from: p.from,
          to: p.to,
          lo: p.lo,
          hi: p.hi,
        });
      }
    }
    points.sort((a, b) => a.x0 - b.x0);
    const rightmostX = points.length > 0 ? points[points.length - 1].x1 : 0;
    return { points, oldestInitialDate: oldest, rightmostX };
  }, [pages]);

  // Initial-page span = the natural width of the first-loaded page. Used
  // as the baseline for "zoom reset" — once the user pinches back to or
  // past this span the viewport override drops to null.
  const initialSpan = useMemo(() => {
    if (!initialPage || initialPage.points.length === 0) return 0;
    const last = initialPage.points[initialPage.points.length - 1];
    const first = initialPage.points[0];
    return last.x1 - first.x0;
  }, [initialPage]);

  // Backfill: when the visible span exceeds the loaded data span and we
  // haven't told `hasMore = false`, fetch the next older page — but
  // wait `BACKFILL_DEBOUNCE_MS` after the last viewport change before
  // firing. The visible viewport extends past loaded data immediately
  // (the chart shows empty space at the left edge during the gesture),
  // and the older page lands quietly once the user has settled on a
  // zoom level. Without this debounce, an aggressive pinch-out fires a
  // chain of `before:` queries faster than they can return.
  const fetchTimer = useRef<number | null>(null);
  useEffect(() => {
    if (!candlestickEnabled) return;
    if (viewportSpanDays === null) return;
    const lastPage = pages.length > 0 ? pages[pages.length - 1] : null;
    if (!lastPage) return;
    if (!lastPage.hasMore || !lastPage.endCursor) return;
    const loadedSpan = merged.rightmostX;
    if (viewportSpanDays <= loadedSpan) return;
    fetchTimer.current = window.setTimeout(() => {
      fetchTimer.current = null;
      if (fetchInFlight.current) return;
      fetchInFlight.current = true;
      apolloClient
        .query({
          query: PortfolioCandlestickPageDocument,
          variables: {
            filterAssetIdIn: filterAssetIds.length > 0 ? filterAssetIds : null,
            candleUnit,
            candleLength,
            before: lastPage.endCursor,
          },
          // `no-cache`, not `network-only`: Apollo's normalised cache
          // would otherwise merge this response into the same
          // `Portfolio.candlestick` field that the parent suspense
          // query owns, replacing the initial page's data with the
          // older page's. The parent fragment read would then flip
          // `initialPage` (which feeds `baselineKey` via its
          // `initialDate`), the reset effect fires, and the user's
          // pinch-zoom snaps back to "fully zoomed in" mid-gesture.
          // The hook keeps its own `pages` array — no need to round-
          // trip through Apollo cache.
          fetchPolicy: "no-cache",
        })
        .then(({ data }) => {
          const next = data?.portfolio?.candlestick;
          if (next) {
            setPages((cur) => [
              ...cur,
              {
                initialDate: next.initialDate,
                endCursor: (next.endCursor as string | null) ?? null,
                hasMore: next.hasMore as boolean,
                points: next.points.map((p) => ({
                  x0: p.x0,
                  x1: p.x1,
                  from: p.from,
                  to: p.to,
                  lo: p.lo,
                  hi: p.hi,
                })),
              },
            ]);
          }
        })
        .finally(() => {
          fetchInFlight.current = false;
        });
    }, BACKFILL_DEBOUNCE_MS);
    return () => {
      // The effect re-runs on every viewport / pages change; cancel
      // the pending fetch so the 1-s clock resets each time the user
      // keeps zooming.
      if (fetchTimer.current !== null) {
        clearTimeout(fetchTimer.current);
        fetchTimer.current = null;
      }
    };
  }, [
    apolloClient,
    candleLength,
    candleUnit,
    candlestickEnabled,
    filterAssetIds,
    merged.rightmostX,
    pages,
    viewportSpanDays,
  ]);

  // Apply each wheel event directly to `viewportSpanDays` via the
  // functional setter — that gives the chart the new viewport on the
  // next render, which feels immediate (~60 Hz) without a per-frame
  // batch in the way. `setViewportSpanDays((cur) => …)` reads the most
  // recent state, so rapid consecutive wheel events compose naturally
  // (each multiplies the previous span by `exp(delta × ZOOM_RATE)`).
  //
  // The callback is wrapped in a stable `onZoom` (via a ref) so the
  // wheel listener `useEffect` in `PortfolioChart` doesn't detach /
  // re-attach on every render — a hot detach during a wheel burst
  // would drop events mid-pinch.
  const initialSpanRef = useRef(initialSpan);
  initialSpanRef.current = initialSpan;
  const onZoom = useCallback((deltaY: number) => {
    setViewportSpanDays((cur) => {
      const initial = initialSpanRef.current;
      const baseline = cur ?? initial;
      const next = baseline * Math.exp(deltaY * ZOOM_RATE);
      if (next <= initial + 1) return null;
      return Math.round(next);
    });
  }, []);

  if (!candlestickEnabled || pages.length === 0) {
    return {
      candles: null,
      candleInitialDate: null,
      viewport: undefined,
      onZoom,
    };
  }

  // Compute the viewport bounds in `merged.points`'s coordinate space.
  // `xMax` is always the rightmost loaded bucket end (the chart's right
  // edge stays pinned to "now"); `xMin = xMax − span` where `span` is
  // either the user's zoomed value or — when they've zoomed back in
  // past the initial-page span — the initial page's natural span.
  //
  // Always pinning the viewport here, even when `viewportSpanDays` is
  // null, is what keeps the chart from popping to "show every page
  // ever loaded" once the user zooms back to the initial view: after
  // a pinch-out has loaded older pages, the merged data range is
  // wider than the initial page, but the user expects "fully zoomed
  // in" to mean "today's window again", not "every loaded page".
  // `xMin` is allowed to fall below 0 (negative) when the user
  // pinches out past loaded data — that's how the chart visibly
  // stretches with empty space at the left while the 1-second
  // backfill timer is running.
  const span = viewportSpanDays ?? initialSpan;
  const viewport: { xMin: number; xMax: number } | undefined =
    initialSpan > 0
      ? {
          xMin: merged.rightmostX - span,
          xMax: merged.rightmostX,
        }
      : undefined;

  return {
    candles: { points: merged.points },
    candleInitialDate: merged.oldestInitialDate,
    viewport,
    onZoom,
  };
}

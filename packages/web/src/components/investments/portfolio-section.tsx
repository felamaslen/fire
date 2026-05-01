import {
  useApolloClient,
  useQuery,
  useSuspenseQuery,
} from "@apollo/client/react";
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
      startCursor
      endCursor
      points {
        id
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

/** Standalone fetch for an extended candlestick range. The initial page comes through the parent suspense query; on pinch-zoom-out the loader fires this query with `after` = the new (earlier) date the chart should extend back to, and replaces the active candle data with the response. Apollo normalises by `PortfolioCandlestickPoint.id` so overlapping buckets between the old and new query share cache. */
const PortfolioCandlestickRangeDocument = graphql(`
  query PortfolioCandlestickRange(
    $filterAssetIdIn: [ID!]
    $candleUnit: PortfolioCandleUnit!
    $candleLength: Int!
    $after: Date
    $before: Date
  ) {
    portfolio(filterAssetIdIn: $filterAssetIdIn) {
      id
      candlestick(
        unit: $candleUnit
        length: $candleLength
        after: $after
        before: $before
      ) {
        initialDate
        startCursor
        endCursor
        points {
          id
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

  // Candlestick state machine: the parent suspense query loads the
  // initial window (most recent N candles ending today). On pinch-zoom-
  // out the hook fires `PortfolioCandlestickRangeDocument` with a wider
  // `after` and replaces the active range with the response. Apollo
  // normalises by `PortfolioCandlestickPoint.id` so overlapping buckets
  // between queries share cache.
  const initialCandleData: CandleData | null = portfolio?.candlestick
    ? {
        initialDate: portfolio.candlestick.initialDate,
        startCursor: portfolio.candlestick.startCursor,
        endCursor: portfolio.candlestick.endCursor,
        points: portfolio.candlestick.points.map((p) => ({
          id: p.id,
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
    onPan,
  } = useCandlestickPagination({
    initialData: initialCandleData,
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
        onPan={deferredCandlestick ? onPan : undefined}
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
  id: string;
  x0: number;
  x1: number;
  from: number;
  to: number;
  lo: number;
  hi: number;
};
type CandleData = {
  initialDate: string;
  startCursor: string;
  endCursor: string;
  points: CandlePoint[];
};

const ONE_DAY_MS = 86400 * 1000;
/** Scaling factor turning a wheel-event `deltaY` into a zoom-span multiplier via `exp(deltaY × ZOOM_RATE)`. Calibrated by feel: a single notch of a discrete mouse wheel (`deltaY ≈ 100`) zooms by ~1.6×; a trackpad pinch fires many small `deltaY ≈ 1–4` events per second, so the per-frame integration ends up smooth rather than blowing past several years on a single gesture. */
const ZOOM_RATE = 0.005;
/** Wait 1 s after the user stops zooming before firing the wider-range fetch. Every zoom event resets this timer, so a long continuous pinch only triggers a single network call once the user settles. */
const BACKFILL_DEBOUNCE_MS = 1000;

/** Per-`(unit, length)` cap on the chart's visible range, in days. The server enforces a similar limit + small allowance; the client mirrors it so the zoom UX clamps cleanly instead of letting the user pinch into a server-rejected request. */
const ZOOM_LIMIT_DAYS: Record<string, number> = {
  "DAY|3": 365 * 2,
  "WEEK|1": 365 * 5,
  "WEEK|2": 365 * 10,
  "MONTH|1": 365 * 20,
  "MONTH|3": 365 * 60,
};
function zoomLimitDays(unit: "DAY" | "WEEK" | "MONTH", length: number): number {
  return ZOOM_LIMIT_DAYS[`${unit}|${length}`] ?? 365 * 60;
}

/**
 * Owns the candlestick pinch-zoom + range-extension state.
 *
 * The active candle range starts as whatever the parent suspense query
 * loaded (the initial "today's window"). On pinch-zoom-out the visible
 * span grows beyond the initial range; the hook waits
 * `BACKFILL_DEBOUNCE_MS` after the last zoom event, then fires a
 * `Portfolio.candlestick(after: …)` query whose response replaces the
 * active range with a wider one. Apollo normalises by
 * `PortfolioCandlestickPoint.id`, so buckets that overlap the previous
 * range share cache entries (no duplicate work for the rendered UI,
 * and toggling zoom in/out doesn't re-fetch the same data).
 *
 * The chart's `viewport` clips the visible portion of the active
 * range. When the user pinches back in past the initial span, the
 * viewport snaps to that span — *not* to the full zoomed-out range —
 * so "fully zoomed in" always means "today's window".
 */
function daysBetween(a: string, b: string): number {
  return Math.round(
    (new Date(`${b}T00:00:00Z`).getTime() -
      new Date(`${a}T00:00:00Z`).getTime()) /
      ONE_DAY_MS,
  );
}

function addDays(date: string, days: number): string {
  const ms =
    new Date(`${date}T00:00:00Z`).getTime() + Math.round(days) * ONE_DAY_MS;
  return new Date(ms).toISOString().slice(0, 10);
}

function useCandlestickPagination({
  initialData,
  candlestickEnabled,
  filterAssetIds,
  candleUnit,
  candleLength,
}: {
  initialData: CandleData | null;
  candlestickEnabled: boolean;
  filterAssetIds: string[];
  candleUnit: "DAY" | "WEEK" | "MONTH";
  candleLength: number;
}): {
  candles: { points: CandlePoint[] } | null;
  candleInitialDate: string | null;
  viewport: { xMin: number; xMax: number } | undefined;
  onZoom: (deltaY: number) => void;
  onPan: (deltaDays: number) => void;
} {
  // `active` holds whichever range is currently rendered: the initial
  // page (default) or the latest extended range fetched via the zoom-
  // out / pan query. Replaced wholesale on a successful fetch.
  const [active, setActive] = useState<CandleData | null>(null);
  // `null` = "use the natural initial-data window pinned to the right
  // edge"; non-null = an explicit date window driven by pinch-zoom or
  // drag-to-pan. Date strings (`YYYY-MM-DD`), so the viewport stays
  // anchored across active swaps that change the coord-space origin
  // (`active.initialDate` shifts when a wider range arrives).
  const [viewport, setViewport] = useState<{
    startDate: string;
    endDate: string;
  } | null>(null);
  const fetchInFlight = useRef(false);
  const apolloClient = useApolloClient();

  // Reset state on scope changes (filter, unit, length, candlestick
  // toggle). Keep `initialData` out of the deps — it's reconstructed
  // each parent render, so depending on it would re-run the effect on
  // every render. We resolve it via a ref at the moment we actually
  // reset.
  const filterKey = filterAssetIds.join(",");
  const baselineKey = `${candleUnit}|${candleLength}|${filterKey}|${candlestickEnabled ? "1" : "0"}`;
  const initialDataRef = useRef<CandleData | null>(initialData);
  initialDataRef.current = initialData;
  const lastBaselineRef = useRef<string | null>(null);
  useEffect(() => {
    if (lastBaselineRef.current === baselineKey) return;
    lastBaselineRef.current = baselineKey;
    setActive(initialDataRef.current);
    setViewport(null);
    fetchInFlight.current = false;
  }, [baselineKey]);

  // Seed `active` with the parent's initial data on first mount, and
  // forward subsequent boundary updates (e.g. midnight ticked over).
  // `initialData` is rebuilt every parent render, so we compare by
  // cursor strings rather than by reference.
  useEffect(() => {
    if (!initialData) return;
    setActive((cur) => {
      if (!cur) return initialData;
      // If the active range was loaded via a zoom-out fetch, its
      // `startCursor` is earlier than the parent's narrow window —
      // leave it alone. Otherwise (matching `startCursor`), refresh
      // when the right edge has advanced (midnight tick, polled
      // refetch, etc.); skip a no-op replace when both ends match.
      if (cur.startCursor !== initialData.startCursor) return cur;
      if (cur.endCursor === initialData.endCursor) return cur;
      return initialData;
    });
  }, [initialData]);

  // Default viewport (when `viewport` state is null) = the natural
  // span of the parent's initial data, pinned to its right edge.
  // Recomputed when `initialData` changes so e.g. midnight ticking
  // over slides the default forward.
  const defaultViewport = useMemo<{
    startDate: string;
    endDate: string;
  } | null>(() => {
    if (!initialData || initialData.points.length === 0) return null;
    return {
      startDate: initialData.startCursor,
      endDate: initialData.endCursor,
    };
  }, [initialData]);

  // Hard cap on how far the user can zoom out for this candle size —
  // matches the server's per-(unit, length) cap so a runaway pinch
  // doesn't get truncated by a 4xx mid-gesture.
  const maxZoomDays = zoomLimitDays(candleUnit, candleLength);

  // The "live right edge" — the latest date the user is allowed to
  // pan towards. Pulled from the parent's initial data (the suspense
  // query selects today by default), so panning right always returns
  // to today.
  const liveRightDate = initialData?.endCursor ?? null;

  // Backfill: when the viewport extends beyond the loaded `active`
  // range on either side, we need a wider query covering the new
  // viewport. Two paths run in parallel:
  //   1. A cache-only `useQuery` keyed by the same variables we'd
  //      fetch — instant hit when the user pans into a region we've
  //      already loaded this session, no debounce.
  //   2. A debounced `apolloClient.query` (cache-first) that fires
  //      1 s after the user settles, fills the cache on miss. The
  //      cache-only subscription then picks up the new data and
  //      swaps `active` — both paths funnel through one `setActive`
  //      site (the `cachedRange` effect below).
  const effectiveViewport = viewport ?? defaultViewport;
  const fetchVars = useMemo(() => {
    if (!candlestickEnabled) return null;
    if (!active || active.points.length === 0) return null;
    if (!effectiveViewport) return null;
    const needsLeft = effectiveViewport.startDate < active.initialDate;
    const needsRight = effectiveViewport.endDate > active.endCursor;
    if (!needsLeft && !needsRight) return null;
    const requestedSpan = daysBetween(
      effectiveViewport.startDate,
      effectiveViewport.endDate,
    );
    const cappedSpan = Math.min(requestedSpan, maxZoomDays);
    const after = addDays(effectiveViewport.endDate, -cappedSpan);
    const before =
      liveRightDate && effectiveViewport.endDate < liveRightDate
        ? effectiveViewport.endDate
        : null;
    return {
      filterAssetIdIn: filterAssetIds.length > 0 ? filterAssetIds : null,
      candleUnit,
      candleLength,
      after,
      before,
    };
  }, [
    active,
    candleLength,
    candleUnit,
    candlestickEnabled,
    effectiveViewport,
    filterAssetIds,
    liveRightDate,
    maxZoomDays,
  ]);

  const { data: cachedRangeData } = useQuery(
    PortfolioCandlestickRangeDocument,
    {
      variables: fetchVars ?? {
        filterAssetIdIn: null,
        candleUnit: "DAY",
        candleLength: 1,
        after: null,
        before: null,
      },
      skip: fetchVars === null,
      fetchPolicy: "cache-only",
    },
  );

  // Single `setActive` site for any cache hit (whether the data was
  // already there when the user panned, or the debounced network
  // fetch just filled it).
  useEffect(() => {
    const c = cachedRangeData?.portfolio?.candlestick;
    if (!c) return;
    setActive({
      initialDate: c.initialDate,
      startCursor: c.startCursor,
      endCursor: c.endCursor,
      points: c.points.map((p) => ({
        id: p.id,
        x0: p.x0,
        x1: p.x1,
        from: p.from,
        to: p.to,
        lo: p.lo,
        hi: p.hi,
      })),
    });
  }, [cachedRangeData]);

  const fetchTimer = useRef<number | null>(null);
  useEffect(() => {
    if (!fetchVars) return;
    // Cache hit already populated `active` via the effect above —
    // no network fetch needed.
    if (cachedRangeData?.portfolio?.candlestick) return;
    fetchTimer.current = window.setTimeout(() => {
      fetchTimer.current = null;
      if (fetchInFlight.current) return;
      fetchInFlight.current = true;
      apolloClient
        .query({
          query: PortfolioCandlestickRangeDocument,
          variables: fetchVars,
          fetchPolicy: "cache-first",
        })
        .finally(() => {
          fetchInFlight.current = false;
        });
    }, BACKFILL_DEBOUNCE_MS);
    return () => {
      if (fetchTimer.current !== null) {
        clearTimeout(fetchTimer.current);
        fetchTimer.current = null;
      }
    };
  }, [apolloClient, cachedRangeData, fetchVars]);

  // Stable wheel/pan callbacks via refs so the chart's listeners
  // don't churn every render.
  const defaultViewportRef = useRef(defaultViewport);
  defaultViewportRef.current = defaultViewport;
  const maxZoomRef = useRef(maxZoomDays);
  maxZoomRef.current = maxZoomDays;
  const liveRightRef = useRef(liveRightDate);
  liveRightRef.current = liveRightDate;
  const initialSpanDays = defaultViewport
    ? daysBetween(defaultViewport.startDate, defaultViewport.endDate)
    : 0;
  const initialSpanRef = useRef(initialSpanDays);
  initialSpanRef.current = initialSpanDays;

  const onZoom = useCallback((deltaY: number) => {
    setViewport((cur) => {
      const def = defaultViewportRef.current;
      if (!def) return cur;
      const base = cur ?? def;
      const span = daysBetween(base.startDate, base.endDate);
      const initial = initialSpanRef.current;
      const max = maxZoomRef.current;
      const factor = Math.exp(deltaY * ZOOM_RATE);
      const newSpan = Math.min(max, Math.max(1, Math.round(span * factor)));
      // Once the user zooms back in to (or beyond) the initial span and
      // the right edge is at "today", snap back to default — keeps
      // "fully zoomed in" pinned to today's window without leaving a
      // stale viewport state hanging around.
      if (newSpan <= initial + 1 && base.endDate === def.endDate) return null;
      return {
        startDate: addDays(base.endDate, -newSpan),
        endDate: base.endDate,
      };
    });
  }, []);

  const onPan = useCallback((deltaDays: number) => {
    setViewport((cur) => {
      const def = defaultViewportRef.current;
      if (!def) return cur;
      const base = cur ?? def;
      const span = daysBetween(base.startDate, base.endDate);
      // Drag-right (positive deltaDays) = the user is pulling earlier
      // dates onto the chart from the left = visible window shifts
      // BACKWARD in time = subtract from end date.
      const liveRight = liveRightRef.current;
      let newEnd = addDays(base.endDate, -deltaDays);
      if (liveRight && newEnd > liveRight) newEnd = liveRight;
      const newStart = addDays(newEnd, -span);
      if (newEnd === def.endDate && newStart === def.startDate) return null;
      return { startDate: newStart, endDate: newEnd };
    });
  }, []);

  if (!candlestickEnabled || !active || active.points.length === 0) {
    return {
      candles: null,
      candleInitialDate: null,
      viewport: undefined,
      onZoom,
      onPan,
    };
  }

  // Translate the date-keyed viewport into the chart's coord space
  // (days since `active.initialDate`). The chart's clip-path takes
  // care of any out-of-range buckets while a backfill is in flight.
  const chartViewport: { xMin: number; xMax: number } | undefined =
    effectiveViewport
      ? {
          xMin: daysBetween(active.initialDate, effectiveViewport.startDate),
          xMax: daysBetween(active.initialDate, effectiveViewport.endDate),
        }
      : undefined;

  return {
    candles: { points: active.points },
    candleInitialDate: active.initialDate,
    viewport: chartViewport,
    onZoom,
    onPan,
  };
}

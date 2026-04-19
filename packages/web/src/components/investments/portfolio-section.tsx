import { useQuery } from "@apollo/client/react";
import { useRef } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

import { graphql, readFragment } from "../../graphql";
import {
  type CandleSeries,
  type LineSeries,
  PortfolioChart,
  PortfolioChartLegend,
} from "./portfolio-chart";

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
    candlestick(period: $period, length: $length) @include(if: $candlestick) {
      currency
      initialDate
      points {
        x
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
      $candlestick: Boolean!
    ) {
      portfolio {
        ...PortfolioChartPortfolio
      }
      portfolios @skip(if: $candlestick) {
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

const STACK_COLORS = [
  "#6366f1",
  "#ef4444",
  "#10b981",
  "#f59e0b",
  "#ec4899",
  "#0ea5e9",
  "#a855f7",
  "#14b8a6",
  "#f97316",
  "#84cc16",
  "#06b6d4",
  "#d946ef",
  "#eab308",
  "#22c55e",
  "#3b82f6",
  "#f43f5e",
  "#8b5cf6",
  "#14532d",
  "#78350f",
  "#be185d",
];

export type PortfolioChartSettings = {
  periodIdx: number;
  mode: "line" | "candlestick";
  stack: boolean;
};

export function PortfolioSection({
  settings,
  onChange,
}: {
  settings: PortfolioChartSettings;
  onChange: (next: PortfolioChartSettings) => void;
}) {
  const { periodIdx, mode, stack } = settings;
  const update = (patch: Partial<PortfolioChartSettings>) =>
    onChange({ ...settings, ...patch });

  const p = PORTFOLIO_PERIODS[periodIdx];

  return (
    <section className="space-y-3 rounded-lg border p-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Portfolio</h2>
        <div className="flex flex-wrap gap-1 text-xs">
          {PORTFOLIO_PERIODS.map((per, i) => (
            <Button
              key={per.label}
              size="sm"
              variant={i === periodIdx ? "default" : "outline"}
              onClick={() => update({ periodIdx: i })}
            >
              {per.label}
            </Button>
          ))}
          <span className="mx-2" />
          <Button
            size="sm"
            variant={mode === "line" ? "default" : "outline"}
            onClick={() => update({ mode: "line" })}
          >
            Line
          </Button>
          <Button
            size="sm"
            variant={mode === "candlestick" ? "default" : "outline"}
            onClick={() => update({ mode: "candlestick" })}
          >
            Candle
          </Button>
          <Button
            size="sm"
            variant={stack ? "default" : "outline"}
            disabled={mode === "candlestick"}
            onClick={() => update({ stack: !stack })}
          >
            Stacked
          </Button>
        </div>
      </header>
      <PortfolioChartLoader
        period={p.period}
        length={"length" in p ? p.length : null}
        candlestick={mode === "candlestick"}
        stack={stack}
      />
    </section>
  );
}

function PortfolioChartLoader({
  period,
  length,
  candlestick,
  stack,
}: {
  period: "YEAR" | "MONTH" | "YTD" | "ALL";
  length: number | null;
  candlestick: boolean;
  stack: boolean;
}) {
  const { data, loading } = useQuery(PortfolioChartDocument, {
    variables: { period, length, candlestick },
    notifyOnNetworkStatusChange: true,
  });

  const rawPortfolio = data?.portfolio;
  const portfolio = rawPortfolio
    ? readFragment(PortfolioChartPortfolioFragment, rawPortfolio)
    : null;

  const perInvestmentSeries = (data?.portfolios?.edges ?? []).flatMap(
    (edge, i) => {
      const ts = edge.node.timeseries;
      if (!ts) return [];
      return [
        {
          label: edge.node.investment?.name ?? "?",
          color: STACK_COLORS[i % STACK_COLORS.length],
          points: ts.points,
          initialDate: ts.initialDate,
        },
      ];
    },
  );

  const { lines, stackInitialDate } = stack
    ? stackLines(perInvestmentSeries)
    : {
        lines: portfolio?.timeseries
          ? [
              {
                label: "Portfolio",
                color: "#6366f1",
                points: portfolio.timeseries.points,
              },
            ]
          : [],
        stackInitialDate: portfolio?.timeseries?.initialDate ?? null,
      };

  const candles = portfolio?.candlestick
    ? { points: portfolio.candlestick.points }
    : null;

  const initialDateStr =
    stackInitialDate ??
    portfolio?.timeseries?.initialDate ??
    portfolio?.candlestick?.initialDate ??
    null;

  // Build the current render; if it has no content (initial load before
  // cache, or the current mode hasn't fetched yet), fall back to whatever
  // we last successfully rendered — dimmed. This removes the empty-state
  // flash when flipping line↔candle or arriving on the page.
  const hasContent = candlestick
    ? (candles?.points.length ?? 0) > 0
    : lines.length > 0;
  type ChartRender = {
    lines?: LineSeries[];
    candles?: CandleSeries | null;
    currency: string;
    initialDate: Date | undefined;
    stacked: boolean;
    showLegend: boolean;
  };
  const lastRef = useRef<ChartRender | null>(null);
  const current: ChartRender | null = hasContent
    ? {
        lines: candlestick ? undefined : lines,
        candles: candlestick ? candles : null,
        currency: portfolio?.currency ?? "GBP",
        initialDate:
          typeof initialDateStr === "string"
            ? new Date(`${initialDateStr}T00:00:00Z`)
            : undefined,
        stacked: !candlestick && stack,
        showLegend: !candlestick && stack && lines.length > 1,
      }
    : null;
  if (current) lastRef.current = current;
  const render = current ?? lastRef.current;
  if (!render) return null;

  return (
    <div
      className={cn(
        "space-y-2 transition-opacity",
        loading && "pointer-events-none opacity-50",
      )}
    >
      <PortfolioChart
        lines={render.lines}
        candles={render.candles}
        currency={render.currency}
        initialDate={render.initialDate}
        stacked={render.stacked}
        className="w-full"
      />
      {render.showLegend && render.lines && (
        <PortfolioChartLegend lines={render.lines} />
      )}
    </div>
  );
}

type SeriesIn = {
  label: string;
  color: string;
  points: { x: number; y: number }[];
  initialDate: string;
};

type SeriesOut = {
  label: string;
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
    return { label: s.label, color: s.color, points };
  });

  return { lines, stackInitialDate };
}

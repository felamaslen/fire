import { useSuspenseQuery } from "@apollo/client/react";
import { Suspense, useEffect, useState } from "react";

import { Spinner } from "@/components/spinner";
import { Button } from "@/components/ui/button";

import { graphql, type ResultOf } from "../../graphql";

import { PortfolioChart } from "./portfolio-chart";

const PortfolioChartDocument = graphql(`
  query PortfolioChart(
    $period: PortfolioTimePeriod!
    $length: Int
    $candlestick: Boolean!
  ) {
    portfolio {
      id
      currency
      totalValue { amount currency }
      totalGain { amount currency }
      percentGain
      timeseries(period: $period, length: $length) @skip(if: $candlestick) {
        currency
        initialDate
        points { x y }
      }
      candlestick(period: $period, length: $length) @include(if: $candlestick) {
        currency
        initialDate
        points { x from to lo hi }
      }
    }
    portfolios @skip(if: $candlestick) {
      edges {
        node {
          id
          investment { id name }
          timeseries(period: $period, length: $length) {
            initialDate
            points { x y }
          }
        }
      }
    }
  }
`);

type Period =
  | { period: "YEAR"; length: number; label: string }
  | { period: "MONTH"; length: number; label: string }
  | { period: "YTD"; length: 0; label: string };

const PERIODS: Period[] = [
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
];

type PortfolioChartSettings = {
  periodIdx: number;
  mode: "line" | "candlestick";
  stack: boolean;
};

const STORAGE_KEY = "fire.investments.portfolioChart";

function loadSettings(): PortfolioChartSettings {
  if (typeof window === "undefined") {
    return { periodIdx: 0, mode: "line", stack: false };
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { periodIdx: 0, mode: "line", stack: false };
    const parsed = JSON.parse(raw) as Partial<PortfolioChartSettings>;
    return {
      periodIdx:
        typeof parsed.periodIdx === "number" &&
        parsed.periodIdx >= 0 &&
        parsed.periodIdx < PERIODS.length
          ? parsed.periodIdx
          : 0,
      mode: parsed.mode === "candlestick" ? "candlestick" : "line",
      stack: parsed.stack === true,
    };
  } catch {
    return { periodIdx: 0, mode: "line", stack: false };
  }
}

export function PortfolioSection() {
  const [settings, setSettings] = useState<PortfolioChartSettings>(loadSettings);
  const { periodIdx, mode, stack } = settings;
  const update = (patch: Partial<PortfolioChartSettings>) =>
    setSettings((prev) => ({ ...prev, ...patch }));

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }, [settings]);

  const p = PERIODS[periodIdx];

  return (
    <section className="space-y-3 rounded-lg border p-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Portfolio</h2>
        <div className="flex flex-wrap gap-1 text-xs">
          {PERIODS.map((per, i) => (
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
      <Suspense fallback={<Spinner />}>
        <PortfolioChartLoader
          period={p.period}
          length={"length" in p ? p.length : null}
          candlestick={mode === "candlestick"}
          stack={stack}
        />
      </Suspense>
    </section>
  );
}

function PortfolioChartLoader({
  period,
  length,
  candlestick,
  stack,
}: {
  period: "YEAR" | "MONTH" | "YTD";
  length: number | null;
  candlestick: boolean;
  stack: boolean;
}) {
  const { data } = useSuspenseQuery(PortfolioChartDocument, {
    variables: { period, length, candlestick },
  });

  const portfolio = data.portfolio;
  if (!portfolio) return null;

  const lines = stack
    ? (data.portfolios?.edges ?? []).flatMap((edge, i) => {
        const ts = edge.node.timeseries;
        if (!ts) return [];
        return [
          {
            label: edge.node.investment?.name ?? "?",
            color: STACK_COLORS[i % STACK_COLORS.length],
            points: ts.points,
          },
        ];
      })
    : portfolio.timeseries
      ? [
          {
            label: "Portfolio",
            color: "#6366f1",
            points: portfolio.timeseries.points,
          },
        ]
      : [];

  const candles = portfolio.candlestick
    ? { points: portfolio.candlestick.points }
    : null;

  return (
    <div className="space-y-2">
      <PortfolioChart
        lines={candlestick ? undefined : lines}
        candles={candlestick ? candles : null}
        className="w-full"
      />
    </div>
  );
}

export type PortfolioSummary = ResultOf<typeof PortfolioChartDocument>;

import { useSuspenseQuery } from "@apollo/client/react";
import { Suspense, useState } from "react";

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

export function PortfolioSection() {
  const [periodIdx, setPeriodIdx] = useState(0);
  const [mode, setMode] = useState<"line" | "candlestick">("line");
  const [stack, setStack] = useState(false);
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
              onClick={() => setPeriodIdx(i)}
            >
              {per.label}
            </Button>
          ))}
          <span className="mx-2" />
          <Button
            size="sm"
            variant={mode === "line" ? "default" : "outline"}
            onClick={() => setMode("line")}
          >
            Line
          </Button>
          <Button
            size="sm"
            variant={mode === "candlestick" ? "default" : "outline"}
            onClick={() => setMode("candlestick")}
          >
            Candle
          </Button>
          <Button
            size="sm"
            variant={stack ? "default" : "outline"}
            disabled={mode === "candlestick"}
            onClick={() => setStack((s) => !s)}
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

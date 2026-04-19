import { useMemo } from "react";

import { cn } from "@/lib/cn";

export type LineSeries = {
  label: string;
  color: string;
  points: { x: number; y: number }[];
};

export type CandleSeries = {
  points: { x: number; from: number; to: number; lo: number; hi: number }[];
};

type Props = {
  lines?: LineSeries[];
  candles?: CandleSeries | null;
  width?: number;
  height?: number;
  className?: string;
  /** ISO-4217 code for the Y-axis value label. */
  currency?: string;
  /** Start date of the X axis (`x === 0`); each subsequent x is days after this. */
  initialDate?: Date;
};

const AXIS_PAD_LEFT = 64;
const AXIS_PAD_RIGHT = 16;
const AXIS_PAD_TOP = 12;
const AXIS_PAD_BOTTOM = 28;

/** Cache one formatter per (currency, compact) pair. */
const formatterCache = new Map<string, Intl.NumberFormat>();
function money(currency: string, amount: number): string {
  const key = `${currency}|c`;
  let f = formatterCache.get(key);
  if (!f) {
    f = new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency,
      currencySign: "accounting",
      notation: "compact",
      maximumFractionDigits: 1,
    });
    formatterCache.set(key, f);
  }
  return f.format(amount).replace(/([KMBT])/g, (c) => c.toLowerCase());
}

function shortDate(d: Date): string {
  return d.toLocaleDateString("en-GB", {
    month: "short",
    year: "2-digit",
  });
}

/**
 * Minimal SVG chart that renders one or more line series or a candlestick series. X values are days since the series' initial date; Y values are in major currency units (Int).
 */
export function PortfolioChart({
  lines,
  candles,
  width = 720,
  height = 260,
  className,
  currency = "GBP",
  initialDate,
}: Props) {
  const { xScale, yScale, xMin, xMax, yMin, yMax } = useMemo(() => {
    const allXs: number[] = [];
    const allYs: number[] = [];
    for (const l of lines ?? []) {
      for (const p of l.points) {
        allXs.push(p.x);
        allYs.push(p.y);
      }
    }
    if (candles) {
      for (const p of candles.points) {
        allXs.push(p.x);
        allYs.push(p.lo, p.hi);
      }
    }
    const xMin = allXs.length ? Math.min(...allXs) : 0;
    const xMax = allXs.length ? Math.max(...allXs) : 1;
    // Float the Y axis to the data range rather than anchoring at 0, so a
    // portfolio that's always sat between £10k and £12k doesn't show up as
    // a flat line at the top of the chart.
    const yMin = allYs.length ? Math.min(...allYs) : 0;
    const yMax = allYs.length ? Math.max(...allYs) : 1;
    const xRange = xMax - xMin || 1;
    const yRange = yMax - yMin || 1;
    const plotW = width - AXIS_PAD_LEFT - AXIS_PAD_RIGHT;
    const plotH = height - AXIS_PAD_TOP - AXIS_PAD_BOTTOM;
    return {
      xMin,
      xMax,
      yMin,
      yMax,
      xScale: (x: number) => AXIS_PAD_LEFT + ((x - xMin) / xRange) * plotW,
      yScale: (y: number) =>
        AXIS_PAD_TOP + plotH - ((y - yMin) / yRange) * plotH,
    };
  }, [lines, candles, width, height]);

  if (!lines?.length && (!candles || candles.points.length === 0)) {
    return (
      <div
        className={cn(
          "flex items-center justify-center rounded border bg-muted/30 text-sm text-muted-foreground",
          className,
        )}
        style={{ width, height }}
      >
        No data yet.
      </div>
    );
  }

  const yTicks = buildYTicks(yMin, yMax, 4);
  const xTicks = buildXTicks(xMin, xMax, initialDate, 4);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className={cn("overflow-visible", className)}
    >
      {/* Grid + Y axis labels */}
      {yTicks.map((v) => (
        <g key={`y${v}`}>
          <line
            x1={AXIS_PAD_LEFT}
            x2={width - AXIS_PAD_RIGHT}
            y1={yScale(v)}
            y2={yScale(v)}
            stroke="currentColor"
            strokeOpacity={0.08}
          />
          <text
            x={AXIS_PAD_LEFT - 6}
            y={yScale(v) + 3}
            textAnchor="end"
            className="fill-muted-foreground text-[10px] tabular-nums"
          >
            {money(currency, v)}
          </text>
        </g>
      ))}

      {/* X axis labels */}
      {xTicks.map((t) => (
        <text
          key={`x${t.x}`}
          x={xScale(t.x)}
          y={height - 8}
          textAnchor="middle"
          className="fill-muted-foreground text-[10px]"
        >
          {t.label}
        </text>
      ))}

      {/* Axis baseline */}
      <line
        x1={AXIS_PAD_LEFT}
        x2={width - AXIS_PAD_RIGHT}
        y1={yScale(yMin)}
        y2={yScale(yMin)}
        stroke="currentColor"
        strokeOpacity={0.25}
      />
      <line
        x1={AXIS_PAD_LEFT}
        x2={AXIS_PAD_LEFT}
        y1={AXIS_PAD_TOP}
        y2={height - AXIS_PAD_BOTTOM}
        stroke="currentColor"
        strokeOpacity={0.25}
      />

      {candles?.points.map((p, i) => {
        const x = xScale(p.x);
        const bodyY = yScale(Math.max(p.from, p.to));
        const bodyHeight = Math.abs(yScale(p.from) - yScale(p.to)) || 1;
        const isUp = p.to >= p.from;
        const bucketWidth = Math.max(
          2,
          (width - AXIS_PAD_LEFT - AXIS_PAD_RIGHT) /
            Math.max(candles.points.length, 1) -
            2,
        );
        const capWidth = Math.max(3, bucketWidth * 0.45);
        return (
          <g key={i}>
            {/* wick */}
            <g className="text-foreground">
              <line
                x1={x}
                x2={x}
                y1={yScale(p.hi)}
                y2={yScale(p.lo)}
                stroke="currentColor"
                strokeWidth={1}
              />
              <line
                x1={x - capWidth / 2}
                x2={x + capWidth / 2}
                y1={yScale(p.hi)}
                y2={yScale(p.hi)}
                stroke="currentColor"
                strokeWidth={1}
              />
              <line
                x1={x - capWidth / 2}
                x2={x + capWidth / 2}
                y1={yScale(p.lo)}
                y2={yScale(p.lo)}
                stroke="currentColor"
                strokeWidth={1}
              />
            </g>
            {/* body */}
            <rect
              x={x - bucketWidth / 2}
              y={bodyY}
              width={bucketWidth}
              height={bodyHeight}
              className={isUp ? "fill-emerald-500" : "fill-red-500"}
            />
          </g>
        );
      })}

      {lines?.map((line) => {
        const d = line.points
          .map(
            (p, i) =>
              `${i === 0 ? "M" : "L"} ${xScale(p.x)} ${yScale(p.y)}`,
          )
          .join(" ");
        return (
          <path
            key={line.label}
            d={d}
            fill="none"
            stroke={line.color}
            strokeWidth={1.5}
          />
        );
      })}

      {/* Legend for stacked line charts */}
      {lines && lines.length > 1 && (
        <g transform={`translate(${AXIS_PAD_LEFT + 4} ${AXIS_PAD_TOP + 4})`}>
          {lines.map((l, i) => (
            <g key={l.label} transform={`translate(0 ${i * 14})`}>
              <rect width="10" height="10" fill={l.color} rx="2" />
              <text
                x={14}
                y={9}
                className="fill-muted-foreground text-[10px]"
              >
                {l.label}
              </text>
            </g>
          ))}
        </g>
      )}
    </svg>
  );
}

function buildYTicks(min: number, max: number, count: number): number[] {
  if (max === min) return [min];
  const step = (max - min) / count;
  const ticks: number[] = [];
  for (let i = 0; i <= count; i++) ticks.push(min + step * i);
  return ticks;
}

function buildXTicks(
  min: number,
  max: number,
  initialDate: Date | undefined,
  count: number,
): { x: number; label: string }[] {
  if (!initialDate || max === min) return [];
  const ticks: { x: number; label: string }[] = [];
  const range = max - min;
  for (let i = 0; i <= count; i++) {
    const x = min + (range * i) / count;
    const d = new Date(initialDate);
    d.setDate(d.getDate() + Math.round(x));
    ticks.push({ x, label: shortDate(d) });
  }
  return ticks;
}

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
};

/**
 * Minimal SVG chart that renders one or more line series or a candlestick series. X values are days since the series' initial date; Y values are in major currency units (Int).
 */
export function PortfolioChart({
  lines,
  candles,
  width = 640,
  height = 220,
  className,
}: Props) {
  const { padding, xScale, yScale, xMax, yMin, yMax } = useMemo(() => {
    const padding = 24;
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
    const yMin = allYs.length ? Math.min(...allYs) : 0;
    const yMax = allYs.length ? Math.max(...allYs) : 1;
    const xRange = xMax - xMin || 1;
    const yRange = yMax - yMin || 1;
    return {
      padding,
      xMax,
      yMin,
      yMax,
      xScale: (x: number) =>
        padding + ((x - xMin) / xRange) * (width - 2 * padding),
      yScale: (y: number) =>
        height - padding - ((y - yMin) / yRange) * (height - 2 * padding),
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

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className={cn("overflow-visible", className)}
    >
      {/* baseline */}
      <line
        x1={padding}
        x2={width - padding}
        y1={yScale(yMin)}
        y2={yScale(yMin)}
        stroke="currentColor"
        strokeOpacity={0.1}
      />
      <text
        x={padding}
        y={padding / 2 + 2}
        className="fill-muted-foreground text-[10px]"
      >
        {Math.round(yMax).toLocaleString()}
      </text>
      <text
        x={padding}
        y={height - 4}
        className="fill-muted-foreground text-[10px]"
      >
        {Math.round(yMin).toLocaleString()}
      </text>

      {candles?.points.map((p) => {
        const x = xScale(p.x);
        const bodyY = yScale(Math.max(p.from, p.to));
        const bodyHeight =
          Math.abs(yScale(p.from) - yScale(p.to)) || 1;
        const isUp = p.to >= p.from;
        const bucketWidth = Math.max(
          2,
          (width - 2 * padding) / Math.max(candles.points.length, 1) - 2,
        );
        return (
          <g key={p.x} className={isUp ? "text-emerald-500" : "text-red-500"}>
            <line
              x1={x}
              x2={x}
              y1={yScale(p.hi)}
              y2={yScale(p.lo)}
              stroke="currentColor"
              strokeWidth={1}
            />
            <rect
              x={x - bucketWidth / 2}
              y={bodyY}
              width={bucketWidth}
              height={bodyHeight}
              fill="currentColor"
              opacity={0.6}
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

      <text
        x={width - padding}
        y={height - 4}
        textAnchor="end"
        className="fill-muted-foreground text-[10px]"
      >
        {xMax} days
      </text>
    </svg>
  );
}

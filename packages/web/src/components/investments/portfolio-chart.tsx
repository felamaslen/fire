import { useMemo, useState } from "react";

import { cn } from "@/lib/cn";
import {
  formatAccountingMoney,
  formatAccountingMoneyRounded,
} from "@/lib/format";

export type LineSeries = {
  label: string;
  tooltip?: string;
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
  /**
   * When `true`, render `lines` as filled stacked areas instead of overlaid
   * strokes. Assumes the caller has already made each series' `y` cumulative
   * (series[i].y = its own value + all previous series' values at the same x).
   */
  stacked?: boolean;
};

const AXIS_PAD_LEFT = 64;
const AXIS_PAD_RIGHT = 16;
const AXIS_PAD_TOP = 12;
const AXIS_PAD_BOTTOM = 28;

function shortDate(d: Date): string {
  return d.toLocaleDateString("en-GB", {
    month: "short",
    year: "2-digit",
  });
}

function fullDate(d: Date): string {
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
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
  stacked = false,
}: Props) {
  const [hoveredCandle, setHoveredCandle] = useState<number | null>(null);
  const [lineHoverX, setLineHoverX] = useState<number | null>(null);
  const { xScale, yScale, xMin, xMax, yMin, yTicks, xTicks } = useMemo(() => {
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
    // a flat line at the top of the chart. For stacked charts the whole
    // composition from 0 up is meaningful, so anchor min to 0 there.
    const rawMin = allYs.length ? Math.min(...allYs) : 0;
    const dataMin = stacked ? 0 : rawMin;
    const dataMax = allYs.length ? Math.max(...allYs) : 1;
    const {
      ticks: yTicks,
      niceMin,
      niceMax,
    } = buildYTicks(dataMin, dataMax, 4);
    const xRange = xMax - xMin || 1;
    const yRange = niceMax - niceMin || 1;
    const plotW = width - AXIS_PAD_LEFT - AXIS_PAD_RIGHT;
    const plotH = height - AXIS_PAD_TOP - AXIS_PAD_BOTTOM;
    const xTicks = buildXTicks(xMin, xMax, initialDate, 4);
    return {
      xMin,
      xMax,
      yMin: niceMin,
      yTicks,
      xTicks,
      xScale: (x: number) => AXIS_PAD_LEFT + ((x - xMin) / xRange) * plotW,
      yScale: (y: number) =>
        AXIS_PAD_TOP + plotH - ((y - niceMin) / yRange) * plotH,
    };
  }, [lines, candles, width, height, initialDate, stacked]);

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
            {formatAccountingMoney(currency, v, { compact: true })}
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
        const isHovered = hoveredCandle === i;
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
              className={
                isUp
                  ? isHovered
                    ? "fill-emerald-400"
                    : "fill-emerald-500"
                  : isHovered
                    ? "fill-red-400"
                    : "fill-red-500"
              }
            />
            {/* hover hitbox — full plot height, slightly wider than the
                body so there's no dead pixel between candles */}
            <rect
              x={x - bucketWidth / 2 - 1}
              y={AXIS_PAD_TOP}
              width={bucketWidth + 2}
              height={height - AXIS_PAD_TOP - AXIS_PAD_BOTTOM}
              fill="transparent"
              onMouseEnter={() => setHoveredCandle(i)}
              onMouseLeave={() =>
                setHoveredCandle((cur) => (cur === i ? null : cur))
              }
            />
          </g>
        );
      })}
      {candles &&
        hoveredCandle !== null &&
        candles.points[hoveredCandle] &&
        (() => {
          const p = candles.points[hoveredCandle];
          const cx = xScale(p.x);
          const plotRight = width - AXIS_PAD_RIGHT;
          const boxW = 148;
          const boxH = 82;
          const gap = 10;
          const preferRight = cx + gap + boxW <= plotRight;
          const boxX = preferRight
            ? cx + gap
            : Math.max(AXIS_PAD_LEFT, cx - gap - boxW);
          const boxY = Math.max(AXIS_PAD_TOP, yScale(p.hi) - boxH / 2);
          const d = initialDate
            ? new Date(
                initialDate.getTime() + Math.round(p.x) * 86400 * 1000,
              )
            : null;
          const isUp = p.to >= p.from;
          return (
            <g pointerEvents="none">
              <line
                x1={cx}
                x2={cx}
                y1={AXIS_PAD_TOP}
                y2={height - AXIS_PAD_BOTTOM}
                stroke="currentColor"
                strokeOpacity={0.2}
                strokeDasharray="2 2"
              />
              <rect
                x={boxX}
                y={boxY}
                width={boxW}
                height={boxH}
                rx={6}
                className="fill-popover stroke-border"
                strokeWidth={1}
              />
              <g className="fill-foreground text-[10px] tabular-nums">
                {d && (
                  <text x={boxX + 8} y={boxY + 14} className="font-medium">
                    {fullDate(d)}
                  </text>
                )}
                <text x={boxX + 8} y={boxY + 30} className="fill-muted-foreground">
                  Open
                </text>
                <text x={boxX + boxW - 8} y={boxY + 30} textAnchor="end">
                  {formatAccountingMoneyRounded(currency, p.from)}
                </text>
                <text x={boxX + 8} y={boxY + 44} className="fill-muted-foreground">
                  Close
                </text>
                <text
                  x={boxX + boxW - 8}
                  y={boxY + 44}
                  textAnchor="end"
                  className={isUp ? "fill-emerald-500" : "fill-red-500"}
                >
                  {formatAccountingMoneyRounded(currency, p.to)}
                </text>
                <text x={boxX + 8} y={boxY + 58} className="fill-muted-foreground">
                  High
                </text>
                <text x={boxX + boxW - 8} y={boxY + 58} textAnchor="end">
                  {formatAccountingMoneyRounded(currency, p.hi)}
                </text>
                <text x={boxX + 8} y={boxY + 72} className="fill-muted-foreground">
                  Low
                </text>
                <text x={boxX + boxW - 8} y={boxY + 72} textAnchor="end">
                  {formatAccountingMoneyRounded(currency, p.lo)}
                </text>
              </g>
            </g>
          );
        })()}

      {lines?.map((line, idx) => {
        if (stacked) {
          // Build the closed polygon between this line and the one below it
          // (or 0 if it's the bottom-most). Assumes lines are sorted from
          // bottom to top and each y is cumulative.
          const below = idx > 0 ? lines[idx - 1].points : null;
          const topPath = line.points
            .map((p, i) => `${i === 0 ? "M" : "L"} ${xScale(p.x)} ${yScale(p.y)}`)
            .join(" ");
          const bottomPoints = (below ?? line.points.map((p) => ({ x: p.x, y: 0 })))
            .slice()
            .reverse();
          const bottomPath = bottomPoints
            .map((p) => `L ${xScale(p.x)} ${yScale(p.y)}`)
            .join(" ");
          return (
            <path
              key={line.label}
              d={`${topPath} ${bottomPath} Z`}
              fill={line.color}
              fillOpacity={0.7}
              stroke={line.color}
              strokeWidth={0.5}
            />
          );
        }
        const d = line.points
          .map((p, i) => `${i === 0 ? "M" : "L"} ${xScale(p.x)} ${yScale(p.y)}`)
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

      {lines && lines.length > 0 && !stacked && (() => {
        const primary = lines[0].points;
        const snapped =
          lineHoverX !== null && primary.length > 0
            ? findClosestPoint(primary, lineHoverX)
            : null;
        const plotW = width - AXIS_PAD_LEFT - AXIS_PAD_RIGHT;
        return (
          <>
            {/* Full-plot pointer surface. Placed last so it sits on top of
                the line paths and catches every move. */}
            <rect
              x={AXIS_PAD_LEFT}
              y={AXIS_PAD_TOP}
              width={plotW}
              height={height - AXIS_PAD_TOP - AXIS_PAD_BOTTOM}
              fill="transparent"
              onPointerMove={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                if (rect.width === 0) return;
                const svgX =
                  ((e.clientX - rect.left) / rect.width) * width;
                const xRange = xMax - xMin || 1;
                const dataX =
                  xMin + ((svgX - AXIS_PAD_LEFT) / plotW) * xRange;
                setLineHoverX(dataX);
              }}
              onPointerLeave={() => setLineHoverX(null)}
            />
            {snapped &&
              (() => {
                const cx = xScale(snapped.x);
                const perLine = lines.map((l) => ({
                  label: l.label,
                  color: l.color,
                  point:
                    l.points.length > 0
                      ? findClosestPoint(l.points, snapped.x)
                      : null,
                }));
                const rowH = 14;
                const headerH = 18;
                const padY = 8;
                const boxW = 168;
                const boxH = headerH + perLine.length * rowH + padY;
                const gap = 10;
                const plotRight = width - AXIS_PAD_RIGHT;
                const preferRight = cx + gap + boxW <= plotRight;
                const boxX = preferRight
                  ? cx + gap
                  : Math.max(AXIS_PAD_LEFT, cx - gap - boxW);
                const topY = perLine.reduce(
                  (min, pl) =>
                    pl.point ? Math.min(min, yScale(pl.point.y)) : min,
                  Infinity,
                );
                const boxY = Math.max(
                  AXIS_PAD_TOP,
                  Math.min(
                    height - AXIS_PAD_BOTTOM - boxH,
                    (isFinite(topY) ? topY : AXIS_PAD_TOP) - boxH / 2,
                  ),
                );
                const d = initialDate
                  ? new Date(
                      initialDate.getTime() +
                        Math.round(snapped.x) * 86400 * 1000,
                    )
                  : null;
                return (
                  <g pointerEvents="none">
                    <line
                      x1={cx}
                      x2={cx}
                      y1={AXIS_PAD_TOP}
                      y2={height - AXIS_PAD_BOTTOM}
                      stroke="currentColor"
                      strokeOpacity={0.2}
                      strokeDasharray="2 2"
                    />
                    {perLine.map(
                      (pl) =>
                        pl.point && (
                          <circle
                            key={pl.label}
                            cx={cx}
                            cy={yScale(pl.point.y)}
                            r={3}
                            fill={pl.color}
                            stroke="var(--background, white)"
                            strokeWidth={1.5}
                          />
                        ),
                    )}
                    <rect
                      x={boxX}
                      y={boxY}
                      width={boxW}
                      height={boxH}
                      rx={6}
                      className="fill-popover stroke-border"
                      strokeWidth={1}
                    />
                    <g className="fill-foreground text-[10px] tabular-nums">
                      {d && (
                        <text
                          x={boxX + 8}
                          y={boxY + 14}
                          className="font-medium"
                        >
                          {fullDate(d)}
                        </text>
                      )}
                      {perLine.map((pl, i) => {
                        const y = boxY + headerH + i * rowH + 10;
                        return (
                          <g key={pl.label}>
                            <rect
                              x={boxX + 8}
                              y={y - 7}
                              width={8}
                              height={8}
                              rx={1}
                              fill={pl.color}
                            />
                            <text
                              x={boxX + 20}
                              y={y}
                              className="fill-muted-foreground"
                            >
                              {pl.label}
                            </text>
                            <text
                              x={boxX + boxW - 8}
                              y={y}
                              textAnchor="end"
                            >
                              {pl.point
                                ? formatAccountingMoneyRounded(
                                    currency,
                                    pl.point.y,
                                  )
                                : "—"}
                            </text>
                          </g>
                        );
                      })}
                    </g>
                  </g>
                );
              })()}
          </>
        );
      })()}
    </svg>
  );
}

function findClosestPoint<T extends { x: number }>(
  points: T[],
  x: number,
): T {
  let best = points[0];
  let bestDist = Math.abs(best.x - x);
  for (let i = 1; i < points.length; i++) {
    const d = Math.abs(points[i].x - x);
    if (d < bestDist) {
      best = points[i];
      bestDist = d;
    }
  }
  return best;
}

/** Small wrapping swatch list for a stacked chart. Shows up to `max` series by name; anything beyond collapses into a "+N more" pill. */
export function PortfolioChartLegend({
  lines,
  max = 12,
}: {
  lines: LineSeries[];
  max?: number;
}) {
  const visible = lines.slice(0, max);
  const overflow = Math.max(0, lines.length - visible.length);
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
      {visible.map((l) => (
        <li
          key={l.label}
          className="flex items-center gap-1.5"
          title={l.tooltip ?? l.label}
        >
          <span
            aria-hidden
            className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
            style={{ background: l.color }}
          />
          <span className="inline-block max-w-[8rem] truncate align-middle">
            {l.label}
          </span>
        </li>
      ))}
      {overflow > 0 && (
        <li className="italic">+{overflow} more</li>
      )}
    </ul>
  );
}

/**
 * Produce ~`count` ticks whose step is a "nice" round value (1/2/5 × 10ⁿ).
 * The returned tick range extends to cover `[min, max]` — the first tick is
 * the largest nice value ≤ min, the last is the smallest ≥ max — so the
 * caller should use these bounds when computing the Y scale instead of the
 * raw data extent, otherwise ticks land off-grid.
 */
function buildYTicks(
  min: number,
  max: number,
  count: number,
): { ticks: number[]; niceMin: number; niceMax: number } {
  if (max === min) return { ticks: [min], niceMin: min, niceMax: min };
  const range = max - min;
  const roughStep = range / count;
  const pow10 = Math.pow(10, Math.floor(Math.log10(roughStep)));
  const normalized = roughStep / pow10;
  const niceNormalized =
    normalized < 1.5 ? 1 : normalized < 3 ? 2 : normalized < 7 ? 5 : 10;
  const step = niceNormalized * pow10;
  const niceMin = Math.floor(min / step) * step;
  const niceMax = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = niceMin; v <= niceMax + step / 2; v += step) {
    ticks.push(Number(v.toFixed(10)));
  }
  return { ticks, niceMin, niceMax };
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

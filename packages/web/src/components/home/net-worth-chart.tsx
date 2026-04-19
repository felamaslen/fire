import { useMemo, useState } from "react";

import { cn } from "@/lib/cn";
import {
  formatAccountingMoney,
  formatAccountingMoneyRounded,
} from "@/lib/format";

export type NetWorthChartSeries = {
  /** Stable key used in tooltips and to identify the series. */
  key: string;
  /** Human-readable label shown in the tooltip. */
  label: string;
  /** Stroke colour (also the fill colour when `fill !== "none"`). */
  color: string;
  /**
   * When `fill === "zero"`, paint colour used for the portion of the fill
   * that is below the zero line (negative values). Ignored otherwise.
   */
  negativeColor?: string;
  /**
   * `"zero"` — fill between the line and the zero baseline; `negativeColor`
   * tints any section that dips below zero.
   * `"baseline"` — fill between this series' line and `baseline`'s line at
   * the same x. Useful for stacking (e.g. a debt band painted between
   * `net` and `assets`, so the coloured region reads as "value claimed by
   * debt").
   * `"none"` — render the line only.
   */
  fill: "zero" | "baseline" | "none";
  /** Values of another series to use as the lower bound when `fill` is `"baseline"`. */
  baseline?: number[];
  /** Opacity of the fill. Default 0.2. */
  fillOpacity?: number;
  /** Stroke width. Default 1.5; set to 0 to hide the line. */
  strokeWidth?: number;
  /** Major-unit value per point; must match the length of `points`. */
  values: number[];
  /**
   * Optional per-point values to display in the tooltip in place of
   * `values`. Useful when `values` is a cumulative stack total but the
   * tooltip should show the individual band amount.
   */
  tooltipValues?: number[];
};

type Props = {
  /** Snapshot dates, in plot order. */
  points: Date[];
  series: NetWorthChartSeries[];
  currency: string;
  width?: number;
  height?: number;
  className?: string;
};

const AXIS_PAD_LEFT = 72;
const AXIS_PAD_RIGHT = 16;
const AXIS_PAD_TOP = 12;
const AXIS_PAD_BOTTOM = 28;

function shortDate(d: Date): string {
  return d.toLocaleDateString("en-GB", { month: "short", year: "2-digit" });
}

function fullDate(d: Date): string {
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

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

/**
 * Generic signed-line chart used on the home dashboard. Each series is
 * drawn as a stroke on top of an optional fill to the zero baseline; fills
 * pick up `negativeColor` wherever the underlying value is below zero so
 * negative balances read visually distinct from positive ones.
 */
export function NetWorthChart({
  points,
  series,
  currency,
  width = 880,
  height = 280,
  className,
}: Props) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const { xScale, yScale, xTicks, yTicks, plotRight, plotBottom, zeroY } =
    useMemo(() => {
      const n = points.length;
      const xMin = 0;
      const xMax = Math.max(1, n - 1);

      let dataMin = 0;
      let dataMax = 0;
      for (const s of series) {
        for (const v of s.values) {
          if (v < dataMin) dataMin = v;
          if (v > dataMax) dataMax = v;
        }
        if (s.baseline) {
          for (const v of s.baseline) {
            if (v < dataMin) dataMin = v;
            if (v > dataMax) dataMax = v;
          }
        }
      }
      if (dataMin === dataMax) dataMax = dataMin + 1;

      const { ticks, niceMin, niceMax } = buildYTicks(dataMin, dataMax, 5);
      const yRange = niceMax - niceMin || 1;
      const xRange = xMax - xMin || 1;
      const plotW = width - AXIS_PAD_LEFT - AXIS_PAD_RIGHT;
      const plotH = height - AXIS_PAD_TOP - AXIS_PAD_BOTTOM;

      const xScale = (i: number) =>
        AXIS_PAD_LEFT + ((i - xMin) / xRange) * plotW;
      const yScale = (v: number) =>
        AXIS_PAD_TOP + plotH - ((v - niceMin) / yRange) * plotH;

      const xTickCount = Math.min(6, Math.max(2, n));
      const xTicks: { x: number; label: string }[] = [];
      for (let i = 0; i < xTickCount; i++) {
        const idx = Math.round((i * (n - 1)) / (xTickCount - 1));
        const p = points[idx];
        if (p) xTicks.push({ x: idx, label: shortDate(p) });
      }

      return {
        xScale,
        yScale,
        xTicks,
        yTicks: ticks,
        plotRight: width - AXIS_PAD_RIGHT,
        plotBottom: height - AXIS_PAD_BOTTOM,
        zeroY: yScale(0),
      };
    }, [points, series, width, height]);

  if (points.length === 0) {
    return (
      <div
        className={cn(
          "flex items-center justify-center rounded border bg-muted/30 text-sm text-muted-foreground",
          className,
        )}
        style={{ width, height }}
      >
        No net-worth snapshots yet.
      </div>
    );
  }

  // Fritsch–Carlson monotone cubic Hermite interpolation. Unlike
  // Catmull-Rom, this is guaranteed not to overshoot between consecutive
  // data points, so a sharp step (e.g. a big one-off transfer) stays
  // visually close to the actual data instead of ringing.
  const pathThrough = (
    pts: { x: number; y: number }[],
    command: "M" | "L",
  ): string => {
    if (pts.length === 0) return "";
    const first = `${command} ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
    if (pts.length === 1) return first;

    const n = pts.length;
    const dx: number[] = new Array(n - 1);
    const slope: number[] = new Array(n - 1);
    for (let i = 0; i < n - 1; i++) {
      dx[i] = pts[i + 1].x - pts[i].x;
      slope[i] = (pts[i + 1].y - pts[i].y) / (dx[i] || 1);
    }
    // Tangents at each knot.
    const t: number[] = new Array(n);
    t[0] = slope[0];
    t[n - 1] = slope[n - 2];
    for (let i = 1; i < n - 1; i++) {
      const m0 = slope[i - 1];
      const m1 = slope[i];
      if (m0 * m1 <= 0) {
        t[i] = 0; // local extremum — flatten to avoid overshoot
      } else {
        // weighted harmonic mean (preserves monotonicity)
        const w1 = 2 * dx[i] + dx[i - 1];
        const w2 = dx[i] + 2 * dx[i - 1];
        t[i] = (w1 + w2) / (w1 / m0 + w2 / m1);
      }
    }
    // Fritsch–Carlson clamp — keep |a|² + |b|² ≤ 9 per segment, where
    // a = t[i]/slope, b = t[i+1]/slope.
    for (let i = 0; i < n - 1; i++) {
      if (slope[i] === 0) {
        t[i] = 0;
        t[i + 1] = 0;
        continue;
      }
      const a = t[i] / slope[i];
      const b = t[i + 1] / slope[i];
      const s = a * a + b * b;
      if (s > 9) {
        const tau = 3 / Math.sqrt(s);
        t[i] = tau * a * slope[i];
        t[i + 1] = tau * b * slope[i];
      }
    }

    const segs: string[] = [first];
    for (let i = 0; i < n - 1; i++) {
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const c1x = p1.x + dx[i] / 3;
      const c1y = p1.y + (t[i] * dx[i]) / 3;
      const c2x = p2.x - dx[i] / 3;
      const c2y = p2.y - (t[i + 1] * dx[i]) / 3;
      segs.push(
        `C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`,
      );
    }
    return segs.join(" ");
  };

  const toPts = (values: number[]) =>
    values.map((v, i) => ({ x: xScale(i), y: yScale(v) }));

  const linePath = (values: number[]) => pathThrough(toPts(values), "M");

  const closedAreaPath = (values: number[], baseline?: number[]) => {
    const topPts = toPts(values);
    const bottomPts = baseline
      ? toPts(baseline).reverse()
      : values
          .map((_, j) => values.length - 1 - j)
          .map((i) => ({
            x: xScale(i),
            y: zeroY,
          }));
    const top = pathThrough(topPts, "M");
    const bottom = pathThrough(bottomPts, "L");
    return `${top} ${bottom} Z`;
  };

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className={cn("overflow-visible", className)}
      style={{ aspectRatio: `${width} / ${height}` }}
    >
      {yTicks.map((v) => (
        <g key={`y${v}`}>
          <line
            x1={AXIS_PAD_LEFT}
            x2={plotRight}
            y1={yScale(v)}
            y2={yScale(v)}
            stroke="currentColor"
            strokeOpacity={v === 0 ? 0.3 : 0.08}
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

      <line
        x1={AXIS_PAD_LEFT}
        x2={AXIS_PAD_LEFT}
        y1={AXIS_PAD_TOP}
        y2={plotBottom}
        stroke="currentColor"
        strokeOpacity={0.25}
      />

      {series.map((s) => {
        if (s.fill === "none") return null;
        const opacity = s.fillOpacity ?? 0.2;
        if (s.fill === "baseline" && s.baseline) {
          return (
            <path
              key={`fill-${s.key}`}
              d={closedAreaPath(s.values, s.baseline)}
              fill={s.color}
              fillOpacity={opacity}
            />
          );
        }
        // fill === "zero": split at the zero line so the positive and
        // negative halves get their own colours via clip-path.
        const hasNegative = s.negativeColor && s.values.some((v) => v < 0);
        return (
          <g key={`fill-${s.key}`}>
            <defs>
              <clipPath id={`clip-pos-${s.key}`}>
                <rect
                  x={AXIS_PAD_LEFT}
                  y={AXIS_PAD_TOP}
                  width={plotRight - AXIS_PAD_LEFT}
                  height={Math.max(0, zeroY - AXIS_PAD_TOP)}
                />
              </clipPath>
              {hasNegative && (
                <clipPath id={`clip-neg-${s.key}`}>
                  <rect
                    x={AXIS_PAD_LEFT}
                    y={zeroY}
                    width={plotRight - AXIS_PAD_LEFT}
                    height={Math.max(0, plotBottom - zeroY)}
                  />
                </clipPath>
              )}
            </defs>
            <path
              d={closedAreaPath(s.values)}
              fill={s.color}
              fillOpacity={opacity}
              clipPath={`url(#clip-pos-${s.key})`}
            />
            {hasNegative && (
              <path
                d={closedAreaPath(s.values)}
                fill={s.negativeColor}
                fillOpacity={opacity}
                clipPath={`url(#clip-neg-${s.key})`}
              />
            )}
          </g>
        );
      })}

      {series.map((s) => {
        const sw = s.strokeWidth ?? 1.5;
        if (sw === 0) return null;
        return (
          <path
            key={`line-${s.key}`}
            d={linePath(s.values)}
            fill="none"
            stroke={s.color}
            strokeWidth={sw}
          />
        );
      })}

      {hoverIdx !== null &&
        (() => {
          const date = points[hoverIdx];
          const cx = xScale(hoverIdx);
          const rowH = 16;
          const headerH = 22;
          const padY = 10;
          const boxW = 220;
          const boxH = headerH + series.length * rowH + padY;
          const gap = 10;
          const preferRight = cx + gap + boxW <= plotRight;
          const boxX = preferRight
            ? cx + gap
            : Math.max(AXIS_PAD_LEFT, cx - gap - boxW);
          const boxY = Math.max(
            AXIS_PAD_TOP,
            Math.min(plotBottom - boxH, AXIS_PAD_TOP + 8),
          );
          return (
            <g pointerEvents="none">
              <line
                x1={cx}
                x2={cx}
                y1={AXIS_PAD_TOP}
                y2={plotBottom}
                stroke="currentColor"
                strokeOpacity={0.2}
                strokeDasharray="2 2"
              />
              {series.map((s) => {
                const v = s.values[hoverIdx];
                return (
                  <circle
                    key={`dot-${s.key}`}
                    cx={cx}
                    cy={yScale(v)}
                    r={3}
                    fill={v < 0 && s.negativeColor ? s.negativeColor : s.color}
                    stroke="var(--background, white)"
                    strokeWidth={1.5}
                  />
                );
              })}
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
                <text x={boxX + 10} y={boxY + 16} className="font-medium">
                  {fullDate(date)}
                </text>
                {series.map((s, i) => {
                  const display = (s.tooltipValues ?? s.values)[hoverIdx];
                  const swatch =
                    display < 0 && s.negativeColor ? s.negativeColor : s.color;
                  return (
                    <g
                      key={`row-${s.key}`}
                      transform={`translate(0, ${boxY + headerH + i * rowH})`}
                    >
                      <rect
                        x={boxX + 10}
                        y={2}
                        width={8}
                        height={8}
                        fill={swatch}
                      />
                      <text x={boxX + 24} y={9}>
                        {s.label}
                      </text>
                      <text x={boxX + boxW - 10} y={9} textAnchor="end">
                        {formatAccountingMoneyRounded(currency, display)}
                      </text>
                    </g>
                  );
                })}
              </g>
            </g>
          );
        })()}

      <rect
        x={AXIS_PAD_LEFT}
        y={AXIS_PAD_TOP}
        width={width - AXIS_PAD_LEFT - AXIS_PAD_RIGHT}
        height={height - AXIS_PAD_TOP - AXIS_PAD_BOTTOM}
        fill="transparent"
        onPointerLeave={() => setHoverIdx(null)}
        onPointerMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          if (rect.width === 0) return;
          const rel = (e.clientX - rect.left) / rect.width;
          if (rel < 0 || rel > 1) {
            setHoverIdx(null);
            return;
          }
          const idx = Math.max(
            0,
            Math.min(points.length - 1, Math.round(rel * (points.length - 1))),
          );
          setHoverIdx(idx);
        }}
      />
    </svg>
  );
}

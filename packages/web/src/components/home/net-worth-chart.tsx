import { CircleCheck, GripVertical, LockOpen } from "lucide-react";
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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
  /** Stroke opacity. Default 1. Useful for rendering a comparison baseline behind the main line. */
  strokeOpacity?: number;
  /** SVG `stroke-dasharray` for the line (e.g. `"4 3"`). Omitted by default. */
  strokeDasharray?: string;
  /** Major-unit value per point; must match the length of `points`. A `null` entry is rendered as a gap — the line breaks and resumes at the next non-null point. Only supported when `fill === "none"`. */
  values: (number | null)[];
  /**
   * Optional per-point values to display in the tooltip in place of
   * `values`. Useful when `values` is a cumulative stack total but the
   * tooltip should show the individual band amount. `null` hides the row
   * for that point.
   */
  tooltipValues?: (number | null)[];
};

/** A single pinned event on the chart. `index` is a fractional index into `points`. The chart picks an icon + colour based on `kind` and wraps it in a shadcn Tooltip showing `label`. */
export type ChartMilestone = {
  index: number;
  label: string;
  kind: "loan" | "pension";
};

type Props = {
  /** Snapshot dates, in plot order. */
  points: Date[];
  series: NetWorthChartSeries[];
  currency: string;
  width?: number;
  height?: number;
  className?: string;
  /**
   * Index into `points` at which the forecast begins. When set, all
   * points at or after this index are tinted lighter, rendered with a
   * dashed stroke, and a vertical "today" marker is drawn at the
   * boundary. Leave undefined to render the whole series as history.
   */
  forecastStart?: number;
  /**
   * Fractional index into `points` at which retirement begins. Drawn as
   * a dashed vertical marker with a "Retirement" label. Fractional because
   * the retirement date may fall between two thinned forecast points; the
   * caller interpolates. Leave undefined to omit the marker.
   */
  retirementStart?: number;
  /**
   * Called while the user drags the retirement marker, and once on
   * release. The `date` is interpolated from the marker's pixel position
   * back onto the chart's date axis. When undefined the marker is not
   * draggable.
   */
  onRetirementDrag?: (date: Date) => void;
  onRetirementDragEnd?: (date: Date) => void;
  /**
   * Notable events to pin on the chart — e.g. loans paid off, pensions
   * becoming accessible. Rendered as thin dashed vertical markers with
   * a short label. Fractional index; the caller interpolates.
   */
  milestones?: ChartMilestone[];
  /**
   * When true, the y-axis is rendered on a log10 scale. Zero and
   * negative values are clamped to the lowest tick for display, and
   * all fills are suppressed (the zero baseline doesn't exist in log
   * space, so stacked bands stop being meaningful).
   */
  logY?: boolean;
};

const AXIS_PAD_LEFT_MOBILE = 44;
const AXIS_PAD_LEFT_DESKTOP = 86;
const AXIS_PAD_RIGHT = 16;
const AXIS_PAD_TOP = 12;
const AXIS_PAD_BOTTOM = 36;

// Mirror Tailwind's `sm:` breakpoint by reading `--breakpoint-sm` at
// module load — keeps the media query in lockstep with `sm:` utility
// classes. Module-scoped so every chart instance shares the same
// `MediaQueryList` and listener set.
const smMediaQuery = (() => {
  if (typeof window === "undefined") return null;
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue("--breakpoint-sm")
    .trim();
  return window.matchMedia(`(min-width: ${raw || "40rem"})`);
})();
const subscribeSmBreakpoint = (onChange: () => void) => {
  if (!smMediaQuery) return () => {};
  smMediaQuery.addEventListener("change", onChange);
  return () => smMediaQuery.removeEventListener("change", onChange);
};
const getSmBreakpointMatch = () => smMediaQuery?.matches ?? false;

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
 * Log10 y-axis ticks at {1, 2, 5} × 10^k covering [min, max]. `min` is
 * clamped up to 1 before bucketing so we never try to take log10 of
 * zero. Returns the pixel-space extents too so the caller can build the
 * log scale without re-deriving them.
 */
function buildLogYTicks(
  min: number,
  max: number,
): { ticks: number[]; niceMin: number; niceMax: number } {
  const lo = Math.max(1, min);
  const hi = Math.max(lo * 10, max);
  const loExp = Math.floor(Math.log10(lo));
  const hiExp = Math.ceil(Math.log10(hi));
  const decades = hiExp - loExp;
  // Thin the {1, 2, 5} minor ticks as the range widens — otherwise a
  // 4-decade span produces 12+ labels stacked on the axis.
  const mantissas = decades <= 2 ? [1, 2, 5] : decades <= 4 ? [1, 3] : [1];
  const ticks: number[] = [];
  for (let e = loExp; e <= hiExp; e++) {
    for (const m of mantissas) {
      const v = m * Math.pow(10, e);
      if (v >= Math.pow(10, loExp) && v <= Math.pow(10, hiExp)) ticks.push(v);
    }
  }
  return {
    ticks,
    niceMin: Math.pow(10, loExp),
    niceMax: Math.pow(10, hiExp),
  };
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
  width: widthProp,
  height: heightProp = 420,
  className,
  forecastStart,
  retirementStart,
  onRetirementDrag,
  onRetirementDragEnd,
  milestones,
  logY = false,
}: Props) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  // Measure the container so the viewBox matches the rendered pixel size
  // and text stays crisp without aspect-ratio-based scaling. On mobile we
  // fall back to a square-ish aspect; on desktop the height is constant
  // (see the wrapping div's Tailwind classes).
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const subscribeSize = useCallback(
    (onChange: () => void) => {
      if (widthProp != null || !containerEl) return () => {};
      const ro = new ResizeObserver(onChange);
      ro.observe(containerEl);
      return () => ro.disconnect();
    },
    [containerEl, widthProp],
  );
  // Encode the snapshot as a string so `useSyncExternalStore`'s === bail-out
  // works — two reads with the same dimensions compare equal without a cache.
  const getSize = useCallback(
    () =>
      containerEl
        ? `${containerEl.clientWidth}x${containerEl.clientHeight}`
        : `${widthProp ?? 800}x${heightProp}`,
    [containerEl, widthProp, heightProp],
  );
  const sizeKey = useSyncExternalStore(subscribeSize, getSize, getSize);
  const [measuredW, measuredH] = sizeKey.split("x").map(Number);
  const width = widthProp ?? measuredW;
  const height = widthProp != null ? heightProp : measuredH;
  // Mirror Tailwind's `sm:` breakpoint (40rem) via matchMedia — keeps the
  // padding switch tied to viewport width, not the chart's own width.
  const isDesktop = useSyncExternalStore(
    subscribeSmBreakpoint,
    getSmBreakpointMatch,
    () => false,
  );
  const AXIS_PAD_LEFT = isDesktop
    ? AXIS_PAD_LEFT_DESKTOP
    : AXIS_PAD_LEFT_MOBILE;

  const {
    xScale,
    xInverse,
    yScale,
    xTicks,
    yTicks,
    plotRight,
    plotBottom,
    zeroY,
  } = useMemo(() => {
    const n = points.length;

    let dataMin = logY ? Infinity : 0;
    let dataMax = 0;
    for (const s of series) {
      for (const v of s.values) {
        if (v == null) continue;
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
    if (!Number.isFinite(dataMin)) dataMin = 0;
    if (dataMin === dataMax) dataMax = dataMin + 1;

    const plotW = width - AXIS_PAD_LEFT - AXIS_PAD_RIGHT;
    const plotH = height - AXIS_PAD_TOP - AXIS_PAD_BOTTOM;

    // X-axis is linear in calendar time so irregular gaps in the
    // recorded history (e.g. a skipped month) and the monthly forecast
    // tail render with a single consistent spacing — no visual jump
    // where history hands over to forecast.
    const tMin = points[0]?.getTime() ?? 0;
    const tMax = points[n - 1]?.getTime() ?? tMin + 1;
    const tRange = tMax - tMin || 1;
    // Linearly interpolate between the two surrounding dates when `i` is
    // fractional — callers (e.g. the retirement marker) can pass a
    // between-points index and still get a sensible pixel position.
    const xScale = (i: number) => {
      const lo = Math.floor(i);
      const hi = Math.min(lo + 1, n - 1);
      const frac = i - lo;
      const t =
        points[lo].getTime() +
        frac * (points[hi].getTime() - points[lo].getTime());
      return AXIS_PAD_LEFT + ((t - tMin) / tRange) * plotW;
    };
    const xInverse = (px: number): Date => {
      const clamped = Math.max(
        AXIS_PAD_LEFT,
        Math.min(AXIS_PAD_LEFT + plotW, px),
      );
      const t = tMin + ((clamped - AXIS_PAD_LEFT) / plotW) * tRange;
      return new Date(t);
    };

    const xTickCount = Math.min(6, Math.max(2, n));
    const xTicks: { x: number; label: string }[] = [];
    for (let i = 0; i < xTickCount; i++) {
      const t = tMin + (i * tRange) / (xTickCount - 1);
      const pxX = AXIS_PAD_LEFT + ((t - tMin) / tRange) * plotW;
      xTicks.push({ x: pxX, label: shortDate(new Date(t)) });
    }

    if (logY) {
      const { ticks, niceMin, niceMax } = buildLogYTicks(dataMin, dataMax);
      const logMin = Math.log10(niceMin);
      const logMax = Math.log10(niceMax);
      const logRange = logMax - logMin || 1;
      const yScale = (v: number) => {
        const clamped = Math.max(v, niceMin);
        return (
          AXIS_PAD_TOP +
          plotH -
          ((Math.log10(clamped) - logMin) / logRange) * plotH
        );
      };
      return {
        xScale,
        xInverse,
        yScale,
        xTicks,
        yTicks: ticks,
        plotRight: width - AXIS_PAD_RIGHT,
        plotBottom: height - AXIS_PAD_BOTTOM,
        // Treat £1 (= log10 0) as the zero baseline so `fill: "zero"`
        // stacks still paint meaningfully in log space.
        zeroY: yScale(niceMin),
      };
    }

    const { ticks, niceMin, niceMax } = buildYTicks(dataMin, dataMax, 5);
    const yRange = niceMax - niceMin || 1;
    const yScale = (v: number) =>
      AXIS_PAD_TOP + plotH - ((v - niceMin) / yRange) * plotH;

    return {
      xScale,
      xInverse,
      yScale,
      xTicks,
      yTicks: ticks,
      plotRight: width - AXIS_PAD_RIGHT,
      plotBottom: height - AXIS_PAD_BOTTOM,
      zeroY: yScale(0),
    };
  }, [points, series, width, height, logY]);

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

  /** Build an SVG path that breaks at `null` entries — each contiguous run of non-null values becomes its own `M …` subpath, separated by spaces. */
  const linePath = (values: (number | null)[]) => {
    const runs: { x: number; y: number }[][] = [];
    let cur: { x: number; y: number }[] = [];
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v == null) {
        if (cur.length > 0) runs.push(cur);
        cur = [];
      } else {
        cur.push({ x: xScale(i), y: yScale(v) });
      }
    }
    if (cur.length > 0) runs.push(cur);
    return runs.map((r) => pathThrough(r, "M")).join(" ");
  };

  const closedAreaPath = (values: (number | null)[], baseline?: number[]) => {
    // Filled areas (fill="zero" / "baseline") aren't expected to contain
    // gaps — coerce stray nulls to 0 so the area still closes cleanly.
    const dense = values.map((v) => v ?? 0);
    const topPts = toPts(dense);
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
    <div
      ref={setContainerEl}
      className={cn(
        "w-full",
        // Mobile: keep the historical 800 : 420 aspect so the chart
        // still has breathing room on narrow screens. Desktop: fixed
        // height, width fills the container and the viewBox is sized
        // from the measured pixel width so text doesn't stretch.
        widthProp == null && "aspect-[800/420] sm:aspect-auto sm:h-[420px]",
        className,
      )}
    >
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        className="block h-full w-full overflow-visible text-[10px] tabular-nums sm:text-[13px]"
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
              className="fill-muted-foreground"
            >
              {formatAccountingMoney(currency, v, { compact: true })}
            </text>
          </g>
        ))}

        {xTicks.map((t) => (
          <text
            key={`x${t.x}`}
            x={t.x}
            y={height - 8}
            textAnchor="middle"
            className="fill-muted-foreground"
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
          const hasNegative =
            s.negativeColor && s.values.some((v) => v != null && v < 0);
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
              strokeOpacity={s.strokeOpacity}
              strokeDasharray={s.strokeDasharray}
            />
          );
        })}

        {hoverIdx !== null &&
          (() => {
            const date = points[hoverIdx];
            const cx = xScale(hoverIdx);
            // Drop series whose tooltipValues (falling back to values) are
            // all zero across the range — a legend item the user just hid
            // shouldn't reappear in the hover card either.
            const tooltipSeries = series.filter((s) =>
              (s.tooltipValues ?? s.values).some((v) => v != null && v !== 0),
            );
            const rowH = 30;
            const headerH = 38;
            const padY = 12;
            const boxW = 340;
            const boxH = headerH + tooltipSeries.length * rowH + padY;
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
                {tooltipSeries.map((s) => {
                  const v = s.values[hoverIdx];
                  if (v == null) return null;
                  return (
                    <circle
                      key={`dot-${s.key}`}
                      cx={cx}
                      cy={yScale(v)}
                      r={3}
                      fill={
                        v < 0 && s.negativeColor ? s.negativeColor : s.color
                      }
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
                <g className="fill-foreground">
                  <text x={boxX + 14} y={boxY + 26} className="font-medium">
                    {fullDate(date)}
                  </text>
                  {tooltipSeries.map((s, i) => {
                    const display = (s.tooltipValues ?? s.values)[hoverIdx];
                    const swatch =
                      display != null && display < 0 && s.negativeColor
                        ? s.negativeColor
                        : s.color;
                    return (
                      <g
                        key={`row-${s.key}`}
                        transform={`translate(0, ${boxY + headerH + i * rowH})`}
                      >
                        <rect
                          x={boxX + 14}
                          y={4}
                          width={12}
                          height={12}
                          fill={swatch}
                        />
                        <text x={boxX + 32} y={14}>
                          {s.label}
                        </text>
                        <text x={boxX + boxW - 14} y={14} textAnchor="end">
                          {display == null
                            ? "—"
                            : formatAccountingMoneyRounded(currency, display)}
                        </text>
                      </g>
                    );
                  })}
                </g>
              </g>
            );
          })()}

        {forecastStart != null &&
          forecastStart > 0 &&
          forecastStart < points.length &&
          (() => {
            const markerX = xScale(forecastStart);
            const forecastLeft = markerX;
            const forecastWidth = plotRight - markerX;
            return (
              <g pointerEvents="none">
                {/* Translucent overlay over the forecast region so past vs
                  projected values read as visually distinct without
                  repainting every series twice. */}
                {forecastWidth > 0 && (
                  <rect
                    x={forecastLeft}
                    y={AXIS_PAD_TOP}
                    width={forecastWidth}
                    height={plotBottom - AXIS_PAD_TOP}
                    fill="currentColor"
                    fillOpacity={0.05}
                  />
                )}
                {/* Vertical marker at the history / forecast boundary. */}
                <line
                  x1={markerX}
                  x2={markerX}
                  y1={AXIS_PAD_TOP}
                  y2={plotBottom}
                  stroke="currentColor"
                  strokeOpacity={0.35}
                  strokeDasharray="3 3"
                />
                <text
                  x={markerX + 4}
                  y={AXIS_PAD_TOP + 10}
                  className="fill-muted-foreground"
                >
                  Forecast →
                </text>
              </g>
            );
          })()}

        {retirementStart != null &&
          retirementStart > 0 &&
          retirementStart < points.length &&
          (() => {
            const markerX = xScale(retirementStart);
            return (
              <g pointerEvents="none">
                <line
                  x1={markerX}
                  x2={markerX}
                  y1={AXIS_PAD_TOP}
                  y2={plotBottom}
                  stroke="currentColor"
                  strokeOpacity={0.35}
                  strokeDasharray="3 3"
                />
                <text
                  x={markerX + 4}
                  y={AXIS_PAD_TOP + 10}
                  className="fill-muted-foreground"
                >
                  Retirement →
                </text>
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
            // Points aren't uniformly spaced along the index — x is
            // linear in calendar time — so pick the nearest point by
            // viewBox-x distance rather than by rel-based rounding.
            const plotW = width - AXIS_PAD_LEFT - AXIS_PAD_RIGHT;
            const targetPx = AXIS_PAD_LEFT + rel * plotW;
            let bestIdx = 0;
            let bestDist = Infinity;
            for (let i = 0; i < points.length; i++) {
              const d = Math.abs(xScale(i) - targetPx);
              if (d < bestDist) {
                bestDist = d;
                bestIdx = i;
              }
            }
            setHoverIdx(bestIdx);
          }}
        />

        {milestones?.map((m, i) => {
          if (m.index <= 0 || m.index >= points.length) return null;
          const markerX = xScale(m.index);
          const iconSize = 14;
          const boxSize = 18;
          const boxX = markerX - boxSize / 2;
          const boxY = AXIS_PAD_TOP + 2;
          const Icon = m.kind === "loan" ? CircleCheck : LockOpen;
          // Liabilities + pensions share the chart's existing palette:
          // deep crimson for loans (matches the liabilities line), deep
          // blue for pensions (matches the pension stack band).
          const colorClass =
            m.kind === "loan" ? "text-[#8f1a1a]" : "text-[#1a5490]";
          return (
            <foreignObject
              key={i}
              x={boxX}
              y={boxY}
              width={boxSize}
              height={boxSize}
              style={{ overflow: "visible" }}
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={m.label}
                    className={cn(
                      "flex h-full w-full cursor-help items-center justify-center",
                      colorClass,
                    )}
                  >
                    <Icon size={iconSize} />
                  </button>
                </TooltipTrigger>
                <TooltipContent>{m.label}</TooltipContent>
              </Tooltip>
            </foreignObject>
          );
        })}

        {retirementStart != null &&
          retirementStart > 0 &&
          retirementStart < points.length &&
          onRetirementDrag != null &&
          (() => {
            const markerX = xScale(retirementStart);
            const iconSize = 18;
            const boxSize = 24;
            const boxX = markerX - boxSize / 2;
            const boxY = AXIS_PAD_TOP - boxSize - 2;
            // Map a clientX pixel into the svg's viewBox x coordinate.
            const clientToSvgX = (clientX: number, svg: SVGSVGElement) => {
              const rect = svg.getBoundingClientRect();
              if (rect.width === 0) return null;
              return ((clientX - rect.left) / rect.width) * width;
            };
            return (
              <foreignObject
                x={boxX}
                y={boxY}
                width={boxSize}
                height={boxSize}
                style={{ overflow: "visible" }}
              >
                <div
                  className="flex h-full w-full cursor-ew-resize items-center justify-center rounded-md border border-border bg-background text-muted-foreground shadow-sm hover:text-foreground"
                  style={{ touchAction: "none" }}
                  onPointerDown={(e) => {
                    const target = e.currentTarget;
                    target.setPointerCapture(e.pointerId);
                    // The chart SVG — NOT e.target.closest("svg"), which
                    // would find the lucide icon's inner svg and yield
                    // pixel→viewBox conversions off by orders of magnitude.
                    const svg = svgRef.current;
                    if (!svg) return;
                    const startSvgX = clientToSvgX(e.clientX, svg);
                    if (startSvgX == null) return;
                    // Preserve the offset between the cursor and the
                    // marker at click time, so the marker doesn't snap
                    // under the cursor when drag begins.
                    const offset = startSvgX - markerX;
                    const startClientX = e.clientX;
                    const DRAG_THRESHOLD = 3;
                    let dragging = false;
                    const report = (clientX: number, end: boolean) => {
                      const svgX = clientToSvgX(clientX, svg);
                      if (svgX == null) return;
                      const date = xInverse(svgX - offset);
                      (end ? onRetirementDragEnd : onRetirementDrag)?.(date);
                    };
                    const onMove = (ev: PointerEvent) => {
                      if (!dragging) {
                        if (
                          Math.abs(ev.clientX - startClientX) < DRAG_THRESHOLD
                        )
                          return;
                        dragging = true;
                      }
                      report(ev.clientX, false);
                    };
                    const onUp = (ev: PointerEvent) => {
                      if (dragging) report(ev.clientX, true);
                      target.releasePointerCapture(ev.pointerId);
                      target.removeEventListener("pointermove", onMove);
                      target.removeEventListener("pointerup", onUp);
                      target.removeEventListener("pointercancel", onUp);
                    };
                    target.addEventListener("pointermove", onMove);
                    target.addEventListener("pointerup", onUp);
                    target.addEventListener("pointercancel", onUp);
                  }}
                >
                  <GripVertical size={iconSize} />
                </div>
              </foreignObject>
            );
          })()}
      </svg>
    </div>
  );
}

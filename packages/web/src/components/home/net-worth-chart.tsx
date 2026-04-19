import { useMemo, useState } from "react";

import { cn } from "@/lib/cn";
import {
  formatAccountingMoney,
  formatAccountingMoneyRounded,
} from "@/lib/format";

export type NetWorthChartBucket = {
  /** Stable key identifying this stack slot (usually the asset type). */
  key: string;
  /** Label shown in the legend / tooltip. */
  label: string;
  /** Tailwind/CSS colour used for the stack area. */
  color: string;
};

export type NetWorthChartPoint = {
  /** Snapshot date. */
  date: Date;
  /** Major-unit amount per bucket key. Missing keys are treated as 0. */
  assetsByKey: Record<string, number>;
  /** Major-unit magnitude of liabilities (positive value, plotted below 0). */
  liabilities: number;
  /** Major-unit net worth (assetsTotal − liabilities). */
  net: number;
};

type Props = {
  points: NetWorthChartPoint[];
  /** Ordered bottom-to-top for the positive stack. */
  buckets: NetWorthChartBucket[];
  currency: string;
  width?: number;
  height?: number;
  className?: string;
};

const AXIS_PAD_LEFT = 72;
const AXIS_PAD_RIGHT = 16;
const AXIS_PAD_TOP = 12;
const AXIS_PAD_BOTTOM = 28;

const LIABILITIES_COLOR = "#dc2626"; // red-600

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
 * Stacked-area net worth chart. Positive buckets (assets by type) stack above
 * zero in `buckets` order; liabilities stack below zero as a single red band.
 * A net-worth line is drawn on top.
 */
export function NetWorthChart({
  points,
  buckets,
  currency,
  width = 880,
  height = 320,
  className,
}: Props) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const { xScale, yScale, xTicks, yTicks, plotRight, plotBottom } =
    useMemo(() => {
      const n = points.length;
      const xMin = 0;
      const xMax = Math.max(1, n - 1);

      let maxAssets = 0;
      let maxLiab = 0;
      for (const p of points) {
        const sum = buckets.reduce(
          (acc, b) => acc + (p.assetsByKey[b.key] ?? 0),
          0,
        );
        if (sum > maxAssets) maxAssets = sum;
        if (p.liabilities > maxLiab) maxLiab = p.liabilities;
      }

      const { ticks, niceMin, niceMax } = buildYTicks(
        -maxLiab,
        Math.max(maxAssets, 1),
        5,
      );
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
        if (p) xTicks.push({ x: idx, label: shortDate(p.date) });
      }

      return {
        xScale,
        yScale,
        xTicks,
        yTicks: ticks,
        plotRight: width - AXIS_PAD_RIGHT,
        plotBottom: height - AXIS_PAD_BOTTOM,
      };
    }, [points, buckets, width, height]);

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

  // Pre-compute cumulative running tops for each bucket at each point: at
  // index (b, i) = sum of buckets[0..b].amountAtPoint(i). Bottom of bucket b
  // = cumulative[b-1][i] (or 0 for b=0).
  const cumulative = buckets.map(() =>
    new Array<number>(points.length).fill(0),
  );
  for (let i = 0; i < points.length; i++) {
    let running = 0;
    for (let b = 0; b < buckets.length; b++) {
      running += points[i].assetsByKey[buckets[b].key] ?? 0;
      cumulative[b][i] = running;
    }
  }

  const netPath = points
    .map(
      (p, i) =>
        `${i === 0 ? "M" : "L"} ${xScale(i).toFixed(1)} ${yScale(p.net).toFixed(1)}`,
    )
    .join(" ");

  const liabPath = (() => {
    const top = points
      .map(
        (p, i) =>
          `${i === 0 ? "M" : "L"} ${xScale(i).toFixed(1)} ${yScale(-p.liabilities).toFixed(1)}`,
      )
      .join(" ");
    const bottom = [...points]
      .map((_, j) => j)
      .reverse()
      .map((i) => `L ${xScale(i).toFixed(1)} ${yScale(0).toFixed(1)}`)
      .join(" ");
    return `${top} ${bottom} Z`;
  })();

  const zeroY = yScale(0);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className={cn("overflow-visible", className)}
      onPointerLeave={() => setHoverIdx(null)}
      onPointerMove={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        if (rect.width === 0) return;
        const svgX = ((e.clientX - rect.left) / rect.width) * width;
        const plotW = width - AXIS_PAD_LEFT - AXIS_PAD_RIGHT;
        const rel = (svgX - AXIS_PAD_LEFT) / plotW;
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

      {/* Positive stack: bottom-up */}
      {buckets.map((b, bi) => {
        const topPath = points
          .map(
            (_, i) =>
              `${i === 0 ? "M" : "L"} ${xScale(i).toFixed(1)} ${yScale(cumulative[bi][i]).toFixed(1)}`,
          )
          .join(" ");
        const bottomPath = [...points]
          .map((_, j) => j)
          .reverse()
          .map((i) => {
            const y = bi === 0 ? 0 : cumulative[bi - 1][i];
            return `L ${xScale(i).toFixed(1)} ${yScale(y).toFixed(1)}`;
          })
          .join(" ");
        return (
          <path
            key={b.key}
            d={`${topPath} ${bottomPath} Z`}
            fill={b.color}
            fillOpacity={0.75}
            stroke={b.color}
            strokeWidth={0.5}
          />
        );
      })}

      {/* Liabilities band below zero */}
      <path
        d={liabPath}
        fill={LIABILITIES_COLOR}
        fillOpacity={0.7}
        stroke={LIABILITIES_COLOR}
        strokeWidth={0.5}
      />

      {/* Net worth line */}
      <path d={netPath} fill="none" stroke="currentColor" strokeWidth={1.5} />

      {hoverIdx !== null &&
        (() => {
          const p = points[hoverIdx];
          const cx = xScale(hoverIdx);
          const rowH = 14;
          const rows = [
            ...buckets
              .filter((b) => (p.assetsByKey[b.key] ?? 0) > 0)
              .map((b) => ({
                label: b.label,
                color: b.color,
                value: p.assetsByKey[b.key] ?? 0,
              })),
            ...(p.liabilities > 0
              ? [
                  {
                    label: "Liabilities",
                    color: LIABILITIES_COLOR,
                    value: -p.liabilities,
                  },
                ]
              : []),
          ];
          const headerH = 32;
          const footerH = 18;
          const padY = 10;
          const boxW = 200;
          const boxH = headerH + rows.length * rowH + footerH + padY;
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
              <circle
                cx={cx}
                cy={yScale(p.net)}
                r={3}
                fill="currentColor"
                stroke="var(--background, white)"
                strokeWidth={1.5}
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
                <text x={boxX + 10} y={boxY + 16} className="font-medium">
                  {fullDate(p.date)}
                </text>
                <text
                  x={boxX + boxW - 10}
                  y={boxY + 16}
                  textAnchor="end"
                  className="font-medium"
                >
                  {formatAccountingMoneyRounded(currency, p.net)}
                </text>
                <text
                  x={boxX + 10}
                  y={boxY + 28}
                  className="fill-muted-foreground"
                >
                  Net worth
                </text>
                {rows.map((r, i) => (
                  <g
                    key={r.label}
                    transform={`translate(0, ${boxY + headerH + i * rowH})`}
                  >
                    <rect
                      x={boxX + 10}
                      y={2}
                      width={8}
                      height={8}
                      fill={r.color}
                    />
                    <text x={boxX + 24} y={9}>
                      {r.label}
                    </text>
                    <text x={boxX + boxW - 10} y={9} textAnchor="end">
                      {formatAccountingMoneyRounded(currency, r.value)}
                    </text>
                  </g>
                ))}
              </g>
            </g>
          );
        })()}

      {/* Pointer surface */}
      <rect
        x={AXIS_PAD_LEFT}
        y={AXIS_PAD_TOP}
        width={width - AXIS_PAD_LEFT - AXIS_PAD_RIGHT}
        height={height - AXIS_PAD_TOP - AXIS_PAD_BOTTOM}
        fill="transparent"
      />
      {/* Zero baseline stroke (above fills so it stays visible) */}
      <line
        x1={AXIS_PAD_LEFT}
        x2={plotRight}
        y1={zeroY}
        y2={zeroY}
        stroke="currentColor"
        strokeOpacity={0.3}
      />
    </svg>
  );
}

export function NetWorthChartLegend({
  buckets,
  showLiabilities,
}: {
  buckets: NetWorthChartBucket[];
  showLiabilities: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {buckets.map((b) => (
        <span key={b.key} className="inline-flex items-center gap-1.5">
          <span
            className="inline-block h-2 w-3 rounded-sm"
            style={{ background: b.color }}
          />
          {b.label}
        </span>
      ))}
      {showLiabilities && (
        <span className="inline-flex items-center gap-1.5">
          <span
            className="inline-block h-2 w-3 rounded-sm"
            style={{ background: LIABILITIES_COLOR }}
          />
          Liabilities
        </span>
      )}
      <span className="inline-flex items-center gap-1.5">
        <span className="inline-block h-0.5 w-3 bg-foreground" />
        Net worth
      </span>
    </div>
  );
}

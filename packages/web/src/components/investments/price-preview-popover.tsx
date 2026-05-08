import { useSuspenseQuery } from "@apollo/client/react";
import { Search } from "lucide-react";
import { Suspense, useMemo, useRef, useState } from "react";

import { Spinner } from "@/components/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { graphql } from "@/graphql";
import { cn } from "@/lib/cn";
import { formatUnitPrice } from "@/lib/format";

const InvestmentPricePreviewDocument = graphql(`
  query InvestmentPricePreview($id: ID!) {
    investment(id: $id) {
      id
      currency
      name
      priceHistory {
        currency
        initialDate
        points {
          x
          y
        }
      }
    }
  }
`);

const WIDTH = 280;
const HEIGHT = 80;
const PAD_X = 4;
const PAD_Y = 6;

export function InvestmentPricePreviewPopover({
  investmentId,
}: {
  investmentId: string;
}) {
  return (
    <Tooltip delayDuration={150}>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="Show price history"
          onClick={(e) => e.stopPropagation()}
          className="shrink-0 cursor-pointer rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Search className="h-3.5 w-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        align="start"
        className="w-[300px] max-w-none p-3 text-foreground"
        onClick={(e) => e.stopPropagation()}
      >
        <Suspense
          fallback={
            <div className="flex h-[100px] items-center justify-center">
              <Spinner />
            </div>
          }
        >
          <PriceHistoryChartLoader investmentId={investmentId} />
        </Suspense>
      </TooltipContent>
    </Tooltip>
  );
}

function PriceHistoryChartLoader({ investmentId }: { investmentId: string }) {
  const { data } = useSuspenseQuery(InvestmentPricePreviewDocument, {
    variables: { id: investmentId },
  });
  const history = data.investment?.priceHistory;
  if (!history || history.points.length === 0) {
    return (
      <div className="text-xs text-muted-foreground">
        No price history recorded yet.
      </div>
    );
  }
  return <PriceHistoryChart history={history} />;
}

type PriceHistory = {
  currency: string;
  initialDate: string;
  points: ReadonlyArray<{ x: number; y: number }>;
};

type LayoutPoint = { x: number; y: number; svgX: number; svgY: number };

function PriceHistoryChart({ history }: { history: PriceHistory }) {
  const { points, currency, initialDate } = history;
  const layout = useMemo(
    () => computeChart(points, initialDate),
    [points, initialDate],
  );
  const {
    path,
    minY,
    maxY,
    firstDate,
    lastDate,
    latestY,
    firstY,
    layoutPoints,
  } = layout;

  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg || layoutPoints.length === 0) return;
    const rect = svg.getBoundingClientRect();
    // Map the pointer's CSS-pixel x to SVG viewBox coords. The chart uses
    // `preserveAspectRatio="none"` so x scales linearly with rect.width.
    const ratio = (e.clientX - rect.left) / rect.width;
    const svgX = ratio * WIDTH;
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < layoutPoints.length; i++) {
      const d = Math.abs(layoutPoints[i].svgX - svgX);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    setHoverIdx(bestIdx);
  };

  const hover = hoverIdx !== null ? layoutPoints[hoverIdx] : null;
  const hoverDate = hover ? formatDate(initialDate, hover.x) : null;

  const change = firstY === 0 ? null : (latestY - firstY) / firstY;
  const changeColor =
    change === null
      ? "text-muted-foreground"
      : change >= 0
        ? "text-emerald-600 dark:text-emerald-400"
        : "text-red-600 dark:text-red-400";

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="font-medium tabular-nums">
          {formatUnitPrice(currency, hover ? hover.y : latestY)}
        </span>
        {hover ? (
          <span className="text-muted-foreground tabular-nums">
            {hoverDate}
          </span>
        ) : (
          change !== null && (
            <span className={cn("tabular-nums", changeColor)}>
              {change >= 0 ? "+" : ""}
              {(change * 100).toFixed(1)}%
            </span>
          )
        )}
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="w-full touch-none text-indigo-500"
        preserveAspectRatio="none"
        onPointerMove={onPointerMove}
        onPointerLeave={() => setHoverIdx(null)}
      >
        <path
          d={path}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.25}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
        {hover && (
          <g pointerEvents="none">
            <line
              x1={hover.svgX}
              x2={hover.svgX}
              y1={PAD_Y}
              y2={HEIGHT - PAD_Y}
              stroke="currentColor"
              strokeOpacity={0.35}
              strokeDasharray="2 2"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
            <line
              x1={PAD_X}
              x2={WIDTH - PAD_X}
              y1={hover.svgY}
              y2={hover.svgY}
              stroke="currentColor"
              strokeOpacity={0.35}
              strokeDasharray="2 2"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
            <circle cx={hover.svgX} cy={hover.svgY} r={3} fill="currentColor" />
          </g>
        )}
      </svg>
      <div className="flex justify-between text-[10px] text-muted-foreground tabular-nums">
        <span>{firstDate}</span>
        <span>
          {formatUnitPrice(currency, minY)} – {formatUnitPrice(currency, maxY)}
        </span>
        <span>{lastDate}</span>
      </div>
    </div>
  );
}

function computeChart(
  points: ReadonlyArray<{ x: number; y: number }>,
  initialDate: string,
): {
  path: string;
  minY: number;
  maxY: number;
  firstDate: string;
  lastDate: string;
  firstY: number;
  latestY: number;
  layoutPoints: LayoutPoint[];
} {
  const xMin = points[0].x;
  const xMax = points[points.length - 1].x;
  const xSpan = Math.max(1, xMax - xMin);
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const p of points) {
    if (p.y < yMin) yMin = p.y;
    if (p.y > yMax) yMax = p.y;
  }
  const ySpan = yMax - yMin || 1;
  const innerW = WIDTH - PAD_X * 2;
  const innerH = HEIGHT - PAD_Y * 2;
  const layoutPoints: LayoutPoint[] = points.map((p) => ({
    x: p.x,
    y: p.y,
    svgX: PAD_X + ((p.x - xMin) / xSpan) * innerW,
    svgY: PAD_Y + (1 - (p.y - yMin) / ySpan) * innerH,
  }));
  const path = layoutPoints
    .map(
      (p, i) =>
        `${i === 0 ? "M" : "L"}${p.svgX.toFixed(2)},${p.svgY.toFixed(2)}`,
    )
    .join(" ");
  return {
    path,
    minY: yMin,
    maxY: yMax,
    firstDate: formatDate(initialDate, xMin),
    lastDate: formatDate(initialDate, xMax),
    firstY: points[0].y,
    latestY: points[points.length - 1].y,
    layoutPoints,
  };
}

function formatDate(initialDate: string, daysSince: number): string {
  const initialMs = new Date(`${initialDate}T00:00:00Z`).getTime();
  return new Date(initialMs + daysSince * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

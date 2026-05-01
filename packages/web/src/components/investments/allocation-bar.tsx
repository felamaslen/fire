import { useCallback, useLayoutEffect, useRef, useState } from "react";

import { cn } from "@/lib/cn";

export type AllocationSegment = {
  id: string;
  label: string;
  color: string;
  /** Fraction of the whole bar (values across segments should sum to 1). */
  value: number;
  /** Optional override for the hover tooltip. Defaults to `"${label}: ${formatValue(value)}"`. Pass an empty string to suppress the tooltip entirely. */
  title?: string;
};

export type AllocationBarProps = {
  segments: AllocationSegment[];
  /**
   * Returns a drag handler for the boundary between `leftId` and `rightId`, or
   * `null` / `undefined` to render a fixed (non-draggable) boundary. The
   * handler is called with the cumulative fraction of the bar width dragged
   * from the pointerdown position (positive = dragged right).
   */
  onBoundaryDrag?: (
    leftId: string,
    rightId: string,
  ) =>
    | ((
        fraction: number,
        phase: "start" | "move" | "end",
        point: { clientX: number; clientY: number; pointerType: string },
      ) => void)
    | null
    | undefined;
  /** Optional formatter for the per-segment value shown inside the segment (defaults to percentage). */
  formatValue?: (value: number) => string;
  /** When `true`, render segments with muted colours to indicate inactivity. */
  disabled?: boolean;
  /** When `true`, render as a thin bar with no border. Labels are still shown when `showLabels` is set. */
  compact?: boolean;
  /** Force label rendering on/off. Defaults to `!compact` — i.e. labels show on full bars and hide on compact ones unless explicitly enabled. */
  showLabels?: boolean;
  className?: string;
};

const HANDLE_WIDTH = 10;

export function AllocationBar({
  segments,
  onBoundaryDrag,
  formatValue,
  disabled,
  compact,
  showLabels,
  className,
}: AllocationBarProps) {
  const labelsVisible = showLabels ?? !compact;
  const trackRef = useRef<HTMLDivElement>(null);
  const [trackWidth, setTrackWidth] = useState(0);

  useLayoutEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const update = () => setTrackWidth(el.getBoundingClientRect().width);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const total = segments.reduce((acc, s) => acc + s.value, 0);
  const safeTotal = total > 0 ? total : 1;
  const fmt = formatValue ?? defaultFormat;

  // Compute left edges for each segment (fraction 0..1) so we can position handles absolutely.
  const edges: number[] = [0];
  for (const s of segments)
    edges.push(edges[edges.length - 1]! + s.value / safeTotal);

  return (
    <div
      ref={trackRef}
      className={cn(
        "relative flex w-full overflow-hidden select-none",
        compact ? "h-2 rounded-sm" : "h-9 rounded-md border bg-muted/40",
        className,
      )}
    >
      {segments.map((s) => {
        const widthPct = (s.value / safeTotal) * 100;
        return (
          <div
            key={s.id}
            className={cn(
              "h-full min-w-0",
              labelsVisible &&
                "flex items-center justify-center px-1 font-medium text-white tabular-nums leading-none",
              labelsVisible && (compact ? "text-[9px]" : "text-[10px]"),
            )}
            style={{
              width: `${widthPct}%`,
              backgroundColor: s.color,
              opacity: disabled ? 0.6 : 1,
            }}
            title={
              s.title === ""
                ? undefined
                : (s.title ?? `${s.label}: ${fmt(s.value)}`)
            }
          >
            {labelsVisible ? (
              <span className="truncate drop-shadow-sm">
                {widthPct >= 6
                  ? compact
                    ? s.label
                    : `${s.label} ${fmt(s.value)}`
                  : null}
              </span>
            ) : null}
          </div>
        );
      })}

      {onBoundaryDrag &&
        segments.slice(0, -1).map((s, i) => {
          const right = segments[i + 1]!;
          const handler = onBoundaryDrag(s.id, right.id);
          if (!handler) return null;
          const leftPct = edges[i + 1]! * 100;
          return (
            <BoundaryHandle
              key={`${s.id}|${right.id}`}
              leftPct={leftPct}
              trackWidth={trackWidth}
              onDrag={handler}
            />
          );
        })}
    </div>
  );
}

function BoundaryHandle({
  leftPct,
  trackWidth,
  onDrag,
}: {
  leftPct: number;
  trackWidth: number;
  onDrag: (
    fraction: number,
    phase: "start" | "move" | "end",
    point: { clientX: number; clientY: number; pointerType: string },
  ) => void;
}) {
  const startXRef = useRef<number | null>(null);
  const widthRef = useRef(trackWidth);
  widthRef.current = trackWidth;

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
      startXRef.current = e.clientX;
      onDrag(0, "start", {
        clientX: e.clientX,
        clientY: e.clientY,
        pointerType: e.pointerType,
      });
    },
    [onDrag],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const start = startXRef.current;
      if (start === null) return;
      const w = widthRef.current;
      if (w <= 0) return;
      onDrag((e.clientX - start) / w, "move", {
        clientX: e.clientX,
        clientY: e.clientY,
        pointerType: e.pointerType,
      });
    },
    [onDrag],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const start = startXRef.current;
      if (start === null) return;
      const w = widthRef.current;
      if (w > 0)
        onDrag((e.clientX - start) / w, "end", {
          clientX: e.clientX,
          clientY: e.clientY,
          pointerType: e.pointerType,
        });
      startXRef.current = null;
      (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
    },
    [onDrag],
  );

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className="absolute top-0 h-full cursor-ew-resize touch-none"
      style={{
        left: `calc(${leftPct}% - ${HANDLE_WIDTH / 2}px)`,
        width: HANDLE_WIDTH,
      }}
    >
      <div className="mx-auto h-full w-[2px] bg-white/90 shadow-[0_0_0_1px_rgba(0,0,0,0.35)]" />
    </div>
  );
}

function defaultFormat(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

import { useQuery } from "@apollo/client/react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight, LayoutGrid } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { graphql, type ResultOf } from "@/graphql";
import { formatAccountingMoney } from "@/lib/format";

const NetWorthBlockMapDocument = graphql(`
  query NetWorthBlockMap {
    netWorth(last: 24) {
      edges {
        node {
          id
          date
          totalNet {
            amount
            currency
          }
          values {
            id
            amountHome {
              amount
              currency
            }
            asset {
              id
              name
              type
            }
            liability {
              id
              name
              type
            }
            option {
              id
              name
            }
          }
        }
      }
    }
  }
`);

type Entry = NonNullable<
  ResultOf<typeof NetWorthBlockMapDocument>["netWorth"]
>["edges"][number]["node"];
type Value = Entry["values"][number];

/** All concrete `NetWorthAssetType` values, derived from the query so adding a new server-side enum value forces a compile error in the label / colour tables below. */
type AssetType = NonNullable<Value["asset"]>["type"];
/** All concrete `NetWorthLiabilityType` values, derived the same way. */
type LiabilityType = NonNullable<Value["liability"]>["type"];

type Block =
  | {
      id: string;
      name: string;
      amount: number;
      currency: string;
      kind: "asset";
      subtype: AssetType;
      color: string;
    }
  | {
      id: string;
      name: string;
      amount: number;
      currency: string;
      kind: "liability";
      subtype: LiabilityType;
      color: string;
    }
  | {
      id: string;
      name: string;
      amount: number;
      currency: string;
      kind: "option";
      subtype: null;
      color: string;
    };

const ASSET_COLORS = {
  CASH: "#176b4a",
  STOCK: "#4a4a4a",
  PENSION: "#1a5490",
  PROPERTY: "#3b6c2a",
  VEHICLE: "#7a5b18",
  OPTION: "#5b3a80",
  MISC: "#5b3a80",
} as const satisfies Record<AssetType, string>;
const LIABILITY_COLOR = "#8f1a1a";
const OPTION_COLOR = "#5b3a80";

function blockFromValue(v: Value): Block | null {
  const amount = v.amountHome.amount;
  if (amount === 0) return null;
  if (v.asset) {
    return {
      id: v.id,
      name: v.asset.name,
      amount,
      currency: v.amountHome.currency,
      kind: "asset",
      subtype: v.asset.type,
      color: ASSET_COLORS[v.asset.type],
    };
  }
  if (v.liability) {
    return {
      id: v.id,
      name: v.liability.name,
      amount,
      currency: v.amountHome.currency,
      kind: "liability",
      subtype: v.liability.type,
      color: LIABILITY_COLOR,
    };
  }
  if (v.option) {
    return {
      id: v.id,
      name: v.option.name,
      amount,
      currency: v.amountHome.currency,
      kind: "option",
      subtype: null,
      color: OPTION_COLOR,
    };
  }
  return null;
}

type Rect = { x: number; y: number; w: number; h: number };
type LaidOutBlock = Block & { rect: Rect };

/** Squarified treemap layout — Bruls/Huijing/van Wijk 2000. Returns each item's rect in the same order as `items`. */
function squarifyRects<T extends { weight: number }>(
  items: T[],
  rect: Rect,
): { item: T; rect: Rect }[] {
  if (items.length === 0 || rect.w <= 0 || rect.h <= 0) return [];
  const total = items.reduce((s, it) => s + it.weight, 0);
  if (total <= 0) return [];
  const totalArea = rect.w * rect.h;
  const indexed = items.map((it, i) => ({
    item: it,
    area: (it.weight / total) * totalArea,
    inputIndex: i,
  }));
  indexed.sort((a, b) => b.area - a.area);

  const out: { item: T; rect: Rect }[] = [];
  let x = rect.x;
  let y = rect.y;
  let w = rect.w;
  let h = rect.h;
  let row: typeof indexed = [];
  let i = 0;

  const worstRatio = (row: typeof indexed, side: number): number => {
    if (row.length === 0) return Infinity;
    const sum = row.reduce((s, r) => s + r.area, 0);
    let max = -Infinity;
    let min = Infinity;
    for (const r of row) {
      if (r.area > max) max = r.area;
      if (r.area < min) min = r.area;
    }
    const s2 = sum * sum;
    const side2 = side * side;
    return Math.max((side2 * max) / s2, s2 / (side2 * min));
  };

  const layoutRow = (
    row: typeof indexed,
    side: number,
    ox: number,
    oy: number,
    /** True when the strip runs across the top (rect is taller than wide). */
    horizontalStrip: boolean,
  ) => {
    const sum = row.reduce((s, r) => s + r.area, 0);
    const thickness = sum / side;
    let offset = 0;
    for (const r of row) {
      const length = r.area / thickness;
      if (horizontalStrip) {
        out[r.inputIndex] = {
          item: r.item,
          rect: { x: ox + offset, y: oy, w: length, h: thickness },
        };
      } else {
        out[r.inputIndex] = {
          item: r.item,
          rect: { x: ox, y: oy + offset, w: thickness, h: length },
        };
      }
      offset += length;
    }
    return thickness;
  };

  while (i < indexed.length) {
    const horizontalStrip = h > w;
    const side = horizontalStrip ? w : h;
    const test = [...row, indexed[i]];
    const oldWorst = row.length === 0 ? Infinity : worstRatio(row, side);
    const newWorst = worstRatio(test, side);
    if (newWorst <= oldWorst) {
      row = test;
      i++;
    } else {
      const thickness = layoutRow(row, side, x, y, horizontalStrip);
      if (horizontalStrip) {
        y += thickness;
        h -= thickness;
      } else {
        x += thickness;
        w -= thickness;
      }
      row = [];
    }
  }
  if (row.length > 0) {
    const horizontalStrip = h > w;
    const side = horizontalStrip ? w : h;
    layoutRow(row, side, x, y, horizontalStrip);
  }
  return out;
}

function formatMonth(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", {
    year: "numeric",
    month: "long",
    timeZone: "UTC",
  });
}

export function NetWorthBlockMapButton() {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (l) => l.pathname });
  const open = pathname === "/composition";
  const setOpen = (next: boolean) => {
    void navigate({ to: next ? "/composition" : "/" });
  };
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex cursor-pointer items-center rounded-sm text-muted-foreground hover:text-foreground"
        aria-label="Net worth block map"
      >
        <LayoutGrid className="h-3.5 w-3.5" />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex h-svh max-h-none w-screen max-w-none flex-col overflow-hidden rounded-none p-4 sm:h-[90vh] sm:max-h-[90vh] sm:w-[calc(100vw-2rem)] sm:max-w-6xl sm:rounded-lg sm:p-6">
          {open && <BlockMapBody />}
        </DialogContent>
      </Dialog>
    </>
  );
}

function BlockMapBody() {
  const { data, loading, error } = useQuery(NetWorthBlockMapDocument);
  const entries = useMemo(
    () => data?.netWorth?.edges.map((e) => e.node) ?? [],
    [data],
  );
  const [index, setIndex] = useState<number | null>(null);
  const effectiveIndex =
    index ?? (entries.length > 0 ? entries.length - 1 : null);
  const entry =
    effectiveIndex !== null ? (entries[effectiveIndex] ?? null) : null;

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <span>Composition</span>
          {entry && (
            <span className="text-sm font-normal text-muted-foreground">
              {formatMonth(entry.date)}
            </span>
          )}
        </DialogTitle>
      </DialogHeader>
      <div className="flex min-h-0 flex-1 flex-col">
        {loading && !entry ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            Loading…
          </div>
        ) : error ? (
          <div className="py-12 text-center text-sm text-red-600">
            {error.message}
          </div>
        ) : !entry ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            No entries yet.
          </div>
        ) : (
          <BlockMap entry={entry} />
        )}
      </div>
      <div className="flex items-center justify-between">
        <Button
          variant="outline"
          size="sm"
          disabled={effectiveIndex === null || effectiveIndex <= 0}
          onClick={() => {
            if (effectiveIndex == null) return;
            setIndex(Math.max(0, effectiveIndex - 1));
          }}
        >
          <ChevronLeft className="h-4 w-4" />
          Previous month
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={
            effectiveIndex === null || effectiveIndex >= entries.length - 1
          }
          onClick={() => {
            if (effectiveIndex == null) return;
            setIndex(Math.min(entries.length - 1, effectiveIndex + 1));
          }}
        >
          Next month
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </>
  );
}

/** Vertical room reserved at the top of a level-1 group (Assets / Liabilities) for its label. */
const TOP_HEADER = 22;
/** Vertical room reserved at the top of a level-2 subgroup (Cash / Stocks / Loans / …) for its label. */
const SUB_HEADER = 16;
/** Pixel gap painted around each group panel; below this size, headers/labels are dropped. */
const GROUP_PAD = 4;
/** Minimum subgroup dimensions for showing the inline header label. */
const SUB_HEADER_MIN_W = 40;
const SUB_HEADER_MIN_H = 28;

const ASSET_SUBTYPE_LABELS = {
  CASH: "Cash",
  STOCK: "Stocks",
  OPTION: "Options",
  PENSION: "Pensions",
  PROPERTY: "Property",
  VEHICLE: "Vehicles",
  MISC: "Other",
} as const satisfies Record<AssetType, string>;
const LIABILITY_SUBTYPE_LABELS = {
  CREDIT_CARD: "Credit cards",
  LOAN: "Loans",
  MISC: "Other",
} as const satisfies Record<LiabilityType, string>;

type TopKey = "assets" | "liabilities";
type SubGroup = {
  key: AssetType | LiabilityType;
  label: string;
  total: number;
  blocks: Block[];
};
type TopGroup = {
  key: TopKey;
  label: string;
  total: number;
  subgroups: SubGroup[];
};

type SubGroupPanel = {
  group: SubGroup;
  rect: Rect;
  showHeader: boolean;
};
type TopGroupPanel = {
  group: TopGroup;
  rect: Rect;
  subPanels: SubGroupPanel[];
};
type Layout = {
  topPanels: TopGroupPanel[];
  tiles: LaidOutBlock[];
};

/** Bucket key + label for a block at the subgroup (subtype) level. Options surface as OPTION-typed assets here, matching the `NetWorthAssetType` enum. */
function subBucketFor(b: Block): {
  top: TopKey;
  subtype: AssetType | LiabilityType;
  subLabel: string;
} {
  if (b.kind === "liability") {
    return {
      top: "liabilities",
      subtype: b.subtype,
      subLabel: LIABILITY_SUBTYPE_LABELS[b.subtype],
    };
  }
  if (b.kind === "asset") {
    return {
      top: "assets",
      subtype: b.subtype,
      subLabel: ASSET_SUBTYPE_LABELS[b.subtype],
    };
  }
  return {
    top: "assets",
    subtype: "OPTION",
    subLabel: ASSET_SUBTYPE_LABELS.OPTION,
  };
}

function buildGroups(entry: Entry): TopGroup[] {
  const buckets = new Map<
    TopKey,
    Map<AssetType | LiabilityType, { label: string; blocks: Block[] }>
  >();
  buckets.set("assets", new Map());
  buckets.set("liabilities", new Map());

  for (const v of entry.values) {
    const b = blockFromValue(v);
    if (!b) continue;
    const { top, subtype, subLabel } = subBucketFor(b);
    const subBuckets = buckets.get(top)!;
    const existing = subBuckets.get(subtype);
    if (existing) existing.blocks.push(b);
    else subBuckets.set(subtype, { label: subLabel, blocks: [b] });
  }

  const out: TopGroup[] = [];
  for (const [key, label] of [
    ["assets", "Assets"],
    ["liabilities", "Liabilities"],
  ] as const) {
    const subs = buckets.get(key)!;
    if (subs.size === 0) continue;
    const subgroups: SubGroup[] = [];
    for (const [subtype, { label: subLabel, blocks }] of subs) {
      const total = blocks.reduce((s, b) => s + b.amount, 0);
      if (total <= 0) continue;
      subgroups.push({ key: subtype, label: subLabel, total, blocks });
    }
    if (subgroups.length === 0) continue;
    out.push({
      key,
      label,
      total: subgroups.reduce((s, g) => s + g.total, 0),
      subgroups,
    });
  }
  return out;
}

function pad(rect: Rect, top: number, others: number): Rect {
  return {
    x: rect.x + others,
    y: rect.y + top,
    w: Math.max(0, rect.w - others * 2),
    h: Math.max(0, rect.h - top - others),
  };
}

function buildLayout(
  groups: TopGroup[],
  width: number,
  height: number,
): Layout {
  if (groups.length === 0 || width <= 0 || height <= 0) {
    return { topPanels: [], tiles: [] };
  }

  const containerRect: Rect = { x: 0, y: 0, w: width, h: height };
  const topRects = squarifyRects(
    groups.map((g) => ({ group: g, weight: g.total })),
    containerRect,
  );

  const topPanels: TopGroupPanel[] = [];
  const tiles: LaidOutBlock[] = [];

  for (const top of topRects) {
    const topInner = pad(top.rect, TOP_HEADER, GROUP_PAD);
    const subRects = squarifyRects(
      top.item.group.subgroups.map((sg) => ({ group: sg, weight: sg.total })),
      topInner,
    );
    const subPanels: SubGroupPanel[] = [];
    for (const sub of subRects) {
      const showHeader =
        sub.rect.w >= SUB_HEADER_MIN_W && sub.rect.h >= SUB_HEADER_MIN_H;
      const inner = showHeader
        ? pad(sub.rect, SUB_HEADER, 1)
        : pad(sub.rect, 1, 1);
      const leafRects = squarifyRects(
        sub.item.group.blocks.map((b) => ({ block: b, weight: b.amount })),
        inner,
      );
      for (const leaf of leafRects) {
        tiles.push({ ...leaf.item.block, rect: leaf.rect });
      }
      subPanels.push({ group: sub.item.group, rect: sub.rect, showHeader });
    }
    topPanels.push({ group: top.item.group, rect: top.rect, subPanels });
  }

  return { topPanels, tiles };
}

function BlockMap({ entry }: { entry: Entry }) {
  const groups = useMemo(() => buildGroups(entry), [entry]);

  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setSize({ w: el.clientWidth, h: el.clientHeight });
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (!r) return;
      setSize({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const layout = useMemo(
    () => buildLayout(groups, size.w, size.h),
    [groups, size.w, size.h],
  );

  if (groups.length === 0) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">
        No values recorded for this entry.
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div
        ref={containerRef}
        className="relative w-full flex-1 overflow-hidden rounded-md"
      >
        {layout.topPanels.map((p) => (
          <div
            key={p.group.key}
            className="absolute flex items-baseline justify-between text-xs font-semibold uppercase tracking-wide text-muted-foreground"
            style={{
              left: p.rect.x + GROUP_PAD,
              top: p.rect.y,
              width: Math.max(0, p.rect.w - GROUP_PAD * 2),
              height: TOP_HEADER,
            }}
          >
            <span>{p.group.label}</span>
            <span className="tabular-nums">
              {formatAccountingMoney(entry.totalNet.currency, p.group.total, {
                compact: true,
              })}
            </span>
          </div>
        ))}
        {layout.topPanels.flatMap((p) =>
          p.subPanels
            .filter((s) => s.showHeader)
            .map((s) => (
              <div
                key={`${p.group.key}:${s.group.key}`}
                className="absolute flex items-baseline justify-between gap-2 px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
                style={{
                  left: s.rect.x,
                  top: s.rect.y,
                  width: s.rect.w,
                  height: SUB_HEADER,
                }}
              >
                <span className="truncate">{s.group.label}</span>
                <span className="tabular-nums">
                  {formatAccountingMoney(
                    entry.totalNet.currency,
                    s.group.total,
                    { compact: true },
                  )}
                </span>
              </div>
            )),
        )}
        {layout.tiles.map((b) => (
          <BlockTile key={b.id} block={b} />
        ))}
      </div>
      <div className="flex items-baseline justify-between gap-4 border-t pt-2 text-sm">
        <span className="text-muted-foreground">Net worth</span>
        <span className="font-semibold tabular-nums">
          {formatAccountingMoney(
            entry.totalNet.currency,
            entry.totalNet.amount,
          )}
        </span>
      </div>
    </div>
  );
}

function BlockTile({ block }: { block: LaidOutBlock }) {
  const { rect } = block;
  const left = `${rect.x}px`;
  const top = `${rect.y}px`;
  const width = `${rect.w}px`;
  const height = `${rect.h}px`;
  // Hide the in-tile label on tiles that are too small to read it.
  const showLabel = rect.w >= 60 && rect.h >= 28;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className="absolute box-border cursor-default border border-background/40 transition-opacity hover:opacity-90"
          style={{
            left,
            top,
            width,
            height,
            background: block.color,
            opacity: block.kind === "liability" ? 0.85 : 1,
          }}
        >
          {showLabel && (
            <div className="flex h-full w-full flex-col justify-between p-1.5 text-[11px] leading-tight text-white">
              <span className="truncate font-medium drop-shadow-sm">
                {block.name}
              </span>
              <span className="truncate tabular-nums opacity-90">
                {formatAccountingMoney(block.currency, block.amount, {
                  compact: true,
                })}
              </span>
            </div>
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent>
        <div className="space-y-0.5">
          <div className="font-medium">{block.name}</div>
          <div className="text-xs text-muted-foreground">
            {block.kind === "liability"
              ? "Liability"
              : block.kind === "option"
                ? "Option"
                : "Asset"}
            {block.subtype ? ` · ${block.subtype}` : ""}
          </div>
          <div className="tabular-nums">
            {formatAccountingMoney(block.currency, block.amount)}
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

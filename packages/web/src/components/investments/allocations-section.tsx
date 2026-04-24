import { useMutation, useQuery } from "@apollo/client/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { graphql, readFragment, type ResultOf } from "@/graphql";
import { cn } from "@/lib/cn";
import { colorForKey } from "@/lib/color-for-key";

import { AllocationBar, type AllocationSegment } from "./allocation-bar";

export const AllocationsSectionInvestmentFragment = graphql(`
  fragment AllocationsSectionInvestment on Investment {
    id
    name
    asset {
      ... on InvestmentStock {
        __typename
        code
      }
    }
    wrappers {
      asset {
        id
        name
        type
        investmentAllocations {
          investments {
            allocation
            investment {
              id
            }
          }
          cash {
            amount
            currency
          }
        }
      }
      position {
        units
        totalValue {
          amount
          currency
        }
      }
    }
  }
`);

/** Query-level fragment so the page prewarm can pull `cashPosition` in the same round-trip as the investments list. */
export const AllocationsSectionCashPositionFragment = graphql(`
  fragment AllocationsSectionCashPosition on Query {
    cashPosition {
      amount
      currency
    }
  }
`);

const AllocationsSectionDocument = graphql(
  `
    query AllocationsSection($first: Int) {
      investments(first: $first) {
        edges {
          node {
            id
            ...AllocationsSectionInvestment
          }
        }
      }
      ...AllocationsSectionCashPosition
    }
  `,
  [
    AllocationsSectionInvestmentFragment,
    AllocationsSectionCashPositionFragment,
  ],
);

const InvestmentAllocationsSetDocument = graphql(`
  mutation InvestmentAllocationsSet(
    $assetId: ID!
    $allocations: [InvestmentAllocationInput!]!
  ) {
    investmentAllocationsSet(assetId: $assetId, allocations: $allocations) {
      investments {
        allocation
        investment {
          id
        }
      }
      cash {
        amount
        currency
      }
    }
  }
`);

const CASH_COLOR = "#64748b";
const WRAPPER_TYPES = new Set(["STOCK", "PENSION"]);
const MIN_ALLOC = 0.01;
const ALLOC_STEP = 0.01;
const EPSILON = 1e-9;

type Investment = ResultOf<typeof AllocationsSectionInvestmentFragment>;

function labelForInvestment(inv: {
  name: string;
  asset: Investment["asset"];
}): string {
  if (inv.asset?.__typename === "InvestmentStock") return inv.asset.code;
  return inv.name;
}

function colorForInvestment(inv: {
  name: string;
  asset: Investment["asset"];
}): string {
  const code =
    inv.asset?.__typename === "InvestmentStock" ? inv.asset.code : null;
  return colorForKey(code ?? inv.name);
}

type WrapperHolding = {
  investmentId: string;
  label: string;
  fullName: string;
  color: string;
  valueMinor: number;
};

type WrapperBucket = {
  assetId: string;
  assetName: string;
  assetType: string;
  holdings: WrapperHolding[];
  /** Saved per-investment allocation targets for this wrapper (investmentId → fraction). */
  savedAllocations: Map<string, number>;
};

function bucketsByWrapper(investments: Investment[]): WrapperBucket[] {
  const map = new Map<string, WrapperBucket>();
  for (const inv of investments) {
    for (const w of inv.wrappers ?? []) {
      if (!WRAPPER_TYPES.has(w.asset.type)) continue;
      if (w.position.units === 0) continue;
      const holding: WrapperHolding = {
        investmentId: inv.id,
        label: labelForInvestment(inv),
        fullName: inv.name,
        color: colorForInvestment(inv),
        valueMinor: w.position.totalValue?.amount ?? 0,
      };
      const existing = map.get(w.asset.id);
      if (existing) {
        existing.holdings.push(holding);
      } else {
        const allocRows = w.asset.investmentAllocations?.investments ?? [];
        const savedAllocations = new Map<string, number>();
        for (const a of allocRows) {
          savedAllocations.set(a.investment.id, a.allocation);
        }
        map.set(w.asset.id, {
          assetId: w.asset.id,
          assetName: w.asset.name,
          assetType: w.asset.type,
          holdings: [holding],
          savedAllocations,
        });
      }
    }
  }
  const out = [...map.values()];
  out.sort((a, b) => a.assetName.localeCompare(b.assetName));
  for (const b of out)
    b.holdings.sort((a, c) => a.label.localeCompare(c.label));
  return out;
}

type PortfolioRow = {
  investmentId: string;
  label: string;
  color: string;
  valueMinor: number;
};

function totalPortfolioByInvestment(investments: Investment[]): PortfolioRow[] {
  return investments
    .map((inv) => ({
      investmentId: inv.id,
      label: labelForInvestment(inv),
      color: colorForInvestment(inv),
      valueMinor: (inv.wrappers ?? []).reduce(
        (acc, w) =>
          acc +
          (w.position.units !== 0 ? (w.position.totalValue?.amount ?? 0) : 0),
        0,
      ),
    }))
    .filter((x) => x.valueMinor > 0)
    .sort((a, b) => a.label.localeCompare(b.label));
}

function seedAllocations(
  bucket: WrapperBucket,
  saved: Map<string, number>,
): Map<string, number> {
  const ids = bucket.holdings.map((h) => h.investmentId);
  const coversAll = ids.every((id) => saved.has(id));
  if (coversAll && saved.size === ids.length) {
    return new Map(ids.map((id) => [id, saved.get(id)!]));
  }
  const total = bucket.holdings.reduce((a, h) => a + h.valueMinor, 0);
  if (total <= 0) {
    const even = 1 / Math.max(1, ids.length);
    return new Map(ids.map((id) => [id, even]));
  }
  return new Map(
    bucket.holdings.map((h) => [h.investmentId, h.valueMinor / total]),
  );
}

export function AllocationsSection({
  filterAssetId,
}: {
  filterAssetId?: string | null;
}) {
  const { data } = useQuery(AllocationsSectionDocument, {
    variables: { first: 1000 },
    fetchPolicy: "cache-first",
  });

  const investments = useMemo<Investment[]>(() => {
    const edges = data?.investments?.edges ?? [];
    return edges.map((e) =>
      readFragment(AllocationsSectionInvestmentFragment, e.node),
    );
  }, [data]);

  const allBuckets = useMemo(
    () => bucketsByWrapper(investments),
    [investments],
  );

  const bucket = filterAssetId
    ? (allBuckets.find((b) => b.assetId === filterAssetId) ?? null)
    : null;

  // ACTUAL segments: when a wrapper is selected, by holding within the wrapper;
  // otherwise by investment across the whole portfolio plus a cash slice.
  const actualSegments = useMemo<AllocationSegment[]>(() => {
    if (bucket) {
      const total = bucket.holdings.reduce((a, h) => a + h.valueMinor, 0);
      if (total <= 0) return [];
      return bucket.holdings.map((h) => ({
        id: h.investmentId,
        label: h.label,
        color: h.color,
        value: h.valueMinor / total,
      }));
    }
    const rows = totalPortfolioByInvestment(investments);
    const cashMajor = data
      ? (readFragment(AllocationsSectionCashPositionFragment, data).cashPosition
          ?.amount ?? 0)
      : 0;
    const total = cashMajor + rows.reduce((a, r) => a + r.valueMinor, 0);
    if (total <= 0) return [];
    return [
      {
        id: "__cash__",
        label: "Cash",
        color: CASH_COLOR,
        value: cashMajor / total,
      },
      ...rows.map((r) => ({
        id: r.investmentId,
        label: r.label,
        color: r.color,
        value: r.valueMinor / total,
      })),
    ];
  }, [bucket, investments, data]);

  // TARGET state — baseline comes from the selected wrapper's saved
  // allocations (or its actual weights if none are saved). Drafting a new
  // set is gated behind a confirm dialog: drag → draft → release → dialog.
  const baseline = useMemo<Map<string, number>>(() => {
    if (!bucket) return new Map();
    return seedAllocations(bucket, bucket.savedAllocations);
  }, [bucket]);

  const [draft, setDraft] = useState<Map<string, number>>(baseline);
  // Reset the draft whenever the baseline identity changes (wrapper switch,
  // server update landing). We use a fingerprint so a new object with
  // identical values doesn't stomp an in-flight drag.
  const fingerprint = useMemo(
    () =>
      [...baseline.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}:${v.toFixed(6)}`)
        .join("|"),
    [baseline],
  );
  const initialisedForRef = useRef<string>("");
  if (initialisedForRef.current !== fingerprint) {
    initialisedForRef.current = fingerprint;
    if (draft !== baseline) queueMicrotask(() => setDraft(baseline));
  }

  const targetSegments: AllocationSegment[] = bucket
    ? bucket.holdings.map((h) => ({
        id: h.investmentId,
        label: h.label,
        color: h.color,
        value: draft.get(h.investmentId) ?? 0,
      }))
    : actualSegments;

  // Drag flow. The snapshot captures the pre-drag map so a sequence of small
  // pointer deltas behaves the same as one big one (the fraction is always
  // relative to where the pointer went down).
  const snapshotRef = useRef<{
    boundary: string;
    map: Map<string, number>;
  } | null>(null);
  const [pendingDraft, setPendingDraft] = useState<Map<string, number> | null>(
    null,
  );
  // Which boundary is currently being dragged, if any — used to light up
  // a bottom-of-screen preview while the user is holding a handle.
  const [dragPreview, setDragPreview] = useState<{
    leftId: string;
    rightId: string;
  } | null>(null);

  const onBoundaryDrag = useCallback(
    (leftId: string, rightId: string) => {
      return (fraction: number, phase: "move" | "end") => {
        const key = `${leftId}|${rightId}`;
        let snap = snapshotRef.current;
        if (!snap || snap.boundary !== key) {
          snap = { boundary: key, map: new Map(draft) };
          snapshotRef.current = snap;
          setDragPreview({ leftId, rightId });
        }
        const startLeft = snap.map.get(leftId) ?? 0;
        const startRight = snap.map.get(rightId) ?? 0;
        const combined = startLeft + startRight;
        const maxLeft = combined - MIN_ALLOC;
        const raw = Math.max(
          MIN_ALLOC,
          Math.min(maxLeft, startLeft + fraction),
        );
        const snapped = Math.round(raw / ALLOC_STEP) * ALLOC_STEP;
        const nextLeft = Math.max(MIN_ALLOC, Math.min(maxLeft, snapped));
        const nextRight = combined - nextLeft;
        const nextMap = new Map(snap.map);
        nextMap.set(leftId, nextLeft);
        nextMap.set(rightId, nextRight);
        setDraft(nextMap);
        if (phase === "end") {
          snapshotRef.current = null;
          setDragPreview(null);
          const changed = [...baseline].some(
            ([id, v]) => Math.abs((nextMap.get(id) ?? 0) - v) > EPSILON,
          );
          if (changed) setPendingDraft(nextMap);
        }
      };
    },
    [draft, baseline],
  );

  const [save, { loading: saving }] = useMutation(
    InvestmentAllocationsSetDocument,
    {
      refetchQueries: [
        { query: AllocationsSectionDocument, variables: { first: 1000 } },
      ],
      onError: (err) => toast.error(err.message),
      onCompleted: () => {
        toast.success("Allocation targets updated");
        setPendingDraft(null);
      },
    },
  );

  const onAccept = () => {
    if (!pendingDraft || !bucket) return;
    const entries = [...pendingDraft.entries()];
    const sum = entries.reduce((a, [, v]) => a + v, 0);
    if (sum <= 0) return;
    const normalised = entries.map(([id, v]) => ({
      investmentId: id,
      allocation: v / sum,
    }));
    void save({
      variables: { assetId: bucket.assetId, allocations: normalised },
    });
  };
  const onReject = () => {
    setDraft(baseline);
    setPendingDraft(null);
  };

  // When the filter switches away from the active wrapper while a draft is
  // pending, drop the draft so it doesn't silently reapply to the wrong
  // bucket.
  useEffect(() => {
    if (!bucket) setPendingDraft(null);
  }, [bucket]);

  const editable = bucket != null;

  return (
    <section
      // Positioned flush with the bottom of the parent `PortfolioSection`
      // card so the bars sit on the card's bottom border.
      className="absolute inset-x-0 bottom-0"
    >
      <AllocationBar
        segments={actualSegments}
        compact
        className="rounded-none"
      />
      <AllocationBar
        segments={targetSegments}
        compact
        className={cn(
          "rounded-none rounded-b-lg",
          // Bump the target bar's touch target when it's editable so the
          // drag handles are actually grabbable. The stacked "actual" bar
          // above stays at its compact default so the two don't fight
          // visually.
          editable ? "h-5" : undefined,
          saving && "pointer-events-none opacity-60",
        )}
        onBoundaryDrag={editable ? onBoundaryDrag : undefined}
      />
      {editable && (
        <DragPreview
          visible={dragPreview != null}
          bucket={bucket}
          draft={draft}
          baseline={baseline}
        />
      )}
      <ConfirmAllocationDialog
        open={pendingDraft != null}
        bucket={bucket}
        baseline={baseline}
        next={pendingDraft}
        saving={saving}
        onAccept={onAccept}
        onReject={onReject}
      />
    </section>
  );
}

/**
 * Floating preview pinned to the bottom of the viewport while the user is
 * dragging an allocation boundary — lists every holding with its current
 * draft percentage so the live rebalance is legible even on mobile, where
 * the bar itself is too thin to read inline.
 */
function DragPreview({
  visible,
  bucket,
  draft,
  baseline,
}: {
  visible: boolean;
  bucket: WrapperBucket | null;
  draft: Map<string, number>;
  baseline: Map<string, number>;
}) {
  if (!bucket) return null;
  return (
    <div
      className={cn(
        "pointer-events-none fixed inset-x-2 bottom-2 z-50 rounded-md border bg-popover/95 p-3 shadow-lg backdrop-blur transition-opacity duration-150 sm:inset-x-auto sm:left-1/2 sm:bottom-4 sm:w-80 sm:-translate-x-1/2",
        visible ? "opacity-100" : "opacity-0",
      )}
      role="status"
      aria-hidden={!visible}
    >
      <div className="mb-1 text-xs font-medium text-muted-foreground">
        {bucket.assetName}
      </div>
      <ul className="grid grid-cols-1 gap-x-4 gap-y-0.5 text-xs sm:grid-cols-2">
        {bucket.holdings.map((h) => {
          const target = draft.get(h.investmentId) ?? 0;
          const saved = baseline.get(h.investmentId) ?? 0;
          const changed = Math.abs(target - saved) > EPSILON;
          return (
            <li
              key={h.investmentId}
              className="flex items-center justify-between gap-2"
            >
              <span className="inline-flex min-w-0 items-center gap-1.5">
                <span
                  className="h-2 w-2 shrink-0 rounded-sm"
                  style={{ backgroundColor: h.color }}
                />
                <span className="truncate font-medium">{h.label}</span>
              </span>
              <span
                className={cn(
                  "tabular-nums",
                  changed
                    ? "font-semibold text-foreground"
                    : "text-muted-foreground",
                )}
              >
                {(target * 100).toFixed(1)}%
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ConfirmAllocationDialog({
  open,
  bucket,
  baseline,
  next,
  saving,
  onAccept,
  onReject,
}: {
  open: boolean;
  bucket: WrapperBucket | null;
  baseline: Map<string, number>;
  next: Map<string, number> | null;
  saving: boolean;
  onAccept: () => void;
  onReject: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onReject()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Update allocation targets?</DialogTitle>
          <DialogDescription>
            {bucket
              ? `Changes to ${bucket.assetName}`
              : "Changes to this portfolio"}
          </DialogDescription>
        </DialogHeader>
        {bucket && next && (
          <ul className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm">
            {bucket.holdings.map((h) => {
              const target = next.get(h.investmentId) ?? 0;
              const saved = baseline.get(h.investmentId) ?? 0;
              const changed = Math.abs(target - saved) > EPSILON;
              return (
                <li
                  key={h.investmentId}
                  className="flex items-center justify-between gap-2"
                >
                  <span className="inline-flex items-center gap-2 truncate">
                    <span
                      className="h-2 w-2 rounded-sm"
                      style={{ backgroundColor: h.color }}
                    />
                    <span className="truncate font-medium">{h.label}</span>
                  </span>
                  <span
                    className={cn("tabular-nums", changed && "font-semibold")}
                  >
                    {(target * 100).toFixed(1)}%
                    {changed && (
                      <span className="ml-1 text-xs text-muted-foreground">
                        (was {(saved * 100).toFixed(1)}%)
                      </span>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onReject} disabled={saving}>
            Discard
          </Button>
          <Button onClick={onAccept} disabled={saving}>
            {saving ? "Saving…" : "Save targets"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

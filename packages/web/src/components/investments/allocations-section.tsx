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

/** Query-level fragment so the page prewarm can pull the BE-computed per-investment allocation fractions in the same round-trip as the investments list. */
export const AllocationsSectionPortfolioFragment = graphql(`
  fragment AllocationsSectionPortfolio on Portfolio {
    id
    allocations {
      fraction
      investment {
        id
        name
        asset {
          ... on InvestmentStock {
            __typename
            code
          }
        }
      }
    }
  }
`);

const AllocationsSectionDocument = graphql(
  `
    query AllocationsSection($first: Int, $filterAssetIdIn: [ID!]) {
      investments(first: $first) {
        edges {
          node {
            id
            ...AllocationsSectionInvestment
          }
        }
      }
      portfolio(filterAssetIdIn: $filterAssetIdIn) {
        ...AllocationsSectionPortfolio
      }
    }
  `,
  [AllocationsSectionInvestmentFragment, AllocationsSectionPortfolioFragment],
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
  filterAssetIds,
}: {
  filterAssetIds: string[];
}) {
  const filterAssetId = filterAssetIds.length === 1 ? filterAssetIds[0]! : null;
  const filterAssetIdIn = filterAssetIds.length > 0 ? filterAssetIds : null;
  const { data } = useQuery(AllocationsSectionDocument, {
    variables: { first: 1000, filterAssetIdIn },
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

  // ACTUAL segments come straight from the BE-computed per-investment fractions
  // for the current filter. The server already excludes cash and renormalises
  // over investments that contribute, so we only translate `Investment` →
  // label / colour for rendering.
  const actualSegments = useMemo<AllocationSegment[]>(() => {
    const portfolio = data?.portfolio
      ? readFragment(AllocationsSectionPortfolioFragment, data.portfolio)
      : null;
    const allocs = portfolio?.allocations ?? [];
    return allocs.map((a) => ({
      id: a.investment.id,
      label: labelForInvestment(a.investment),
      color: colorForInvestment(a.investment),
      value: a.fraction,
    }));
  }, [data]);

  // TARGET state — baseline comes from the selected wrapper's saved
  // allocations (or its actual weights if none are saved). Drag commits
  // directly on pointer-up; no confirmation step.
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

  // Mirror the actual bar's ordering (which the server returns by descending
  // fraction) so the two stacked bars line up segment-for-segment instead of
  // the editable bar reshuffling alphabetically.
  const targetSegments: AllocationSegment[] = bucket
    ? actualSegments.map((s) => ({
        ...s,
        value: draft.get(s.id) ?? 0,
      }))
    : actualSegments;

  // Drag flow. The snapshot captures the pre-drag map so a sequence of small
  // pointer deltas behaves the same as one big one (the fraction is always
  // relative to where the pointer went down). `pointerType` decides between
  // the touch-style flow (preview pinned to the bottom of the viewport,
  // confirm dialog on release) and the desktop flow (preview pinned to the
  // cursor, commit immediately on release).
  const snapshotRef = useRef<{
    boundary: string;
    map: Map<string, number>;
    pointerType: string;
  } | null>(null);
  const [pendingDraft, setPendingDraft] = useState<Map<string, number> | null>(
    null,
  );
  const [dragPreview, setDragPreview] = useState<{
    leftId: string;
    rightId: string;
    clientX: number;
    clientY: number;
    pointerType: string;
  } | null>(null);

  // No `refetchQueries`: the mutation's response carries the updated
  // `InvestmentAllocations` for the wrapper's asset entity, and Apollo
  // normalises it into the same `asset.investmentAllocations` field the
  // page query reads. Refetching the section was both wasteful (it briefly
  // dropped the wrapper's cached payload while in-flight, flashing the
  // editable bar empty) and incorrectly scoped — the call carried no
  // `filterAssetIdIn`, so it refetched a different `Portfolio` from the
  // one currently on screen.
  const [save, { loading: saving }] = useMutation(
    InvestmentAllocationsSetDocument,
    {
      onError: (err) => toast.error(err.message),
      onCompleted: () => {
        toast.success("Allocation targets updated");
        setPendingDraft(null);
      },
    },
  );

  const commit = useCallback(
    (next: Map<string, number>, assetId: string) => {
      const entries = [...next.entries()];
      const sum = entries.reduce((a, [, v]) => a + v, 0);
      if (sum <= 0) return;
      const normalised = entries.map(([id, v]) => ({
        investmentId: id,
        allocation: v / sum,
      }));
      void save({ variables: { assetId, allocations: normalised } });
    },
    [save],
  );

  const onBoundaryDrag = useCallback(
    (leftId: string, rightId: string) => {
      return (
        fraction: number,
        phase: "start" | "move" | "end",
        point: { clientX: number; clientY: number; pointerType: string },
      ) => {
        const isTouch = point.pointerType === "touch";
        if (phase === "start") {
          snapshotRef.current = {
            boundary: `${leftId}|${rightId}`,
            map: new Map(draft),
            pointerType: point.pointerType,
          };
          // Desktop: light up the preview at pointer-down so the user
          // sees percentages immediately. Touch: keep the previous
          // behaviour where the preview only appears once movement
          // begins, so a tap on a handle doesn't pop up a tooltip.
          if (!isTouch) setDragPreview({ leftId, rightId, ...point });
          return;
        }
        const key = `${leftId}|${rightId}`;
        let snap = snapshotRef.current;
        if (!snap || snap.boundary !== key) {
          snap = {
            boundary: key,
            map: new Map(draft),
            pointerType: point.pointerType,
          };
          snapshotRef.current = snap;
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
        if (phase === "move") {
          setDragPreview({ leftId, rightId, ...point });
        }
        if (phase === "end") {
          snapshotRef.current = null;
          setDragPreview(null);
          const changed = [...baseline].some(
            ([id, v]) => Math.abs((nextMap.get(id) ?? 0) - v) > EPSILON,
          );
          if (!changed) return;
          if (isTouch) {
            // Mobile: keep the confirm-dialog gate.
            setPendingDraft(nextMap);
          } else if (bucket) {
            // Desktop: commit immediately.
            commit(nextMap, bucket.assetId);
          }
        }
      };
    },
    [draft, baseline, bucket, commit],
  );

  const onAccept = () => {
    if (!pendingDraft || !bucket) return;
    commit(pendingDraft, bucket.assetId);
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
      {editable && (
        <AllocationBar
          segments={actualSegments}
          compact
          className="rounded-none"
        />
      )}
      <AllocationBar
        segments={targetSegments}
        compact
        showLabels={editable || targetSegments.length > 1}
        className={cn(
          "rounded-none rounded-b-lg",
          // Bump the target bar's touch target when it's editable so the
          // drag handles are actually grabbable, and so the inline
          // stock-code labels (shown when editable or compound) are
          // legible.
          editable && "h-5",
          // When unfilterd-but-compound, this is the only bar rendered
          // (the thin actual bar above is hidden), so size it to match
          // the combined h-2 + h-5 stack used in editable mode.
          !editable && targetSegments.length > 1 && "h-7",
          saving && "pointer-events-none opacity-60",
        )}
        onBoundaryDrag={editable ? onBoundaryDrag : undefined}
      />
      {editable && (
        <DragPreview
          preview={dragPreview}
          bucket={bucket}
          draft={draft}
          baseline={baseline}
          order={actualSegments.map((s) => s.id)}
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
        order={actualSegments.map((s) => s.id)}
      />
    </section>
  );
}

/**
 * Floating preview shown while the user is dragging an allocation boundary
 * — lists every holding with its current draft percentage so the live
 * rebalance is legible. On touch the preview pins to the bottom of the
 * viewport (the bar itself is too thin to read inline on mobile); with a
 * mouse / pen it follows the cursor so it sits next to the dragged
 * handle.
 */
function DragPreview({
  preview,
  bucket,
  draft,
  baseline,
  order,
}: {
  preview: {
    leftId: string;
    rightId: string;
    clientX: number;
    clientY: number;
    pointerType: string;
  } | null;
  bucket: WrapperBucket | null;
  draft: Map<string, number>;
  baseline: Map<string, number>;
  /** investmentIds in the order they appear in the actual-allocation bar above. */
  order: string[];
}) {
  if (!bucket || !preview) return null;
  const byId = new Map(bucket.holdings.map((h) => [h.investmentId, h]));
  const orderedHoldings = [
    ...order
      .map((id) => byId.get(id))
      .filter((h): h is WrapperHolding => h != null),
    // Defensive: any holding not represented in `order` (shouldn't happen
    // in practice, since both sets come from the same wrapper) goes last.
    ...bucket.holdings.filter((h) => !order.includes(h.investmentId)),
  ];
  const isTouch = preview.pointerType === "touch";
  // Cursor mode: position at the pointer with a small offset, but clamp
  // horizontally so the box doesn't overflow the viewport.
  const cursorStyle = isTouch
    ? null
    : (() => {
        const width = 320;
        const margin = 8;
        const offset = 12;
        const maxLeft =
          typeof window !== "undefined"
            ? window.innerWidth - width - margin
            : preview.clientX;
        const left = Math.min(
          maxLeft,
          Math.max(margin, preview.clientX - width / 2),
        );
        // Sit the box's bottom edge just above the cursor — the
        // `-translate-y-full` class on the element shifts it up by its
        // own height so this stays correct regardless of how many
        // holdings the preview lists.
        const top = Math.max(margin, preview.clientY - offset);
        return { left, top, width };
      })();
  return (
    <div
      className={cn(
        "pointer-events-none fixed z-50 rounded-md border bg-popover/95 p-3 shadow-lg backdrop-blur",
        // Cursor mode: the inline `top` is the cursor's clientY minus a
        // small offset; shift the box up by its own height so the
        // bottom edge sits just above the cursor.
        cursorStyle != null && "-translate-y-full",
        // Touch: bottom-pinned on mobile, centred on tablet+.
        cursorStyle == null &&
          "inset-x-2 bottom-2 sm:inset-x-auto sm:left-1/2 sm:bottom-4 sm:w-80 sm:-translate-x-1/2",
      )}
      style={cursorStyle ?? undefined}
      role="status"
    >
      <div className="mb-1 text-xs font-medium text-muted-foreground">
        {bucket.assetName}
      </div>
      <ul className="grid grid-cols-1 gap-x-4 gap-y-0.5 text-xs sm:grid-cols-2">
        {orderedHoldings.map((h) => {
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
  order,
}: {
  open: boolean;
  bucket: WrapperBucket | null;
  baseline: Map<string, number>;
  next: Map<string, number> | null;
  saving: boolean;
  onAccept: () => void;
  onReject: () => void;
  /** investmentIds in the order they appear in the actual-allocation bar above. */
  order: string[];
}) {
  const orderedHoldings = bucket
    ? (() => {
        const byId = new Map(bucket.holdings.map((h) => [h.investmentId, h]));
        return [
          ...order
            .map((id) => byId.get(id))
            .filter((h): h is WrapperHolding => h != null),
          ...bucket.holdings.filter((h) => !order.includes(h.investmentId)),
        ];
      })()
    : [];
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
            {orderedHoldings.map((h) => {
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

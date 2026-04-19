import { useMutation, useQuery } from "@apollo/client/react";
import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { graphql, readFragment, type ResultOf } from "@/graphql";
import { cn } from "@/lib/cn";
import { colorForKey } from "@/lib/color-for-key";
import { formatAccountingMoney } from "@/lib/format";

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
    }
  `,
  [AllocationsSectionInvestmentFragment],
);

const InvestmentAllocationsDocument = graphql(`
  query InvestmentAllocations($assetId: ID!) {
    investmentAllocations(assetId: $assetId) {
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

const InvestmentCashAllocationSetDocument = graphql(`
  mutation InvestmentCashAllocationSet($amount: MoneyInput!) {
    investmentCashAllocationSet(amount: $amount) {
      amount
      currency
    }
  }
`);

const CASH_COLOR = "#64748b";
const WRAPPER_TYPES = new Set(["STOCK", "PENSION"]);
const MIN_ALLOC = 0.001;
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
        map.set(w.asset.id, {
          assetId: w.asset.id,
          assetName: w.asset.name,
          assetType: w.asset.type,
          holdings: [holding],
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
  fullName: string;
  color: string;
  valueMinor: number;
};

function totalPortfolioByInvestment(investments: Investment[]): PortfolioRow[] {
  return investments
    .map((inv) => ({
      investmentId: inv.id,
      label: labelForInvestment(inv),
      fullName: inv.name,
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

function detectPortfolioCurrency(investments: Investment[]): string {
  for (const inv of investments) {
    for (const w of inv.wrappers ?? []) {
      const c = w.position.totalValue?.currency;
      if (c) return c;
    }
  }
  return "GBP";
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
  const buckets = filterAssetId
    ? allBuckets.filter((b) => b.assetId === filterAssetId)
    : allBuckets;
  const portfolioRows = useMemo(() => {
    if (!filterAssetId) return totalPortfolioByInvestment(investments);
    const bucket = allBuckets.find((b) => b.assetId === filterAssetId);
    if (!bucket) return [];
    return bucket.holdings.map((h) => ({
      investmentId: h.investmentId,
      label: h.label,
      fullName: h.fullName,
      color: h.color,
      valueMinor: h.valueMinor,
    }));
  }, [filterAssetId, investments, allBuckets]);
  const portfolioCurrency = useMemo(
    () => detectPortfolioCurrency(investments),
    [investments],
  );
  const seedAssetId = buckets[0]?.assetId ?? null;

  // Cash is a portfolio-wide singleton — any wrapper's allocations query
  // carries the same value. Query through `seedAssetId` to read it.
  const { data: cashQueryData } = useQuery(InvestmentAllocationsDocument, {
    variables: { assetId: seedAssetId ?? "" },
    skip: !seedAssetId,
    fetchPolicy: "cache-and-network",
  });
  const savedCash = cashQueryData?.investmentAllocations?.cash ?? null;
  const savedCashMajor = savedCash?.amount ?? 0;
  const cashCurrency = savedCash?.currency ?? portfolioCurrency;

  const [pendingCashMajor, setPendingCashMajor] = useState<number | null>(null);
  const cashSnapshotRef = useRef<number | null>(null);
  const [saveCash, { loading: savingCash }] = useMutation(
    InvestmentCashAllocationSetDocument,
    {
      refetchQueries: seedAssetId
        ? [
            {
              query: InvestmentAllocationsDocument,
              variables: { assetId: seedAssetId },
            },
          ]
        : [],
      onError: (err) => toast.error(err.message),
      onCompleted: () => {
        toast.success("Cash target updated");
        setPendingCashMajor(null);
      },
    },
  );

  const investValueMajor = portfolioRows.reduce((a, r) => a + r.valueMinor, 0);
  const currentCashMajor = pendingCashMajor ?? savedCashMajor;
  const denom = currentCashMajor + investValueMajor;
  const cashShare = denom > 0 ? currentCashMajor / denom : 0;

  const overallSegments: AllocationSegment[] = filterAssetId
    ? portfolioRows.map((r) => ({
        id: r.investmentId,
        label: r.label,
        color: r.color,
        value: investValueMajor > 0 ? r.valueMinor / investValueMajor : 0,
      }))
    : [
        {
          id: "__cash__",
          label: "Cash",
          color: CASH_COLOR,
          value: denom > 0 ? currentCashMajor / denom : 0,
        },
        ...portfolioRows.map((r) => ({
          id: r.investmentId,
          label: r.label,
          color: r.color,
          value: denom > 0 ? r.valueMinor / denom : 0,
        })),
      ];

  // Hover-expand state — stays open while a drag is in flight so the
  // overlay doesn't collapse mid-rebalance. Each child editor flips
  // `dragCount` via `onDragStateChange` so multiple boundaries being
  // dragged in succession don't prematurely close the UI.
  const [pointerInside, setPointerInside] = useState(false);
  const [dragCount, setDragCount] = useState(0);
  const expanded = pointerInside || dragCount > 0;
  const setDragActive = useCallback((active: boolean) => {
    setDragCount((n) => Math.max(0, n + (active ? 1 : -1)));
  }, []);

  const onCashBoundaryDrag = useCallback(
    (leftId: string, _rightId: string) => {
      if (leftId !== "__cash__") return null;
      return (fraction: number, phase: "move" | "end") => {
        if (cashSnapshotRef.current === null) {
          cashSnapshotRef.current = savedCashMajor;
          setDragActive(true);
        }
        const baseCash = cashSnapshotRef.current;
        // Bar total at pointerdown is `baseCash + investValue`; the handle's
        // drag fraction maps proportionally into change-in-cash.
        const baseTotal = baseCash + investValueMajor;
        const raw = Math.max(0, baseCash + fraction * baseTotal);
        const nextCash = Math.round(raw / 1000) * 1000;
        setPendingCashMajor(nextCash);
        if (phase === "end") {
          cashSnapshotRef.current = null;
          setDragActive(false);
          if (Math.abs(nextCash - savedCashMajor) > EPSILON) {
            void saveCash({
              variables: {
                amount: { amount: nextCash, currency: cashCurrency },
              },
            });
          } else {
            setPendingCashMajor(null);
          }
        }
      };
    },
    [savedCashMajor, investValueMajor, saveCash, cashCurrency, setDragActive],
  );

  return (
    <section
      // Positioned flush with the bottom of the parent `PortfolioSection`
      // card so the thin bar's bottom edge sits on the card's bottom border.
      // Parent must be `relative`; the bar spans full width ignoring the
      // card's `p-4` padding.
      className="absolute inset-x-0 bottom-0"
      onPointerEnter={() => setPointerInside(true)}
      onPointerLeave={() => setPointerInside(false)}
    >
      <AllocationBar
        segments={overallSegments}
        compact
        className="rounded-none rounded-b-lg"
      />

      <div
        className={cn(
          "absolute inset-x-0 top-0 z-20 grid transition-[grid-template-rows,opacity] duration-200 ease-out",
          expanded
            ? "grid-rows-[1fr] opacity-100"
            : "pointer-events-none grid-rows-[0fr] opacity-0",
        )}
        aria-hidden={!expanded}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="space-y-6 rounded-b-md rounded-t-sm border bg-background p-4 shadow-lg">
            <div className="flex items-baseline justify-between">
              <h2 className="text-lg font-semibold tracking-tight">
                Allocation targets
              </h2>
              <span className="text-xs text-muted-foreground">
                Drag handles to rebalance
              </span>
            </div>

            {filterAssetId ? null : (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-medium">Overall portfolio</h3>
                  <span className="text-xs text-muted-foreground">
                    Cash target:{" "}
                    {formatAccountingMoney(cashCurrency, currentCashMajor, {
                      compact: true,
                    })}{" "}
                    ({(cashShare * 100).toFixed(1)}%)
                    {savingCash ? " · saving…" : ""}
                  </span>
                </div>
                <AllocationBar
                  segments={overallSegments}
                  onBoundaryDrag={seedAssetId ? onCashBoundaryDrag : undefined}
                />
                <p className="text-[11px] text-muted-foreground">
                  Drag the cash boundary to set the portfolio-wide cash target.
                  Investment slices reflect current realised weights.
                </p>
              </div>
            )}

            {buckets.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No wrappers with holdings yet.
              </p>
            ) : (
              <div className="space-y-6">
                {buckets.map((b) => (
                  <WrapperEditor
                    key={b.assetId}
                    bucket={b}
                    onDragStateChange={setDragActive}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function WrapperEditor({
  bucket,
  onDragStateChange,
}: {
  bucket: WrapperBucket;
  onDragStateChange: (active: boolean) => void;
}) {
  const { data } = useQuery(InvestmentAllocationsDocument, {
    variables: { assetId: bucket.assetId },
    fetchPolicy: "cache-and-network",
  });

  const savedByInvestment = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of data?.investmentAllocations?.investments ?? []) {
      map.set(a.investment.id, a.allocation);
    }
    return map;
  }, [data]);

  const baseline = useMemo(
    () => seedAllocations(bucket, savedByInvestment),
    [bucket, savedByInvestment],
  );

  const [draft, setDraft] = useState<Map<string, number>>(baseline);
  const initialisedForRef = useRef<string>("");

  const fingerprint = useMemo(
    () =>
      [...baseline.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}:${v.toFixed(6)}`)
        .join("|"),
    [baseline],
  );

  if (initialisedForRef.current !== fingerprint) {
    initialisedForRef.current = fingerprint;
    if (draft !== baseline) queueMicrotask(() => setDraft(baseline));
  }

  const snapshotRef = useRef<{
    boundary: string;
    map: Map<string, number>;
  } | null>(null);

  const [save, { loading: saving }] = useMutation(
    InvestmentAllocationsSetDocument,
    {
      onError: (err) => toast.error(err.message),
      onCompleted: () => toast.success(`${bucket.assetName} allocations saved`),
    },
  );

  const segments: AllocationSegment[] = bucket.holdings.map((h) => ({
    id: h.investmentId,
    label: h.label,
    color: h.color,
    value: draft.get(h.investmentId) ?? 0,
  }));

  const commit = useCallback(
    (next: Map<string, number>) => {
      const entries = [...next.entries()];
      const sum = entries.reduce((a, [, v]) => a + v, 0);
      if (sum <= 0) return;
      const normalised = entries.map(([id, v]) => ({
        investmentId: id,
        allocation: v / sum,
      }));
      void save({
        variables: { assetId: bucket.assetId, allocations: normalised },
      });
    },
    [bucket.assetId, save],
  );

  const onBoundaryDrag = useCallback(
    (leftId: string, rightId: string) => {
      return (fraction: number, phase: "move" | "end") => {
        const key = `${leftId}|${rightId}`;
        let snap = snapshotRef.current;
        if (!snap || snap.boundary !== key) {
          if (!snap) onDragStateChange(true);
          snap = { boundary: key, map: new Map(draft) };
          snapshotRef.current = snap;
        }
        const startLeft = snap.map.get(leftId) ?? 0;
        const startRight = snap.map.get(rightId) ?? 0;
        const combined = startLeft + startRight;
        const maxLeft = combined - MIN_ALLOC;
        const nextLeft = Math.max(
          MIN_ALLOC,
          Math.min(maxLeft, startLeft + fraction),
        );
        const nextRight = combined - nextLeft;
        const nextMap = new Map(snap.map);
        nextMap.set(leftId, nextLeft);
        nextMap.set(rightId, nextRight);
        setDraft(nextMap);
        if (phase === "end") {
          snapshotRef.current = null;
          onDragStateChange(false);
          const changed = [...baseline].some(
            ([id, v]) => Math.abs((nextMap.get(id) ?? 0) - v) > EPSILON,
          );
          if (changed) commit(nextMap);
        }
      };
    },
    [draft, baseline, commit, onDragStateChange],
  );

  return (
    <div className={cn("space-y-2", saving && "opacity-70")}>
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium">{bucket.assetName}</h3>
          <p className="text-[11px] text-muted-foreground">
            {bucket.assetType} · {bucket.holdings.length} holding
            {bucket.holdings.length === 1 ? "" : "s"}
            {saving ? " · saving…" : ""}
          </p>
        </div>
      </div>
      <AllocationBar segments={segments} onBoundaryDrag={onBoundaryDrag} />
      <AllocationTable bucket={bucket} draft={draft} baseline={baseline} />
    </div>
  );
}

function AllocationTable({
  bucket,
  draft,
  baseline,
}: {
  bucket: WrapperBucket;
  draft: Map<string, number>;
  baseline: Map<string, number>;
}) {
  return (
    <ul className="grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
      {bucket.holdings.map((h) => {
        const target = draft.get(h.investmentId) ?? 0;
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
              <span className="truncate">
                <span className="font-medium">{h.label}</span>
                {h.label !== h.fullName ? (
                  <span className="ml-1 text-muted-foreground">
                    {h.fullName}
                  </span>
                ) : null}
              </span>
            </span>
            <span className={cn("tabular-nums", changed && "font-medium")}>
              {(target * 100).toFixed(1)}%
              {changed ? (
                <span className="ml-1 text-muted-foreground">
                  (was {(saved * 100).toFixed(1)}%)
                </span>
              ) : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
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

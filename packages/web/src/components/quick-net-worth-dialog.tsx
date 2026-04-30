import type { ApolloClient } from "@apollo/client";
import {
  useApolloClient,
  useMutation,
  useSuspenseQuery,
} from "@apollo/client/react";
import { Link } from "@tanstack/react-router";
import { isSameMonth } from "date-fns/isSameMonth";
import { parseISO } from "date-fns/parseISO";
import { ArrowLeft, ArrowRight, Check, Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  decodeWizardState,
  encodeWizardState,
  type WizardState,
} from "@/lib/wizard-url-state";

import { graphql, readFragment, type ResultOf } from "../graphql";
import { entriesRefetch } from "../routes/net-worth/entries";
import { fetchOpenExchangeRates } from "./net-worth/entry-form";

const QuickNetWorthEntryDocument = graphql(`
  fragment QuickNetWorthEntry on NetWorthEntry {
    id
    date
    currencyRates {
      base
      currency
      rate
    }
    values {
      id
      amounts {
        amount
        currency
      }
      asset {
        id
        name
        assetType: type
      }
      liability {
        id
        name
        liabilityType: type
      }
      option {
        id
        name
      }
    }
  }
`);

const QuickNetWorthLatestDocument = graphql(
  `
    query QuickNetWorthLatest {
      netWorth(last: 1) {
        edges {
          node {
            id
            ...QuickNetWorthEntry
          }
        }
      }
    }
  `,
  [QuickNetWorthEntryDocument],
);

const QuickNetWorthCreateDocument = graphql(`
  mutation QuickNetWorthCreate(
    $date: Date!
    $values: [NetWorthValueInput!]!
    $currencyRates: [NetWorthCurrencyRateInput!]
  ) {
    netWorthCreate(
      date: $date
      values: $values
      currencyRates: $currencyRates
    ) {
      id
    }
  }
`);

const QuickNetWorthUpdateDocument = graphql(
  `
    mutation QuickNetWorthUpdate(
      $id: ID!
      $date: Date
      $values: [NetWorthValueInput!]
      $currencyRates: [NetWorthCurrencyRateInput!]
    ) {
      netWorthUpdate(
        id: $id
        date: $date
        values: $values
        currencyRates: $currencyRates
      ) {
        id
        ...QuickNetWorthEntry
      }
    }
  `,
  [QuickNetWorthEntryDocument],
);

type EntryFromFragment = ResultOf<typeof QuickNetWorthEntryDocument>;

const KIND_ORDER = { asset: 0, liability: 1, option: 2 } as const;

const ASSET_SUBTYPE_LABELS = {
  CASH: "Cash",
  STOCK: "Stocks",
  OPTION: "Options",
  PENSION: "Pensions",
  PROPERTY: "Property",
  VEHICLE: "Vehicles",
  MISC: "Other",
} as const;
const ASSET_SUBTYPE_ORDER = Object.keys(
  ASSET_SUBTYPE_LABELS,
) as (keyof typeof ASSET_SUBTYPE_LABELS)[];

const LIABILITY_SUBTYPE_LABELS = {
  CREDIT_CARD: "Credit cards",
  LOAN: "Loans",
  MISC: "Other",
} as const;
const LIABILITY_SUBTYPE_ORDER = Object.keys(
  LIABILITY_SUBTYPE_LABELS,
) as (keyof typeof LIABILITY_SUBTYPE_LABELS)[];

type WizardRow = {
  /** "asset" | "liability" | "option" — drives which mutation-input variant we emit. */
  kind: "asset" | "liability" | "option";
  categoryId: string;
  /** `NetWorthValue.id` from the snapshot. Sent on update so the backend upserts the row instead of replacing it. */
  valueId: string;
  name: string;
  /** Display label for the subtype (e.g. "Cash", "Credit cards"). `null` for options, which have no subtype. */
  subtypeLabel: string | null;
  /** Sort key within the kind's subtype order — lower comes first. `Infinity` for unknown subtypes (sorts last). */
  subtypeRank: number;
  /** Amounts on the snapshot row, in their original order. The wizard collects one new number per slot. */
  currencies: { currency: string; previous: number }[];
};

function buildRows(entry: EntryFromFragment): WizardRow[] {
  const rows: WizardRow[] = entry.values.map((v) => {
    const kind: WizardRow["kind"] = v.asset
      ? "asset"
      : v.liability
        ? "liability"
        : "option";
    const category = v.asset ?? v.liability ?? v.option;
    let subtypeLabel: string | null = null;
    let subtypeRank = Infinity;
    if (v.asset) {
      const t = v.asset.assetType;
      subtypeLabel = ASSET_SUBTYPE_LABELS[t] ?? t;
      const idx = ASSET_SUBTYPE_ORDER.indexOf(t);
      if (idx !== -1) subtypeRank = idx;
    } else if (v.liability) {
      const t = v.liability.liabilityType;
      subtypeLabel = LIABILITY_SUBTYPE_LABELS[t] ?? t;
      const idx = LIABILITY_SUBTYPE_ORDER.indexOf(t);
      if (idx !== -1) subtypeRank = idx;
    }
    return {
      kind,
      categoryId: category?.id ?? "",
      valueId: v.id,
      name: category?.name ?? "(unknown)",
      subtypeLabel,
      subtypeRank,
      currencies: v.amounts.map((a) => ({
        currency: a.currency,
        previous: a.amount,
      })),
    };
  });
  rows.sort((a, b) => {
    const k = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    if (k !== 0) return k;
    if (a.subtypeRank !== b.subtypeRank) return a.subtypeRank - b.subtypeRank;
    return a.name.localeCompare(b.name);
  });
  return rows;
}

/** Fetch fresh FX rates for every foreign currency on the entry. The wizard
 * reuses the snapshot's rates as a fallback so a transient API failure (e.g.
 * server `OPENEXCHANGERATES_APP_ID` missing, network error) doesn't block the
 * save — the user gets toast-warned and the entry persists with stale rates. */
async function refreshRates(
  client: ApolloClient,
  rates: { base: string; currency: string; rate: number }[],
): Promise<{ base: string; currency: string; rate: number }[]> {
  if (rates.length === 0) return [];
  const codes = rates.map((r) => r.currency);
  try {
    const fresh = await fetchOpenExchangeRates(client, codes);
    return rates.map((r) => {
      const v = fresh.rates[r.currency];
      return {
        base: r.base,
        currency: r.currency,
        rate: v ?? r.rate,
      };
    });
  } catch (err) {
    toast.warning(
      `Couldn't refresh FX rates — saving with stale rates. ${
        err instanceof Error ? err.message : String(err)
      }`,
      { position: "top-right" },
    );
    return rates.map((r) => ({
      base: r.base,
      currency: r.currency,
      rate: r.rate,
    }));
  }
}

function defaultState(entryId: string, rows: WizardRow[]): WizardState {
  return {
    s: entryId,
    i: 0,
    v: rows.map((r) => r.currencies.map(() => null)),
  };
}

function shapeMatches(state: WizardState, rows: WizardRow[]): boolean {
  if (state.v.length !== rows.length) return false;
  for (let i = 0; i < rows.length; i++) {
    if (state.v[i].length !== rows[i].currencies.length) return false;
  }
  return true;
}

export function QuickNetWorthDialog({
  encodedState,
  onUpdateState,
  onClose,
}: {
  /** Compressed wizard state from the URL hash. `undefined` on first open. */
  encodedState: string | undefined;
  /** Persist a new encoded state. The owner writes it to the URL hash so refresh resumes the wizard. */
  onUpdateState: (encoded: string) => void;
  /** Close the wizard. The owner clears the hash and (typically) sends the user back via `history.back`. */
  onClose: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Quick net-worth update</DialogTitle>
        </DialogHeader>
        <Inner
          encodedState={encodedState}
          onUpdateState={onUpdateState}
          onClose={onClose}
        />
      </DialogContent>
    </Dialog>
  );
}

function Inner({
  encodedState,
  onUpdateState,
  onClose,
}: {
  encodedState: string | undefined;
  onUpdateState: (encoded: string) => void;
  onClose: () => void;
}) {
  const { data } = useSuspenseQuery(QuickNetWorthLatestDocument);
  const latestEdge = data.netWorth?.edges[0];
  const sourceEntry = latestEdge
    ? readFragment(QuickNetWorthEntryDocument, latestEdge.node)
    : null;

  if (!sourceEntry) return <NoSnapshot />;

  return (
    <WizardWithSnapshot
      key={sourceEntry.id}
      entry={sourceEntry}
      encodedState={encodedState}
      onUpdateState={onUpdateState}
      onClose={onClose}
    />
  );
}

function WizardWithSnapshot({
  entry,
  encodedState,
  onUpdateState,
  onClose,
}: {
  entry: EntryFromFragment;
  encodedState: string | undefined;
  onUpdateState: (encoded: string) => void;
  onClose: () => void;
}) {
  const rows = useMemo(() => buildRows(entry), [entry]);

  const decoded = encodedState ? decodeWizardState(encodedState) : null;
  const stale =
    decoded != null && (decoded.s !== entry.id || !shapeMatches(decoded, rows));

  const state: WizardState =
    decoded && !stale ? decoded : defaultState(entry.id, rows);

  // The backend enforces one entry per calendar month. If the latest entry
  // is already in the current month, the wizard updates that entry in place
  // (upserting each row by its `valueId`) instead of creating a new one.
  const editingExisting = isSameMonth(parseISO(entry.date), new Date());

  const [create, { loading: creating }] = useMutation(
    QuickNetWorthCreateDocument,
    {
      refetchQueries: entriesRefetch,
      onCompleted: () => {
        toast.success("Entry added");
        onClose();
      },
    },
  );
  const [update, { loading: updating }] = useMutation(
    QuickNetWorthUpdateDocument,
    {
      refetchQueries: entriesRefetch,
      onCompleted: () => {
        toast.success("Entry updated");
        onClose();
      },
    },
  );
  const [refreshingRates, setRefreshingRates] = useState(false);
  const apollo = useApolloClient();
  const saving = creating || updating || refreshingRates;

  const stepCount = rows.length;
  const stepIndex = Math.min(Math.max(state.i, 0), Math.max(stepCount - 1, 0));

  const persist = (next: WizardState) => onUpdateState(encodeWizardState(next));

  const writeSlot = (slot: (number | null)[]): WizardState => {
    const v = state.v.map((arr) => arr.slice());
    v[stepIndex] = slot;
    return { ...state, v };
  };

  const handleAction = async (
    action: "back" | "next" | "skip" | "save",
    values: (number | null)[],
  ) => {
    const slot =
      action === "skip" ? rows[stepIndex].currencies.map(() => null) : values;
    const updated = writeSlot(slot);
    if (action === "save") {
      await submit(updated);
      return;
    }
    const i =
      action === "back"
        ? Math.max(stepIndex - 1, 0)
        : Math.min(stepIndex + 1, stepCount - 1);
    persist({ ...updated, i });
  };

  const submit = async (finalState: WizardState) => {
    const values = rows.map((r, i) => {
      const slot = finalState.v[i] ?? r.currencies.map(() => null);
      const amounts = r.currencies.map((c, j) => ({
        amount: slot[j] ?? c.previous,
        currency: c.currency,
      }));
      const body = {
        ...(editingExisting && { id: r.valueId }),
        categoryId: r.categoryId,
        amounts,
      };
      if (r.kind === "asset") return { asset: body };
      if (r.kind === "liability") return { liability: body };
      return { option: body };
    });
    setRefreshingRates(true);
    let currencyRates;
    try {
      currencyRates = await refreshRates(apollo, entry.currencyRates);
    } finally {
      setRefreshingRates(false);
    }
    const date = new Date().toISOString().slice(0, 10);
    if (editingExisting) {
      await update({
        variables: { id: entry.id, date, values, currencyRates },
      }).catch((err: Error) => toast.error(err.message));
    } else {
      await create({
        variables: { date, values, currencyRates },
      }).catch((err: Error) => toast.error(err.message));
    }
  };

  if (stepCount === 0) return <EmptySnapshot />;

  const row = rows[stepIndex];
  const initialSlot = state.v[stepIndex] ?? row.currencies.map(() => null);

  return (
    <div className="space-y-4">
      {stale && (
        <StaleBanner
          onStartOver={() => persist(defaultState(entry.id, rows))}
        />
      )}
      <div>
        <p className="text-xs text-muted-foreground">
          Step {stepIndex + 1} of {stepCount}
        </p>
        <Progress current={stepIndex + 1} total={stepCount} />
      </div>
      <StepEditor
        key={stepIndex}
        row={row}
        initial={initialSlot}
        isFirst={stepIndex === 0}
        isLast={stepIndex >= stepCount - 1}
        saving={saving}
        saveLabel={editingExisting ? "Update entry" : "Save entry"}
        onAction={handleAction}
      />
    </div>
  );
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function StepEditor({
  row,
  initial,
  isFirst,
  isLast,
  saving,
  saveLabel,
  onAction,
}: {
  row: WizardRow;
  initial: (number | null)[];
  isFirst: boolean;
  isLast: boolean;
  saving: boolean;
  saveLabel: string;
  onAction: (
    action: "back" | "next" | "skip" | "save",
    values: (number | null)[],
  ) => void | Promise<void>;
}) {
  const [draft, setDraft] = useState<string[]>(() =>
    initial.map((cell) => (cell == null ? "" : String(cell))),
  );

  const parsed = (): (number | null)[] =>
    draft.map((s) => {
      if (s.trim() === "") return null;
      const n = Number.parseFloat(s);
      return Number.isFinite(n) ? n : null;
    });

  return (
    <>
      <div className="space-y-1">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">
          {row.subtypeLabel
            ? `${capitalise(row.kind)} · ${row.subtypeLabel}`
            : capitalise(row.kind)}
        </p>
        <h2 className="text-lg font-semibold">{row.name}</h2>
      </div>

      <div className="space-y-2">
        {row.currencies.map((c, j) => (
          <div key={j} className="flex items-center gap-2">
            <span className="w-12 font-mono text-sm">{c.currency}</span>
            <Input
              type="number"
              step="0.01"
              inputMode="decimal"
              placeholder={String(c.previous)}
              value={draft[j] ?? ""}
              onChange={(e) => {
                const next = draft.slice();
                next[j] = e.target.value;
                setDraft(next);
              }}
              className="flex-1"
            />
          </div>
        ))}
        <p className="text-xs text-muted-foreground">
          Leave a value blank to keep the previous amount.
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
        <Button
          type="button"
          variant="ghost"
          onClick={() => void onAction("back", parsed())}
          disabled={isFirst || saving}
        >
          <ArrowLeft /> Back
        </Button>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => void onAction("skip", parsed())}
            disabled={saving}
          >
            Skip
          </Button>
          {isLast ? (
            <Button
              type="button"
              onClick={() => void onAction("save", parsed())}
              disabled={saving}
            >
              {saving ? <Loader2 className="animate-spin" /> : <Check />}{" "}
              {saveLabel}
            </Button>
          ) : (
            <Button
              type="button"
              onClick={() => void onAction("next", parsed())}
              disabled={saving}
            >
              Next <ArrowRight />
            </Button>
          )}
        </div>
      </div>
    </>
  );
}

function Progress({ current, total }: { current: number; total: number }) {
  const pct = total === 0 ? 0 : Math.round((current / total) * 100);
  return (
    <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-muted">
      <div
        className="h-full bg-primary transition-all"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function StaleBanner({ onStartOver }: { onStartOver: () => void }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
      <div className="flex-1">
        <p className="font-medium">The latest entry has changed.</p>
        <p className="text-muted-foreground">
          Saved progress no longer matches the current rows. Start over to
          continue.
        </p>
      </div>
      <Button type="button" variant="outline" size="sm" onClick={onStartOver}>
        Start over
      </Button>
    </div>
  );
}

function NoSnapshot() {
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        The quick wizard clones your last net-worth entry. There isn't one yet —
        add the first entry from the full form.
      </p>
      <Button asChild>
        <Link to="/net-worth/entries/new">Open full form</Link>
      </Button>
    </div>
  );
}

function EmptySnapshot() {
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        The latest entry has no rows to update. Add assets or liabilities from
        the full form first.
      </p>
      <Button asChild>
        <Link to="/net-worth/entries/new">Open full form</Link>
      </Button>
    </div>
  );
}

import {
  useApolloClient,
  useMutation,
  useSuspenseQuery,
} from "@apollo/client/react";
import { createFileRoute, Outlet, useNavigate } from "@tanstack/react-router";
import { Loader2, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { DeleteButton } from "@/components/delete-button";
import { Figure, FigureDocument } from "@/components/figure";
import {
  LatestNetWorthEntryDocument,
  NetWorthEntryByIdDocument,
} from "@/components/net-worth/entry-form";

import {
  type FragmentOf,
  graphql,
  readFragment,
  type ResultOf,
} from "../../graphql";

const NetWorthEntryRowDocument = graphql(
  `
    fragment NetWorthEntryRow on NetWorthEntry {
      id
      date
      totalNet {
        ...Figure
      }
      values {
        id
      }
    }
  `,
  [FigureDocument],
);

export const NetWorthEntriesDocument = graphql(
  `
    query NetWorthEntries {
      netWorth(last: 11) {
        edges {
          node {
            id
            ...NetWorthEntryRow
          }
        }
      }
    }
  `,
  [NetWorthEntryRowDocument],
);

const NetWorthDeleteDocument = graphql(`
  mutation NetWorthDelete($id: ID!) {
    netWorthDelete(id: $id) {
      _
    }
  }
`);

type EntryRowNode = NonNullable<
  ResultOf<typeof NetWorthEntriesDocument>["netWorth"]
>["edges"][number]["node"];

export const Route = createFileRoute("/net-worth/entries")({
  component: NetWorthEntriesPage,
});

/** Refetch target shared with the child edit/new dialogs after they mutate. */
export const entriesRefetch = [{ query: NetWorthEntriesDocument }];

function NetWorthEntriesPage() {
  const navigate = useNavigate();
  const client = useApolloClient();
  const { data } = useSuspenseQuery(NetWorthEntriesDocument);
  const entries: EntryRowNode[] = data.netWorth?.edges.map((e) => e.node) ?? [];

  /** `null` when no tile is loading, otherwise the id (or `"new"`) of the tile whose dialog we're preloading. */
  const [pending, setPending] = useState<string | "new" | null>(null);

  const openEdit = async (id: string) => {
    if (pending) return;
    setPending(id);
    try {
      await client.query({
        query: NetWorthEntryByIdDocument,
        variables: { id },
      });
      await navigate({ to: "/net-worth/entries/$id/edit", params: { id } });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  };

  const openNew = async () => {
    if (pending) return;
    setPending("new");
    try {
      // Warm the "latest entry" query so the new-dialog renders with prefilled
      // defaults immediately.
      await client.query({ query: LatestNetWorthEntryDocument });
      await navigate({ to: "/net-worth/entries/new" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  };

  return (
    <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3">
        {entries.map((e) => (
          <EntryTile
            key={e.id}
            id={e.id}
            data={e}
            pending={pending === e.id}
            disabled={pending !== null && pending !== e.id}
            onOpen={() => openEdit(e.id)}
          />
        ))}
        <AddEntryTile
          pending={pending === "new"}
          disabled={pending !== null && pending !== "new"}
          onClick={openNew}
        />
      </div>
      <Outlet />
    </>
  );
}

function AddEntryTile({
  pending,
  disabled,
  onClick,
}: {
  pending: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || pending}
      className="flex min-h-32 cursor-pointer flex-col items-center justify-center gap-2 rounded-md border border-dashed bg-background p-4 text-muted-foreground transition-colors hover:border-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? (
        <Loader2 className="h-5 w-5 animate-spin" />
      ) : (
        <Plus className="h-5 w-5" />
      )}
      <span className="text-sm font-medium">Add entry</span>
    </button>
  );
}

function EntryTile({
  id,
  data,
  pending,
  disabled,
  onOpen,
}: {
  id: string;
  data: FragmentOf<typeof NetWorthEntryRowDocument>;
  pending: boolean;
  disabled: boolean;
  onOpen: () => void;
}) {
  const entry = readFragment(NetWorthEntryRowDocument, data);
  const [remove] = useMutation(NetWorthDeleteDocument, {
    refetchQueries: entriesRefetch,
    onCompleted: () => toast.success("Entry deleted"),
  });

  const inactive = disabled || pending;

  return (
    <div
      role="button"
      aria-disabled={inactive}
      tabIndex={inactive ? -1 : 0}
      onClick={() => {
        if (!inactive) onOpen();
      }}
      onKeyDown={(e) => {
        if (inactive) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className={
        "flex min-h-32 flex-col gap-2 rounded-md border bg-card p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" +
        (inactive
          ? " cursor-not-allowed opacity-60"
          : " cursor-pointer hover:border-foreground/40")
      }
    >
      <div className="flex items-center gap-2">
        <span className="font-medium">{formatDate(entry.date)}</span>
        {pending && (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        )}
        <span
          className="ml-auto"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          role="presentation"
        >
          <DeleteButton
            onConfirm={() =>
              remove({ variables: { id } }).catch((err: Error) =>
                toast.error(err.message),
              )
            }
          />
        </span>
      </div>
      <Figure
        data={entry.totalNet}
        className="text-2xl font-semibold tabular-nums"
      />
      <div className="text-xs text-muted-foreground">
        {entry.values.length} line{entry.values.length === 1 ? "" : "s"}
      </div>
    </div>
  );
}

function formatDate(d: string): string {
  return new Date(d).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
  });
}

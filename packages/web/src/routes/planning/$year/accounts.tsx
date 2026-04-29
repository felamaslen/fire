import { useMutation, useSuspenseQuery } from "@apollo/client/react";
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { GripVertical } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { DeleteButton } from "@/components/delete-button";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";

import { graphql, type ResultOf } from "../../../graphql";
import { PlanningYearViewDocument } from "../$year";

const PlanningAccountsDialogDocument = graphql(`
  query PlanningAccountsDialog($year: ID!) {
    planningYear(id: $year) {
      id
      accounts {
        id
        name
        target {
          amount
          currency
        }
        asset {
          id
          name
        }
      }
    }
    netWorthCategories(first: 100) {
      edges {
        node {
          __typename
          ... on NetWorthCategoryAsset {
            id
            name
            type
          }
        }
      }
    }
    currencyDefault
  }
`);

const PlanningAccountAssignDocument = graphql(`
  mutation PlanningAccountAssign(
    $assetId: ID!
    $alias: String
    $target: MoneyInput
  ) {
    planningAccountAssign(assetId: $assetId, alias: $alias, target: $target) {
      id
    }
  }
`);

const PlanningAccountUnassignDocument = graphql(`
  mutation PlanningAccountUnassign($assetId: ID!) {
    planningAccountUnassign(assetId: $assetId) {
      _
    }
  }
`);

const PlanningAccountReorderDocument = graphql(`
  mutation PlanningAccountReorder($id: ID!, $position: Int!) {
    planningAccountReorder(id: $id, position: $position) {
      id
    }
  }
`);

export const Route = createFileRoute("/planning/$year/accounts")({
  component: PlanningAccountsDialog,
});

type PlanningAccountsData = ResultOf<typeof PlanningAccountsDialogDocument>;
type Account = NonNullable<
  PlanningAccountsData["planningYear"]
>["accounts"][number];
type RefetchEntry =
  | {
      query: typeof PlanningAccountsDialogDocument;
      variables: { year: string };
    }
  | { query: typeof PlanningYearViewDocument; variables: { id: string } };

type AssetOption = Extract<
  NonNullable<
    PlanningAccountsData["netWorthCategories"]
  >["edges"][number]["node"],
  { __typename: "NetWorthCategoryAsset" }
>;

function PlanningAccountsDialog() {
  const { year } = Route.useParams();
  const navigate = useNavigate();
  const { data } = useSuspenseQuery(PlanningAccountsDialogDocument, {
    variables: { year },
  });

  const refetch = [
    { query: PlanningAccountsDialogDocument, variables: { year } },
    { query: PlanningYearViewDocument, variables: { id: year } },
  ];

  const serverAccounts: Account[] = data.planningYear?.accounts ?? [];
  const serverById = new Map(serverAccounts.map((a) => [a.id, a]));
  // Local state holds only the **order** of ids so dnd-kit can commit the
  // new slot optimistically on drop without waiting for the refetch. Field
  // data (name, alias, …) is looked up fresh from the server on every
  // render — so an alias edit elsewhere flows through without us having to
  // merge state by hand.
  const [orderIds, setOrderIds] = useState<string[]>(() =>
    serverAccounts.map((a) => a.id),
  );
  // Resync local order only when the *set* of ids changes (assign / unassign).
  // Name changes or a server reorder that matches the local order are both
  // no-ops — using the sorted key here means we ignore pure-order diffs too,
  // so a refetch that lands with the same ids in a different order doesn't
  // stomp on an in-flight optimistic reorder.
  const serverIdSetKey = [...serverById.keys()].sort().join(",");
  const orderIdSetKey = [...orderIds].sort().join(",");
  useEffect(() => {
    if (serverIdSetKey !== orderIdSetKey) {
      setOrderIds(serverAccounts.map((a) => a.id));
    }
  }, [serverIdSetKey, orderIdSetKey, serverAccounts]);
  const accounts: Account[] = orderIds
    .map((id) => serverById.get(id))
    .filter((a): a is Account => a != null);

  const [reorder] = useMutation(PlanningAccountReorderDocument, {
    refetchQueries: refetch,
  });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const onDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = orderIds.indexOf(String(active.id));
    const to = orderIds.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    setOrderIds((ids) => arrayMove(ids, from, to));
    await reorder({ variables: { id: String(active.id), position: to } });
  };

  const assignedIds = new Set(accounts.map((a) => a.asset.id));
  const available: AssetOption[] = (data.netWorthCategories?.edges ?? [])
    .map((e) => e.node)
    .filter(
      (n): n is AssetOption =>
        n.__typename === "NetWorthCategoryAsset" &&
        n.type === "CASH" &&
        !assignedIds.has(n.id),
    );

  const close = () =>
    void navigate({ to: "/planning/$year", params: { year } });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Planning accounts</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={onDragEnd}
          >
            <SortableContext
              items={accounts.map((a) => a.id)}
              strategy={verticalListSortingStrategy}
            >
              <ul className="divide-y rounded-md border">
                {accounts.length === 0 && (
                  <li className="px-3 py-6 text-center text-sm text-muted-foreground">
                    No accounts yet.
                  </li>
                )}
                {accounts.map((a) => (
                  <AccountRow
                    key={a.id}
                    account={a}
                    currency={data.currencyDefault ?? "GBP"}
                    refetch={refetch}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
          <AddAccountForm
            options={available}
            currency={data.currencyDefault ?? "GBP"}
            refetch={refetch}
          />
        </div>
        <div className="flex justify-end">
          <Button variant="outline" onClick={close}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AccountRow({
  account,
  currency,
  refetch,
}: {
  account: Account;
  currency: string;
  refetch: RefetchEntry[];
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: account.id });

  const hasAlias = account.name !== account.asset.name;
  const [alias, setAlias] = useState(hasAlias ? account.name : "");
  const initialTarget =
    account.target == null ? "" : String(account.target.amount);
  const [target, setTarget] = useState(initialTarget);
  const [assign, assignState] = useMutation(PlanningAccountAssignDocument, {
    refetchQueries: refetch,
  });
  const [unassign] = useMutation(PlanningAccountUnassignDocument, {
    refetchQueries: refetch,
  });

  const initialAlias = hasAlias ? account.name : "";
  const targetParsed = parseTargetInput(target);
  const dirty =
    alias.trim() !== initialAlias ||
    target.trim() !== initialTarget ||
    targetParsed === "invalid";
  const canSave = targetParsed !== "invalid";

  const save = async () => {
    if (targetParsed === "invalid") return;
    const next = alias.trim();
    await assign({
      variables: {
        assetId: account.asset.id,
        alias: next === "" ? null : next,
        target:
          targetParsed == null ? null : { amount: targetParsed, currency },
      },
    });
    toast.success("Updated account");
  };

  const remove = async () => {
    await unassign({ variables: { assetId: account.asset.id } });
    toast.success(`Removed ${account.asset.name}`);
  };

  return (
    <li
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
      className={cn(
        "group/row relative flex items-center gap-2 bg-background px-3 py-2",
        // `dnd-kit` lifts the dragged item above siblings — bump z-index so
        // its shadow sits on top of the neighbours it's passing over.
        isDragging && "z-10 shadow-md",
      )}
    >
      <button
        type="button"
        aria-label="Drag to reorder"
        {...attributes}
        {...listeners}
        className="shrink-0 cursor-grab self-start pt-1 text-muted-foreground/60 hover:text-foreground active:cursor-grabbing"
      >
        <GripVertical className="size-4" />
      </button>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{account.asset.name}</div>
        <div className="mt-1 flex items-center gap-2">
          <Input
            placeholder="Alias (optional)"
            value={alias}
            onChange={(e) => setAlias(e.target.value)}
            className="h-8 text-xs"
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <Input
                aria-label="Target closing balance"
                placeholder="Target"
                inputMode="decimal"
                currency={currency}
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                className="h-8 w-28 text-xs"
              />
            </TooltipTrigger>
            <TooltipContent>
              Target month-end closing balance. Months projected below this show
              in yellow; projected negatives show in red.
            </TooltipContent>
          </Tooltip>
          <Button
            size="sm"
            variant="secondary"
            disabled={!dirty || !canSave || assignState.loading}
            onClick={save}
          >
            Save
          </Button>
        </div>
      </div>
      <DeleteButton onConfirm={remove} />
    </li>
  );
}

function AddAccountForm({
  options,
  currency,
  refetch,
}: {
  options: AssetOption[];
  currency: string;
  refetch: RefetchEntry[];
}) {
  const [assetId, setAssetId] = useState("");
  const [alias, setAlias] = useState("");
  const [target, setTarget] = useState("");
  const [assign, { loading }] = useMutation(PlanningAccountAssignDocument, {
    refetchQueries: refetch,
  });

  const targetParsed = parseTargetInput(target);
  const disabled = assetId === "" || loading || targetParsed === "invalid";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (disabled) return;
    const trimmed = alias.trim();
    await assign({
      variables: {
        assetId,
        alias: trimmed === "" ? null : trimmed,
        target:
          targetParsed == null ? null : { amount: targetParsed, currency },
      },
    });
    setAssetId("");
    setAlias("");
    setTarget("");
    toast.success("Account assigned");
  };

  if (options.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        Every asset is already assigned.
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-2 rounded-md border p-3">
      <div className="text-sm font-medium">Assign an asset</div>
      <div className="flex items-center gap-2">
        <Select value={assetId} onValueChange={setAssetId}>
          <SelectTrigger className="flex-1">
            <SelectValue placeholder="Pick an asset…" />
          </SelectTrigger>
          <SelectContent>
            {options.map((o) => (
              <SelectItem key={o.id} value={o.id}>
                {o.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          placeholder="Alias (optional)"
          value={alias}
          onChange={(e) => setAlias(e.target.value)}
          className="flex-1"
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <Input
              aria-label="Target closing balance"
              placeholder="Target"
              inputMode="decimal"
              currency={currency}
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              className="w-32"
            />
          </TooltipTrigger>
          <TooltipContent>
            Target month-end closing balance. Months projected below this show
            in yellow; projected negatives show in red.
          </TooltipContent>
        </Tooltip>
        <Button type="submit" disabled={disabled}>
          Assign
        </Button>
      </div>
    </form>
  );
}

/** Parse the target text input. Empty → `null` (clear the target); a valid non-negative decimal → the number; anything else → `"invalid"` so the caller can disable Save. */
function parseTargetInput(s: string): number | null | "invalid" {
  const trimmed = s.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return "invalid";
  return n;
}

import { useMutation, useSuspenseQuery } from "@apollo/client/react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
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

import { graphql, type ResultOf } from "../../../graphql";
import { PlanningYearViewDocument } from "../$year";

const PlanningAccountsDialogDocument = graphql(`
  query PlanningAccountsDialog($year: ID!) {
    planningYear(id: $year) {
      id
      accounts {
        id
        name
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
  }
`);

const PlanningAccountAssignDocument = graphql(`
  mutation PlanningAccountAssign($assetId: ID!, $alias: String) {
    planningAccountAssign(assetId: $assetId, alias: $alias) {
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

  const accounts: Account[] = data.planningYear?.accounts ?? [];
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
          <ul className="divide-y rounded-md border">
            {accounts.length === 0 && (
              <li className="px-3 py-6 text-center text-sm text-muted-foreground">
                No accounts yet.
              </li>
            )}
            {accounts.map((a) => (
              <AccountRow key={a.id} account={a} refetch={refetch} />
            ))}
          </ul>
          <AddAccountForm options={available} refetch={refetch} />
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
  refetch,
}: {
  account: Account;
  refetch: RefetchEntry[];
}) {
  const hasAlias = account.name !== account.asset.name;
  const [alias, setAlias] = useState(hasAlias ? account.name : "");
  const [assign, assignState] = useMutation(PlanningAccountAssignDocument, {
    refetchQueries: refetch,
  });
  const [unassign] = useMutation(PlanningAccountUnassignDocument, {
    refetchQueries: refetch,
  });

  const initial = hasAlias ? account.name : "";
  const dirty = alias.trim() !== initial;

  const save = async () => {
    const next = alias.trim();
    await assign({
      variables: {
        assetId: account.asset.id,
        alias: next === "" ? null : next,
      },
    });
    toast.success("Updated alias");
  };

  const remove = async () => {
    await unassign({ variables: { assetId: account.asset.id } });
    toast.success(`Removed ${account.asset.name}`);
  };

  return (
    <li className="flex items-center gap-2 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{account.asset.name}</div>
        <div className="mt-1 flex items-center gap-2">
          <Input
            placeholder="Alias (optional)"
            value={alias}
            onChange={(e) => setAlias(e.target.value)}
            className="h-8 text-xs"
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={!dirty || assignState.loading}
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
  refetch,
}: {
  options: AssetOption[];
  refetch: RefetchEntry[];
}) {
  const [assetId, setAssetId] = useState("");
  const [alias, setAlias] = useState("");
  const [assign, { loading }] = useMutation(PlanningAccountAssignDocument, {
    refetchQueries: refetch,
  });

  const disabled = assetId === "" || loading;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (disabled) return;
    const trimmed = alias.trim();
    await assign({
      variables: { assetId, alias: trimmed === "" ? null : trimmed },
    });
    setAssetId("");
    setAlias("");
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
        <Button type="submit" disabled={disabled}>
          Assign
        </Button>
      </div>
    </form>
  );
}

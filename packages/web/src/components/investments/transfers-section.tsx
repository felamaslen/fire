import { useMutation, useQuery } from "@apollo/client/react";
import { ArrowLeftRight, Pencil, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { DeleteButton } from "@/components/delete-button";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { graphql, type ResultOf } from "@/graphql";

const TransfersSectionDocument = graphql(`
  query TransfersSection($assetId: ID!) {
    netWorthCategoryAsset(id: $assetId) {
      id
      name
      type
      transferOut {
        id
        date
        assetTo {
          id
          name
        }
      }
      transfersIn {
        id
        date
        assetFrom {
          id
          name
        }
      }
    }
    candidates: investmentPortfolios {
      id
      name
      type
    }
  }
`);

const AssetStockTransferCreateDocument = graphql(`
  mutation AssetStockTransferCreate(
    $assetIdFrom: ID!
    $assetIdTo: ID!
    $date: Date!
  ) {
    assetStockTransferCreate(
      assetIdFrom: $assetIdFrom
      assetIdTo: $assetIdTo
      date: $date
    ) {
      id
    }
  }
`);

const AssetStockTransferUpdateDocument = graphql(`
  mutation AssetStockTransferUpdate($assetIdFrom: ID!, $date: Date!) {
    assetStockTransferUpdate(assetIdFrom: $assetIdFrom, date: $date) {
      id
    }
  }
`);

const AssetStockTransferDeleteDocument = graphql(`
  mutation AssetStockTransferDelete($assetIdFrom: ID!, $assetIdTo: ID!) {
    assetStockTransferDelete(assetIdFrom: $assetIdFrom, assetIdTo: $assetIdTo) {
      id
    }
  }
`);

type SectionData = ResultOf<typeof TransfersSectionDocument>;
type AssetData = NonNullable<SectionData["netWorthCategoryAsset"]>;
type TransferOut = NonNullable<AssetData["transferOut"]>;
type Candidate = NonNullable<SectionData["candidates"]>[number];

export function TransfersButton({ assetId }: { assetId: string }) {
  const { data } = useQuery(TransfersSectionDocument, {
    variables: { assetId },
  });
  const [open, setOpen] = useState(false);
  const asset = data?.netWorthCategoryAsset ?? null;

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <ArrowLeftRight className="mr-1 h-4 w-4" />
        Manage transfers
      </Button>
      {open && asset && data && (
        <ManageDialog
          asset={asset}
          candidates={data.candidates ?? []}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function ManageDialog({
  asset,
  candidates,
  onClose,
}: {
  asset: AssetData;
  candidates: Candidate[];
  onClose: () => void;
}) {
  const { refetch } = useQuery(TransfersSectionDocument, {
    variables: { assetId: asset.id },
  });
  const [editing, setEditing] = useState<
    { kind: "create" } | { kind: "edit"; transfer: TransferOut } | null
  >(null);

  const [deleteTransfer] = useMutation(AssetStockTransferDeleteDocument, {
    onCompleted: () => {
      toast.success("Transfer deleted");
      void refetch();
    },
    onError: (err) => toast.error(err.message),
  });

  const transferOut = asset.transferOut;
  const transfersIn = asset.transfersIn;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Manage transfers</DialogTitle>
          <DialogDescription>
            A transfer migrates all stock holdings and uninvested cash from one
            wrapper into another on a given date. Each wrapper can have at most
            one outgoing transfer.
          </DialogDescription>
        </DialogHeader>

        <div>
          <h3 className="mb-2 text-sm font-semibold">
            Outgoing (from {asset.name})
          </h3>
          {transferOut ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>To</TableHead>
                  <TableHead className="w-24" />
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow>
                  <TableCell className="align-middle tabular-nums">
                    {transferOut.date}
                  </TableCell>
                  <TableCell className="align-middle">
                    {transferOut.assetTo.name}
                  </TableCell>
                  <TableCell className="align-middle text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() =>
                          setEditing({ kind: "edit", transfer: transferOut })
                        }
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <DeleteButton
                        onConfirm={() =>
                          deleteTransfer({
                            variables: {
                              assetIdFrom: asset.id,
                              assetIdTo: transferOut.assetTo.id,
                            },
                          })
                        }
                      />
                    </div>
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setEditing({ kind: "create" })}
            >
              <Plus className="mr-1 h-4 w-4" />
              Add transfer out
            </Button>
          )}
        </div>

        {transfersIn.length > 0 && (
          <div>
            <h3 className="mb-2 text-sm font-semibold">
              Incoming (into {asset.name})
            </h3>
            <p className="mb-2 text-xs text-muted-foreground">
              Manage these from the source wrapper.
            </p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>From</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {transfersIn.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="align-middle tabular-nums">
                      {t.date}
                    </TableCell>
                    <TableCell className="align-middle">
                      {t.assetFrom.name}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {editing && (
          <TransferDialog
            asset={asset}
            candidates={candidates}
            existing={editing.kind === "edit" ? editing.transfer : null}
            onClose={(refresh) => {
              setEditing(null);
              if (refresh) void refetch();
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function TransferDialog({
  asset,
  candidates,
  existing,
  onClose,
}: {
  asset: AssetData;
  candidates: Candidate[];
  existing: TransferOut | null;
  onClose: (refresh: boolean) => void;
}) {
  const [date, setDate] = useState(
    existing?.date ?? new Date().toISOString().slice(0, 10),
  );
  const [assetIdTo, setAssetIdTo] = useState(existing?.assetTo.id ?? "");

  const [createTransfer, { loading: creating }] = useMutation(
    AssetStockTransferCreateDocument,
    {
      onCompleted: () => {
        toast.success("Transfer created");
        onClose(true);
      },
      onError: (err) => toast.error(err.message),
    },
  );
  const [updateTransfer, { loading: updating }] = useMutation(
    AssetStockTransferUpdateDocument,
    {
      onCompleted: () => {
        toast.success("Transfer updated");
        onClose(true);
      },
      onError: (err) => toast.error(err.message),
    },
  );

  const saving = creating || updating;
  const eligible = candidates.filter(
    (c) => c.id !== asset.id && (c.type === "STOCK" || c.type === "PENSION"),
  );

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (existing) {
      void updateTransfer({
        variables: { assetIdFrom: asset.id, date },
      });
      return;
    }
    if (!assetIdTo) {
      toast.error("Pick a destination wrapper");
      return;
    }
    void createTransfer({
      variables: { assetIdFrom: asset.id, assetIdTo, date },
    });
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose(false)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {existing ? "Edit transfer" : "Add transfer"}
          </DialogTitle>
          <DialogDescription>
            From <strong>{asset.name}</strong>
            {existing ? (
              <>
                {" "}
                to <strong>{existing.assetTo.name}</strong>. Only the date can
                be changed — delete and recreate the transfer to repoint it.
              </>
            ) : (
              ". Pick the destination wrapper and the date holdings move across."
            )}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          {!existing && (
            <Field label="Destination wrapper">
              <Select value={assetIdTo} onValueChange={setAssetIdTo}>
                <SelectTrigger>
                  <SelectValue placeholder="Pick a wrapper" />
                </SelectTrigger>
                <SelectContent>
                  {eligible.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
          <Field label="Date">
            <Input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              required
            />
          </Field>
          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onClose(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {existing ? "Save" : "Add"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

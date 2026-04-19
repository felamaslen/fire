import { useSuspenseQuery } from "@apollo/client/react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import {
  categoryOptions,
  EntryForm,
  LatestNetWorthEntryDocument,
  NetWorthEntryFormCategoriesDocument,
} from "@/components/net-worth/entry-form";
import { NetWorthEntryFormDocument } from "@/components/net-worth/entry-form";
import { Dialog, DialogContent } from "@/components/ui/dialog";

import { readFragment } from "../../../graphql";
import { entriesRefetch } from "../entries";

export const Route = createFileRoute("/net-worth/entries/new")({
  component: NewNetWorthEntryDialog,
});

function NewNetWorthEntryDialog() {
  const navigate = useNavigate();
  const latest = useSuspenseQuery(LatestNetWorthEntryDocument);
  const categoriesQuery = useSuspenseQuery(NetWorthEntryFormCategoriesDocument);

  const latestEdge = latest.data.netWorth?.edges[0];
  const sourceEntry = latestEdge
    ? readFragment(NetWorthEntryFormDocument, latestEdge.node)
    : null;
  const categories = categoryOptions(
    categoriesQuery.data.netWorthCategories?.edges.map((e) => e.node) ?? [],
  );

  const close = () => void navigate({ to: "/net-worth/entries" });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent>
        <EntryForm
          mode={{ kind: "new" }}
          entry={sourceEntry}
          categories={categories}
          onDone={close}
          refetchQueries={entriesRefetch}
        />
      </DialogContent>
    </Dialog>
  );
}

import { useSuspenseQuery } from "@apollo/client/react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import {
  categoryOptions,
  EntryForm,
  NetWorthEntryByIdDocument,
  NetWorthEntryFormCategoriesDocument,
  NetWorthEntryFormDocument,
} from "@/components/net-worth/entry-form";
import { Dialog, DialogContent } from "@/components/ui/dialog";

import { readFragment } from "../../../graphql";
import { entriesRefetch } from "../entries";

export const Route = createFileRoute("/net-worth/entries/$id/edit")({
  component: EditNetWorthEntryDialog,
});

function EditNetWorthEntryDialog() {
  const navigate = useNavigate();
  const { id } = Route.useParams();
  const entryQuery = useSuspenseQuery(NetWorthEntryByIdDocument, {
    variables: { id },
  });
  const categoriesQuery = useSuspenseQuery(NetWorthEntryFormCategoriesDocument);

  const entryRef = entryQuery.data.netWorthEntry;
  const entry = entryRef
    ? readFragment(NetWorthEntryFormDocument, entryRef)
    : null;
  const categories = categoryOptions(
    categoriesQuery.data.netWorthCategories?.edges.map((e) => e.node) ?? [],
  );

  const close = () => void navigate({ to: "/net-worth/entries" });

  if (!entry) {
    // Entry was deleted or never existed; send user back to the grid.
    close();
    return null;
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent>
        <EntryForm
          mode={{ kind: "edit", entryId: id }}
          entry={entry}
          categories={categories}
          onDone={close}
          refetchQueries={entriesRefetch}
        />
      </DialogContent>
    </Dialog>
  );
}

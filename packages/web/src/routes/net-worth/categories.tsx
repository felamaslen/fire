import { useMutation, useSuspenseQuery } from "@apollo/client/react";
import { useForm } from "@tanstack/react-form";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";

import { DeleteButton } from "@/components/delete-button";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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

import {
  type FragmentOf,
  graphql,
  readFragment,
  type ResultOf,
} from "../../graphql";
import { entriesRefetch } from "./entries";

const AssetRowDocument = graphql(`
  fragment AssetRow on NetWorthCategoryAsset {
    id
    name
    assetType: type
    growthRate
  }
`);

const LiabilityRowDocument = graphql(`
  fragment LiabilityRow on NetWorthCategoryLiability {
    id
    name
    liabilityType: type
    interestRate
    skip
    asset {
      id
      name
    }
    billedFromAccount {
      id
      name
    }
  }
`);

const OptionRowDocument = graphql(`
  fragment OptionRow on NetWorthCategoryOption {
    id
    name
  }
`);

const NetWorthCategorySelectionDocument = graphql(
  `
    fragment NetWorthCategorySelection on NetWorthCategory {
      __typename
      id
      name
      ... on NetWorthCategoryAsset {
        assetType: type
        ...AssetRow
      }
      ... on NetWorthCategoryLiability {
        liabilityType: type
        ...LiabilityRow
      }
      ... on NetWorthCategoryOption {
        ...OptionRow
      }
    }
  `,
  [AssetRowDocument, LiabilityRowDocument, OptionRowDocument],
);

type AssetSelection = Extract<
  ResultOf<typeof NetWorthCategorySelectionDocument>,
  { __typename: "NetWorthCategoryAsset" }
>;
type LiabilitySelection = Extract<
  ResultOf<typeof NetWorthCategorySelectionDocument>,
  { __typename: "NetWorthCategoryLiability" }
>;
type OptionSelection = Extract<
  ResultOf<typeof NetWorthCategorySelectionDocument>,
  { __typename: "NetWorthCategoryOption" }
>;

const NetWorthCategoriesDocument = graphql(
  `
    query NetWorthCategories {
      netWorthCategories(first: 100) {
        edges {
          node {
            ...NetWorthCategorySelection
          }
        }
      }
      planningYearCurrent {
        id
        accounts {
          id
          name
        }
      }
    }
  `,
  [NetWorthCategorySelectionDocument],
);

const NetWorthCategoryCreateDocument = graphql(
  `
    mutation NetWorthCategoryCreate($input: NetWorthCategoryInput!) {
      netWorthCategoryCreate(input: $input) {
        ...NetWorthCategorySelection
      }
    }
  `,
  [NetWorthCategorySelectionDocument],
);

const NetWorthCategoryUpdateDocument = graphql(
  `
    mutation NetWorthCategoryUpdate($id: ID!, $patch: NetWorthCategoryPatch!) {
      netWorthCategoryUpdate(id: $id, patch: $patch) {
        ...NetWorthCategorySelection
      }
    }
  `,
  [NetWorthCategorySelectionDocument],
);

const NetWorthCategoryDeleteDocument = graphql(`
  mutation NetWorthCategoryDelete($ref: NetWorthCategoryRef!) {
    netWorthCategoryDelete(ref: $ref) {
      _
    }
  }
`);

type AssetType = ResultOf<typeof AssetRowDocument>["assetType"];
type LiabilityType = ResultOf<typeof LiabilityRowDocument>["liabilityType"];

const ASSET_TYPE_LABELS = {
  CASH: "Cash",
  STOCK: "Stocks",
  OPTION: "Options",
  PENSION: "Pensions",
  PROPERTY: "Property",
  VEHICLE: "Vehicles",
  MISC: "Other",
} as const satisfies Record<AssetType, string>;

const LIABILITY_TYPE_LABELS = {
  CREDIT_CARD: "Credit cards",
  LOAN: "Loans",
  MISC: "Other",
} as const satisfies Record<LiabilityType, string>;

const ASSET_TYPES = Object.keys(ASSET_TYPE_LABELS) as AssetType[];
const LIABILITY_TYPES = Object.keys(LIABILITY_TYPE_LABELS) as LiabilityType[];

function percentToStr(pct: number | null): string {
  if (pct == null) return "";
  return String(pct);
}

function strToPercent(s: string): number | null {
  if (!s) return null;
  const n = Number.parseFloat(s);
  if (Number.isNaN(n)) return null;
  return n;
}

export const Route = createFileRoute("/net-worth/categories")({
  component: NetWorthCategoriesPage,
});

const refetch = [{ query: NetWorthCategoriesDocument }];

type PlanningAccountOption = NonNullable<
  ResultOf<typeof NetWorthCategoriesDocument>["planningYearCurrent"]
>["accounts"][number];

function NetWorthCategoriesPage() {
  const { data } = useSuspenseQuery(NetWorthCategoriesDocument);

  const nodes = data.netWorthCategories?.edges.map((e) => e.node) ?? [];
  const assets: AssetSelection[] = [];
  const liabilities: LiabilitySelection[] = [];
  const options: OptionSelection[] = [];
  for (const _n of nodes) {
    const n = readFragment(NetWorthCategorySelectionDocument, _n);
    if (n.__typename === "NetWorthCategoryAsset") assets.push(n);
    else if (n.__typename === "NetWorthCategoryLiability") liabilities.push(n);
    else if (n.__typename === "NetWorthCategoryOption") options.push(n);
    else throw new Error("Unhandled node: " + n);
  }
  const planningAccounts = data.planningYearCurrent?.accounts ?? [];

  return (
    <Accordion type="single" collapsible className="space-y-2">
      <AssetsSection data={assets} />
      <LiabilitiesSection
        data={liabilities}
        assets={assets}
        planningAccounts={planningAccounts}
      />
      <OptionsSection data={options} />
    </Accordion>
  );
}

const ASSET_DND_MIME = "application/x-fire-asset-id";

function AssetsSection({ data }: { data: AssetSelection[] }) {
  const [create, { loading }] = useMutation(NetWorthCategoryCreateDocument, {
    refetchQueries: refetch,
    onCompleted: () => toast.success("Category created"),
  });
  const [updateType] = useMutation(NetWorthCategoryUpdateDocument, {
    refetchQueries: refetch,
    onCompleted: () => toast.success("Asset moved"),
  });
  const form = useForm({
    defaultValues: { name: "", type: "CASH" as AssetType },
    onSubmit: async ({ value }) => {
      if (!value.name.trim()) return;
      await create({
        variables: { input: { asset: { name: value.name, type: value.type } } },
      });
      form.reset();
    },
  });

  const moveAsset = (id: string, nextType: AssetType) => {
    const existing = data.find((d) => d.id === id);
    if (!existing || existing.assetType === nextType) return;
    // Clear any growthRate when moving away from PROPERTY/VEHICLE so the
    // CHECK constraint stays satisfied; the user can re-enter it in the new
    // bucket if applicable.
    const canKeepGrowth = nextType === "PROPERTY" || nextType === "VEHICLE";
    void updateType({
      variables: {
        id,
        patch: {
          asset: {
            type: nextType,
            growthRate: canKeepGrowth ? undefined : null,
          },
        },
      },
    }).catch((err: Error) => toast.error(err.message));
  };

  return (
    <AccordionItem value="assets">
      <AccordionTrigger>Assets</AccordionTrigger>
      <AccordionContent className="space-y-4">
        <Accordion type="single" collapsible className="space-y-2">
          {ASSET_TYPES.map((group) => {
            const rows = data.filter((d) => d.assetType === group);
            return (
              <AssetTypeGroup
                key={group}
                group={group}
                rows={rows}
                onDropAsset={(id) => moveAsset(id, group)}
              />
            );
          })}
        </Accordion>
        <form
          className="flex items-center gap-2 pt-2"
          onSubmit={(e) => {
            e.preventDefault();
            void form.handleSubmit();
          }}
        >
          <form.Field name="name">
            {(field) => (
              <Input
                placeholder="New asset name"
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
              />
            )}
          </form.Field>
          <form.Field name="type">
            {(field) => (
              <Select
                value={field.state.value}
                onValueChange={(v) => field.handleChange(v as AssetType)}
              >
                <SelectTrigger className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ASSET_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {ASSET_TYPE_LABELS[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </form.Field>
          <Button type="submit" disabled={loading}>
            Add
          </Button>
        </form>
      </AccordionContent>
    </AccordionItem>
  );
}

function AssetTypeGroup({
  group,
  rows,
  onDropAsset,
}: {
  group: AssetType;
  rows: AssetSelection[];
  onDropAsset: (id: string) => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  return (
    <AccordionItem
      value={group}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(ASSET_DND_MIME)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        setDragOver(false);
        const id = e.dataTransfer.getData(ASSET_DND_MIME);
        if (id) onDropAsset(id);
      }}
      className={cn(
        "rounded-md border border-transparent transition-colors",
        dragOver && "border-primary/70 bg-primary/5",
      )}
    >
      <AccordionTrigger>
        <span className="flex-1 text-left">{ASSET_TYPE_LABELS[group]}</span>
        <span className="mr-2 w-8 text-right text-xs tabular-nums text-muted-foreground">
          {rows.length}
        </span>
      </AccordionTrigger>
      <AccordionContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Drop an asset here to move it into {ASSET_TYPE_LABELS[group]}.
          </p>
        ) : (
          <div className="space-y-2">
            {rows.map((d) => (
              <AssetRow key={d.id} data={d} />
            ))}
          </div>
        )}
      </AccordionContent>
    </AccordionItem>
  );
}

function AssetRow({ data }: { data: FragmentOf<typeof AssetRowDocument> }) {
  const asset = readFragment(AssetRowDocument, data);
  const [update] = useMutation(NetWorthCategoryUpdateDocument, {
    onCompleted: () => toast.success("Category updated"),
  });
  const [remove] = useMutation(NetWorthCategoryDeleteDocument, {
    refetchQueries: refetch,
    onCompleted: () => toast.success("Category deleted"),
  });

  const supportsGrowth =
    asset.assetType === "PROPERTY" || asset.assetType === "VEHICLE";

  const form = useForm({
    defaultValues: {
      name: asset.name,
      growthRate: percentToStr(asset.growthRate),
    },
    onSubmit: async ({ value }) => {
      await update({
        variables: {
          id: asset.id,
          patch: {
            asset: {
              name: value.name,
              growthRate: supportsGrowth
                ? strToPercent(value.growthRate)
                : null,
            },
          },
        },
      }).catch((err: Error) => toast.error(err.message));
      form.reset(value);
    },
  });

  return (
    <form
      className="flex items-center gap-2"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(ASSET_DND_MIME, asset.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      onSubmit={(e) => {
        e.preventDefault();
        void form.handleSubmit();
      }}
    >
      <span
        className="cursor-grab select-none text-muted-foreground active:cursor-grabbing"
        aria-hidden
        title="Drag to change asset type"
      >
        ⋮⋮
      </span>
      <form.Field name="name">
        {(field) => (
          <Input
            value={field.state.value}
            onChange={(e) => field.handleChange(e.target.value)}
          />
        )}
      </form.Field>
      {supportsGrowth && (
        <form.Field name="growthRate">
          {(field) => (
            <Tooltip>
              <TooltipTrigger asChild>
                <Input
                  inputMode="decimal"
                  className="w-28"
                  aria-label="Annual growth rate (%)"
                  endAdornment="%/yr"
                  placeholder={asset.assetType === "VEHICLE" ? "-15" : "3"}
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
              </TooltipTrigger>
              <TooltipContent>
                Assumed annual growth rate used by the net-worth forecast. Use a
                negative number for depreciation (e.g. −15 for a vehicle losing
                15% of its value per year).
              </TooltipContent>
            </Tooltip>
          )}
        </form.Field>
      )}
      <form.Subscribe selector={(s) => [s.canSubmit, s.isDirty]}>
        {([canSubmit, isDirty]) => (
          <Button
            type="submit"
            variant="secondary"
            size="sm"
            disabled={!canSubmit || !isDirty}
          >
            Save
          </Button>
        )}
      </form.Subscribe>
      <DeleteButton
        onConfirm={() =>
          remove({ variables: { ref: { asset: asset.id } } }).catch(
            (err: Error) => toast.error(err.message),
          )
        }
      />
    </form>
  );
}

function LiabilitiesSection({
  data,
  assets,
  planningAccounts,
}: {
  data: LiabilitySelection[];
  assets: AssetSelection[];
  planningAccounts: PlanningAccountOption[];
}) {
  const [create, { loading }] = useMutation(NetWorthCategoryCreateDocument, {
    refetchQueries: refetch,
    onCompleted: () => toast.success("Category created"),
  });
  const loanSecurableAssets = assets.filter(
    (a) => a.assetType === "PROPERTY" || a.assetType === "VEHICLE",
  );
  const form = useForm({
    defaultValues: {
      name: "",
      type: "CREDIT_CARD" as LiabilityType,
      interestRate: "",
      skip: false,
      billedFromAccountId: "" as string,
      assetId: "" as string,
    },
    onSubmit: async ({ value }) => {
      if (!value.name.trim()) return;
      if (value.type === "LOAN" && !value.interestRate) return;
      await create({
        variables: {
          input: {
            liability: {
              name: value.name,
              type: value.type,
              interestRate:
                value.type === "LOAN" ? strToPercent(value.interestRate) : null,
              billedFromAccountId:
                value.type === "CREDIT_CARD" && value.billedFromAccountId
                  ? value.billedFromAccountId
                  : null,
              assetId:
                value.type === "LOAN" && value.assetId ? value.assetId : null,
              skip: value.type === "LOAN" ? value.skip : null,
            },
          },
        },
      });
      form.reset();
    },
  });

  return (
    <AccordionItem value="liabilities">
      <AccordionTrigger>Liabilities</AccordionTrigger>
      <AccordionContent className="space-y-4">
        <Accordion type="single" collapsible className="space-y-2">
          {LIABILITY_TYPES.map((group) => {
            const rows = data.filter((d) => d.liabilityType === group);
            if (rows.length === 0) return null;
            return (
              <AccordionItem key={group} value={group}>
                <AccordionTrigger>
                  {LIABILITY_TYPE_LABELS[group]}
                </AccordionTrigger>
                <AccordionContent>
                  <div className="space-y-2">
                    {rows.map((d) => (
                      <LiabilityRow
                        key={d.id}
                        data={d}
                        assets={assets}
                        planningAccounts={planningAccounts}
                      />
                    ))}
                  </div>
                </AccordionContent>
              </AccordionItem>
            );
          })}
        </Accordion>
        <form
          className="flex items-center gap-2 pt-2"
          onSubmit={(e) => {
            e.preventDefault();
            void form.handleSubmit();
          }}
        >
          <form.Field name="name">
            {(field) => (
              <Input
                placeholder="New liability name"
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
              />
            )}
          </form.Field>
          <form.Field name="type">
            {(field) => (
              <Select
                value={field.state.value}
                onValueChange={(v) => field.handleChange(v as LiabilityType)}
              >
                <SelectTrigger className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LIABILITY_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {LIABILITY_TYPE_LABELS[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </form.Field>
          <form.Subscribe selector={(s) => s.values.type}>
            {(type) =>
              type === "CREDIT_CARD" &&
              planningAccounts.length > 0 && (
                <form.Field name="billedFromAccountId">
                  {(field) => (
                    <Select
                      value={field.state.value || "__none__"}
                      onValueChange={(v) =>
                        field.handleChange(v === "__none__" ? "" : v)
                      }
                    >
                      <SelectTrigger className="w-48">
                        <SelectValue placeholder="Billed from…" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">
                          No billed-from account
                        </SelectItem>
                        {planningAccounts.map((a) => (
                          <SelectItem key={a.id} value={a.id}>
                            {a.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </form.Field>
              )
            }
          </form.Subscribe>
          <form.Subscribe selector={(s) => s.values.type}>
            {(type) =>
              type === "LOAN" && (
                <>
                  <form.Field name="interestRate">
                    {(field) => (
                      <Input
                        inputMode="decimal"
                        className="w-28"
                        aria-label="Interest rate (%)"
                        endAdornment="%"
                        value={field.state.value}
                        onChange={(e) => field.handleChange(e.target.value)}
                      />
                    )}
                  </form.Field>
                  {loanSecurableAssets.length > 0 && (
                    <form.Field name="assetId">
                      {(field) => (
                        <Select
                          value={field.state.value || "__none__"}
                          onValueChange={(v) =>
                            field.handleChange(v === "__none__" ? "" : v)
                          }
                        >
                          <SelectTrigger className="w-48">
                            <SelectValue placeholder="Secured against…" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__none__">
                              Not secured against an asset
                            </SelectItem>
                            {loanSecurableAssets.map((a) => (
                              <SelectItem key={a.id} value={a.id}>
                                {a.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    </form.Field>
                  )}
                  <form.Field name="skip">
                    {(field) => (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <label className="flex cursor-pointer items-center gap-1.5 text-sm text-muted-foreground">
                            <Checkbox
                              checked={field.state.value}
                              onCheckedChange={(v) =>
                                field.handleChange(v === true)
                              }
                            />
                            Skip
                          </label>
                        </TooltipTrigger>
                        <TooltipContent>
                          Exclude this loan from net-worth totals and
                          debt-payoff projections. Use for loans you're still
                          tracking but don't want included in calculations (e.g.
                          a 0% interest-free arrangement you're happy to carry).
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </form.Field>
                </>
              )
            }
          </form.Subscribe>
          <Button type="submit" disabled={loading}>
            Add
          </Button>
        </form>
      </AccordionContent>
    </AccordionItem>
  );
}

function LiabilityRow({
  data,
  assets,
  planningAccounts,
}: {
  data: FragmentOf<typeof LiabilityRowDocument>;
  assets: AssetSelection[];
  planningAccounts: PlanningAccountOption[];
}) {
  const liability = readFragment(LiabilityRowDocument, data);
  // Liability `skip` feeds `NetWorthEntry.totalLiabilities` / `totalNet`, so
  // any toggle must invalidate every visible entry total — refetch the
  // entries grid alongside the category list.
  const [update] = useMutation(NetWorthCategoryUpdateDocument, {
    refetchQueries: [...refetch, ...entriesRefetch],
    onCompleted: () => toast.success("Category updated"),
  });
  const [remove] = useMutation(NetWorthCategoryDeleteDocument, {
    refetchQueries: [...refetch, ...entriesRefetch],
    onCompleted: () => toast.success("Category deleted"),
  });

  const isLoan = liability.liabilityType === "LOAN";
  const isCreditCard = liability.liabilityType === "CREDIT_CARD";
  const loanSecurableAssets = assets.filter(
    (a) => a.assetType === "PROPERTY" || a.assetType === "VEHICLE",
  );
  const form = useForm({
    defaultValues: {
      name: liability.name,
      interestRate: percentToStr(liability.interestRate),
      skip: liability.skip ?? false,
      billedFromAccountId: liability.billedFromAccount?.id ?? "",
      assetId: liability.asset?.id ?? "",
    },
    onSubmit: async ({ value }) => {
      await update({
        variables: {
          id: liability.id,
          patch: {
            liability: {
              name: value.name,
              interestRate: isLoan ? strToPercent(value.interestRate) : null,
              billedFromAccountId: isCreditCard
                ? value.billedFromAccountId || null
                : null,
              assetId: isLoan ? value.assetId || null : null,
              skip: isLoan ? value.skip : null,
            },
          },
        },
      }).catch((err: Error) => toast.error(err.message));
      form.reset(value);
    },
  });

  return (
    <form
      className={cn(
        "items-center gap-2",
        isLoan ? "grid grid-cols-[1fr_7rem_12rem_4rem_auto_auto]" : "flex",
      )}
      onSubmit={(e) => {
        e.preventDefault();
        void form.handleSubmit();
      }}
    >
      <form.Field name="name">
        {(field) => (
          <Input
            value={field.state.value}
            onChange={(e) => field.handleChange(e.target.value)}
          />
        )}
      </form.Field>
      {isCreditCard && planningAccounts.length > 0 && (
        <form.Field name="billedFromAccountId">
          {(field) => (
            <Select
              value={field.state.value || "__none__"}
              onValueChange={(v) =>
                field.handleChange(v === "__none__" ? "" : v)
              }
            >
              <SelectTrigger className="w-48">
                <SelectValue placeholder="Billed from…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">No billed-from account</SelectItem>
                {planningAccounts.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </form.Field>
      )}
      {isLoan && (
        <>
          <form.Field name="interestRate">
            {(field) => (
              <Input
                inputMode="decimal"
                className="w-28"
                aria-label="Interest rate (%)"
                endAdornment="%"
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
              />
            )}
          </form.Field>
          {loanSecurableAssets.length > 0 && (
            <form.Field name="assetId">
              {(field) => (
                <Select
                  value={field.state.value || "__none__"}
                  onValueChange={(v) =>
                    field.handleChange(v === "__none__" ? "" : v)
                  }
                >
                  <SelectTrigger className="w-48">
                    <SelectValue placeholder="Secured against…" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">
                      Not secured against an asset
                    </SelectItem>
                    {loanSecurableAssets.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </form.Field>
          )}
          <form.Field name="skip">
            {(field) => (
              <Tooltip>
                <TooltipTrigger asChild>
                  <label className="flex cursor-pointer items-center gap-1.5 text-sm text-muted-foreground">
                    <Checkbox
                      checked={field.state.value}
                      onCheckedChange={(v) => field.handleChange(v === true)}
                    />
                    Skip
                  </label>
                </TooltipTrigger>
                <TooltipContent>
                  Exclude this loan from net-worth totals and debt-payoff
                  projections. Use for loans you're still tracking but don't
                  want included in calculations (e.g. a 0% interest-free
                  arrangement you're happy to carry).
                </TooltipContent>
              </Tooltip>
            )}
          </form.Field>
        </>
      )}
      <form.Subscribe selector={(s) => [s.canSubmit, s.isDirty]}>
        {([canSubmit, isDirty]) => (
          <Button
            type="submit"
            variant="secondary"
            size="sm"
            disabled={!canSubmit || !isDirty}
          >
            Save
          </Button>
        )}
      </form.Subscribe>
      <DeleteButton
        onConfirm={() =>
          remove({ variables: { ref: { liability: liability.id } } }).catch(
            (err: Error) => toast.error(err.message),
          )
        }
      />
    </form>
  );
}

function OptionsSection({ data }: { data: OptionSelection[] }) {
  const [create, { loading }] = useMutation(NetWorthCategoryCreateDocument, {
    refetchQueries: refetch,
    onCompleted: () => toast.success("Category created"),
  });
  const form = useForm({
    defaultValues: { name: "" },
    onSubmit: async ({ value }) => {
      if (!value.name.trim()) return;
      await create({ variables: { input: { option: { name: value.name } } } });
      form.reset();
    },
  });

  return (
    <AccordionItem value="options">
      <AccordionTrigger>Options</AccordionTrigger>
      <AccordionContent className="space-y-2">
        {data.map((d) => (
          <OptionRow key={d.id} data={d} />
        ))}
        <form
          className="flex items-center gap-2 pt-2"
          onSubmit={(e) => {
            e.preventDefault();
            void form.handleSubmit();
          }}
        >
          <form.Field name="name">
            {(field) => (
              <Input
                placeholder="New option name"
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
              />
            )}
          </form.Field>
          <Button type="submit" disabled={loading}>
            Add
          </Button>
        </form>
      </AccordionContent>
    </AccordionItem>
  );
}

function OptionRow({ data }: { data: FragmentOf<typeof OptionRowDocument> }) {
  const option = readFragment(OptionRowDocument, data);
  const [update] = useMutation(NetWorthCategoryUpdateDocument, {
    onCompleted: () => toast.success("Category updated"),
  });
  const [remove] = useMutation(NetWorthCategoryDeleteDocument, {
    refetchQueries: refetch,
    onCompleted: () => toast.success("Category deleted"),
  });

  const form = useForm({
    defaultValues: { name: option.name },
    onSubmit: async ({ value }) => {
      await update({
        variables: { id: option.id, patch: { option: { name: value.name } } },
      }).catch((err: Error) => toast.error(err.message));
      form.reset(value);
    },
  });

  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void form.handleSubmit();
      }}
    >
      <form.Field name="name">
        {(field) => (
          <Input
            value={field.state.value}
            onChange={(e) => field.handleChange(e.target.value)}
          />
        )}
      </form.Field>
      <form.Subscribe selector={(s) => [s.canSubmit, s.isDirty]}>
        {([canSubmit, isDirty]) => (
          <Button
            type="submit"
            variant="secondary"
            size="sm"
            disabled={!canSubmit || !isDirty}
          >
            Save
          </Button>
        )}
      </form.Subscribe>
      <DeleteButton
        onConfirm={() =>
          remove({ variables: { ref: { option: option.id } } }).catch(
            (err: Error) => toast.error(err.message),
          )
        }
      />
    </form>
  );
}

import { useMutation, useSuspenseQuery } from "@apollo/client/react";
import { useForm } from "@tanstack/react-form";
import { createFileRoute } from "@tanstack/react-router";
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
  }
`);

const LiabilityRowDocument = graphql(`
  fragment LiabilityRow on NetWorthCategoryLiability {
    id
    name
    liabilityType: type
    interestRate
    skip
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
  MISC: "Other",
} as const satisfies Record<AssetType, string>;

const LIABILITY_TYPE_LABELS = {
  CREDIT_CARD: "Credit cards",
  LOAN: "Loans",
  MISC: "Other",
} as const satisfies Record<LiabilityType, string>;

const ASSET_TYPES = Object.keys(ASSET_TYPE_LABELS) as AssetType[];
const LIABILITY_TYPES = Object.keys(LIABILITY_TYPE_LABELS) as LiabilityType[];

function decimalToPercent(decimal: number | null): string {
  if (decimal == null) return "";
  return (decimal * 100).toString();
}

function percentToDecimal(percent: string): number | null {
  if (!percent) return null;
  const n = Number.parseFloat(percent);
  if (Number.isNaN(n)) return null;
  return n / 100;
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
        planningAccounts={planningAccounts}
      />
      <OptionsSection data={options} />
    </Accordion>
  );
}

function AssetsSection({ data }: { data: AssetSelection[] }) {
  const [create, { loading }] = useMutation(NetWorthCategoryCreateDocument, {
    refetchQueries: refetch,
    onCompleted: () => toast.success("Category created"),
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

  return (
    <AccordionItem value="assets">
      <AccordionTrigger>Assets</AccordionTrigger>
      <AccordionContent className="space-y-4">
        <Accordion type="single" collapsible className="space-y-2">
          {ASSET_TYPES.map((group) => {
            const rows = data.filter((d) => d.assetType === group);
            if (rows.length === 0) return null;
            return (
              <AccordionItem key={group} value={group}>
                <AccordionTrigger>{ASSET_TYPE_LABELS[group]}</AccordionTrigger>
                <AccordionContent>
                  <div className="space-y-2">
                    {rows.map((d) => (
                      <AssetRow key={d.id} data={d} />
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

function AssetRow({ data }: { data: FragmentOf<typeof AssetRowDocument> }) {
  const asset = readFragment(AssetRowDocument, data);
  const [update] = useMutation(NetWorthCategoryUpdateDocument, {
    onCompleted: () => toast.success("Category updated"),
  });
  const [remove] = useMutation(NetWorthCategoryDeleteDocument, {
    refetchQueries: refetch,
    onCompleted: () => toast.success("Category deleted"),
  });

  const form = useForm({
    defaultValues: { name: asset.name },
    onSubmit: async ({ value }) => {
      await update({
        variables: {
          id: asset.id,
          patch: { asset: { name: value.name } },
        },
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
  planningAccounts,
}: {
  data: LiabilitySelection[];
  planningAccounts: PlanningAccountOption[];
}) {
  const [create, { loading }] = useMutation(NetWorthCategoryCreateDocument, {
    refetchQueries: refetch,
    onCompleted: () => toast.success("Category created"),
  });
  const form = useForm({
    defaultValues: {
      name: "",
      type: "CREDIT_CARD" as LiabilityType,
      interestRate: "",
      skip: false,
      billedFromAccountId: "" as string,
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
                value.type === "LOAN" && value.interestRate
                  ? Number.parseFloat(value.interestRate) / 100
                  : null,
              billedFromAccountId:
                value.type === "CREDIT_CARD" && value.billedFromAccountId
                  ? value.billedFromAccountId
                  : null,
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
              type === "CREDIT_CARD" && planningAccounts.length > 0 && (
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
  planningAccounts,
}: {
  data: FragmentOf<typeof LiabilityRowDocument>;
  planningAccounts: PlanningAccountOption[];
}) {
  const liability = readFragment(LiabilityRowDocument, data);
  // Liability `skip` feeds `NetWorthEntry.totalLiabilities` / `totalNet`, so
  // any toggle must invalidate every visible entry total — refetch the
  // entries grid alongside the category list.
  const [update] = useMutation(NetWorthCategoryUpdateDocument, {
    refetchQueries: entriesRefetch,
    onCompleted: () => toast.success("Category updated"),
  });
  const [remove] = useMutation(NetWorthCategoryDeleteDocument, {
    refetchQueries: [...refetch, ...entriesRefetch],
    onCompleted: () => toast.success("Category deleted"),
  });

  const isLoan = liability.liabilityType === "LOAN";
  const isCreditCard = liability.liabilityType === "CREDIT_CARD";
  const form = useForm({
    defaultValues: {
      name: liability.name,
      interestRate: decimalToPercent(liability.interestRate),
      skip: liability.skip ?? false,
      billedFromAccountId: liability.billedFromAccount?.id ?? "",
    },
    onSubmit: async ({ value }) => {
      await update({
        variables: {
          id: liability.id,
          patch: {
            liability: {
              name: value.name,
              interestRate: isLoan
                ? percentToDecimal(value.interestRate)
                : null,
              billedFromAccountId: isCreditCard
                ? value.billedFromAccountId || null
                : null,
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

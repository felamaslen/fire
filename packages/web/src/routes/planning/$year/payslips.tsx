import { useMutation, useSuspenseQuery } from "@apollo/client/react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Pencil, Plus, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { DeleteButton } from "@/components/delete-button";
import { Figure, FigureDocument } from "@/components/figure";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
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

import { graphql, type ResultOf } from "../../../graphql";
import { PlanningYearViewDocument } from "../$year";

const PlanningPayslipsDialogDocument = graphql(
  `
    query PlanningPayslipsDialog($year: ID!) {
      payslips(first: 100) {
        edges {
          node {
            id
            name
            date
            amountGross {
              amount
              currency
              ...Figure
            }
            toAccount {
              id
              name
            }
            adjustments {
              id
              name
              amount {
                amount
                currency
              }
              liability {
                id
                name
              }
            }
          }
        }
      }
      planningYear(id: $year) {
        id
        accounts {
          id
          name
        }
      }
      netWorthCategories(first: 100) {
        edges {
          node {
            __typename
            ... on NetWorthCategoryLiability {
              id
              name
            }
          }
        }
      }
    }
  `,
  [FigureDocument],
);

const PlanningPayslipCreateDocument = graphql(`
  mutation PlanningPayslipCreate(
    $date: Date!
    $amountGross: MoneyInput!
    $name: String!
    $toAccountId: ID!
    $adjustments: [PayslipAdjustmentInput!]
  ) {
    payslipCreate(
      date: $date
      amountGross: $amountGross
      name: $name
      toAccountId: $toAccountId
      adjustments: $adjustments
    ) {
      id
    }
  }
`);

const PlanningPayslipUpdateDocument = graphql(`
  mutation PlanningPayslipUpdate(
    $id: ID!
    $date: Date
    $amountGross: MoneyInput
    $name: String
    $toAccountId: ID
    $adjustments: [PayslipAdjustmentInput!]
  ) {
    payslipUpdate(
      id: $id
      date: $date
      amountGross: $amountGross
      name: $name
      toAccountId: $toAccountId
      adjustments: $adjustments
    ) {
      id
    }
  }
`);

const PlanningPayslipDeleteDocument = graphql(`
  mutation PlanningPayslipDelete($id: ID!) {
    payslipDelete(id: $id) {
      _
    }
  }
`);

export const Route = createFileRoute("/planning/$year/payslips")({
  component: PlanningPayslipsDialog,
});

type PlanningPayslipsData = ResultOf<typeof PlanningPayslipsDialogDocument>;
type Payslip = NonNullable<
  PlanningPayslipsData["payslips"]
>["edges"][number]["node"];
type AccountOption = NonNullable<
  PlanningPayslipsData["planningYear"]
>["accounts"][number];
type LiabilityOption = Extract<
  NonNullable<PlanningPayslipsData["netWorthCategories"]>["edges"][number]["node"],
  { __typename: "NetWorthCategoryLiability" }
>;

type RefetchEntry =
  | {
      query: typeof PlanningPayslipsDialogDocument;
      variables: { year: string };
    }
  | { query: typeof PlanningYearViewDocument; variables: { id: string } };

/** A row in the adjustment editor. `id` is present when editing an existing
 * adjustment so the backend can upsert it rather than replace. `sign` tracks
 * the user-facing direction separately from the displayed magnitude. */
type AdjustmentEntry = {
  id: string | null;
  name: string;
  amount: string;
  sign: "+" | "-";
  liabilityId: string;
};

type FormValues = {
  name: string;
  date: string;
  amount: string;
  toAccountId: string;
  adjustments: AdjustmentEntry[];
};

const CURRENCY = "GBP";

const emptyForm: FormValues = {
  name: "",
  date: "",
  amount: "",
  toAccountId: "",
  adjustments: [],
};

function payslipToForm(p: Payslip): FormValues {
  return {
    name: p.name,
    date: p.date,
    amount: String(p.amountGross.amount),
    toAccountId: p.toAccount.id,
    adjustments: p.adjustments.map((a) => ({
      id: a.id,
      name: a.name,
      amount: String(Math.abs(a.amount.amount)),
      sign: a.amount.amount < 0 ? "-" : "+",
      liabilityId: a.liability?.id ?? "",
    })),
  };
}

function adjustmentsForMutation(entries: AdjustmentEntry[]) {
  return entries
    .filter((e) => e.name.trim() !== "")
    .map((e) => {
      const mag = Math.abs(Number(e.amount) || 0);
      return {
        ...(e.id != null && { id: e.id }),
        name: e.name.trim(),
        amount: {
          amount: e.sign === "-" ? -mag : mag,
          currency: CURRENCY,
        },
        liabilityId: e.liabilityId === "" ? null : e.liabilityId,
      };
    });
}

function formIsValid(v: FormValues): boolean {
  const parsedAmount = Number(v.amount);
  return (
    !!v.name.trim() &&
    !!v.date &&
    !!v.toAccountId &&
    Number.isFinite(parsedAmount) &&
    parsedAmount > 0 &&
    v.adjustments.every(
      (a) =>
        a.name.trim() !== "" &&
        Number.isFinite(Number(a.amount)) &&
        Number(a.amount) >= 0,
    )
  );
}

function PlanningPayslipsDialog() {
  const { year } = Route.useParams();
  const navigate = useNavigate();
  const { data } = useSuspenseQuery(PlanningPayslipsDialogDocument, {
    variables: { year },
  });

  const refetch: RefetchEntry[] = [
    { query: PlanningPayslipsDialogDocument, variables: { year } },
    { query: PlanningYearViewDocument, variables: { id: year } },
  ];

  const payslips: Payslip[] = data.payslips?.edges.map((e) => e.node) ?? [];
  const accounts: AccountOption[] = data.planningYear?.accounts ?? [];
  const liabilities: LiabilityOption[] = (
    data.netWorthCategories?.edges ?? []
  )
    .map((e) => e.node)
    .filter(
      (n): n is LiabilityOption => n.__typename === "NetWorthCategoryLiability",
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
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Payslips</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <ul className="divide-y rounded-md border">
            {payslips.length === 0 && (
              <li className="px-3 py-6 text-center text-sm text-muted-foreground">
                No payslips yet.
              </li>
            )}
            {payslips.map((p) => (
              <PayslipRow
                key={p.id}
                payslip={p}
                accounts={accounts}
                liabilities={liabilities}
                refetch={refetch}
              />
            ))}
          </ul>
          {accounts.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Assign a planning account first so payslips have a landing
              account.
            </p>
          ) : (
            <AddPayslipForm
              accounts={accounts}
              liabilities={liabilities}
              refetch={refetch}
            />
          )}
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

function PayslipRow({
  payslip,
  accounts,
  liabilities,
  refetch,
}: {
  payslip: Payslip;
  accounts: AccountOption[];
  liabilities: LiabilityOption[];
  refetch: RefetchEntry[];
}) {
  const [editing, setEditing] = useState(false);
  const [remove] = useMutation(PlanningPayslipDeleteDocument, {
    refetchQueries: refetch,
  });

  const onDelete = async () => {
    await remove({ variables: { id: payslip.id } });
    toast.success(`Deleted ${payslip.name}`);
  };

  if (editing) {
    return (
      <li className="px-3 py-2">
        <EditPayslipForm
          payslip={payslip}
          accounts={accounts}
          liabilities={liabilities}
          refetch={refetch}
          onDone={() => setEditing(false)}
        />
      </li>
    );
  }

  return (
    <li className="flex items-center gap-2 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-sm font-medium">{payslip.name}</span>
          <Figure
            data={payslip.amountGross}
            className="font-mono text-xs tabular-nums"
          />
        </div>
        <div className="mt-0.5 flex items-baseline justify-between gap-2 text-[11px] text-muted-foreground">
          <span>{formatDate(payslip.date)}</span>
          <span className="truncate">→ {payslip.toAccount.name}</span>
        </div>
        {payslip.adjustments.length > 0 && (
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            {payslip.adjustments.length} adjustment
            {payslip.adjustments.length === 1 ? "" : "s"}
          </div>
        )}
      </div>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setEditing(true)}
        aria-label={`Edit ${payslip.name}`}
      >
        <Pencil className="size-4" />
      </Button>
      <DeleteButton onConfirm={onDelete} />
    </li>
  );
}

function AddPayslipForm({
  accounts,
  liabilities,
  refetch,
}: {
  accounts: AccountOption[];
  liabilities: LiabilityOption[];
  refetch: RefetchEntry[];
}) {
  const [values, setValues] = useState<FormValues>(emptyForm);
  const [create, { loading }] = useMutation(PlanningPayslipCreateDocument, {
    refetchQueries: refetch,
  });
  const disabled = loading || !formIsValid(values);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (disabled) return;
    await create({
      variables: {
        name: values.name.trim(),
        date: values.date,
        amountGross: { amount: Number(values.amount), currency: CURRENCY },
        toAccountId: values.toAccountId,
        adjustments: adjustmentsForMutation(values.adjustments),
      },
    });
    toast.success(`Added ${values.name.trim()}`);
    setValues(emptyForm);
  };

  return (
    <form onSubmit={submit} className="space-y-3 rounded-md border p-3">
      <div className="text-sm font-medium">Add payslip</div>
      <PayslipFormFields
        values={values}
        setValues={setValues}
        accounts={accounts}
        liabilities={liabilities}
      />
      <div className="flex justify-end">
        <Button type="submit" disabled={disabled}>
          Add payslip
        </Button>
      </div>
    </form>
  );
}

function EditPayslipForm({
  payslip,
  accounts,
  liabilities,
  refetch,
  onDone,
}: {
  payslip: Payslip;
  accounts: AccountOption[];
  liabilities: LiabilityOption[];
  refetch: RefetchEntry[];
  onDone: () => void;
}) {
  const [values, setValues] = useState<FormValues>(() => payslipToForm(payslip));
  const [update, { loading }] = useMutation(PlanningPayslipUpdateDocument, {
    refetchQueries: refetch,
  });
  const disabled = loading || !formIsValid(values);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (disabled) return;
    await update({
      variables: {
        id: payslip.id,
        name: values.name.trim(),
        date: values.date,
        amountGross: { amount: Number(values.amount), currency: CURRENCY },
        toAccountId: values.toAccountId,
        adjustments: adjustmentsForMutation(values.adjustments),
      },
    });
    toast.success(`Updated ${values.name.trim()}`);
    onDone();
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="text-sm font-medium">Edit payslip</div>
      <PayslipFormFields
        values={values}
        setValues={setValues}
        accounts={accounts}
        liabilities={liabilities}
      />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={disabled}>
          Save
        </Button>
      </div>
    </form>
  );
}

function PayslipFormFields({
  values,
  setValues,
  accounts,
  liabilities,
}: {
  values: FormValues;
  setValues: React.Dispatch<React.SetStateAction<FormValues>>;
  accounts: AccountOption[];
  liabilities: LiabilityOption[];
}) {
  const patch = (p: Partial<FormValues>) => setValues((v) => ({ ...v, ...p }));
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="Name">
          <Input
            placeholder="e.g. April payslip"
            value={values.name}
            onChange={(e) => patch({ name: e.target.value })}
          />
        </FormField>
        <FormField label="Account">
          <Select
            value={values.toAccountId}
            onValueChange={(v) => patch({ toAccountId: v })}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Pick an account…" />
            </SelectTrigger>
            <SelectContent>
              {accounts.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
        <FormField label="Pay date">
          <Input
            type="date"
            value={values.date}
            onChange={(e) => patch({ date: e.target.value })}
          />
        </FormField>
        <FormField label="Gross">
          <Input
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0"
            currency={CURRENCY}
            value={values.amount}
            onChange={(e) => patch({ amount: e.target.value })}
          />
        </FormField>
      </div>
      <AdjustmentsField
        entries={values.adjustments}
        liabilities={liabilities}
        onChange={(adjustments) => patch({ adjustments })}
      />
    </>
  );
}

function AdjustmentsField({
  entries,
  liabilities,
  onChange,
}: {
  entries: AdjustmentEntry[];
  liabilities: LiabilityOption[];
  onChange: (next: AdjustmentEntry[]) => void;
}) {
  const addEntry = () => {
    onChange([
      ...entries,
      { id: null, name: "", amount: "", sign: "-", liabilityId: "" },
    ]);
  };
  const patchAt = (i: number, p: Partial<AdjustmentEntry>) => {
    onChange(entries.map((e, idx) => (idx === i ? { ...e, ...p } : e)));
  };
  const removeAt = (i: number) => {
    onChange(entries.filter((_, idx) => idx !== i));
  };

  return (
    <details
      className="rounded-md border bg-muted/20 p-2 text-xs"
      open={entries.length > 0}
    >
      <summary className="cursor-pointer font-medium">Adjustments</summary>
      <ul className="mt-2 space-y-2">
        {entries.map((entry, i) => (
          <li key={i} className="flex items-center gap-2">
            <Input
              placeholder="Name (e.g. Income tax)"
              className="flex-1"
              value={entry.name}
              onChange={(e) => patchAt(i, { name: e.target.value })}
            />
            <Select
              value={entry.sign}
              onValueChange={(v) => patchAt(i, { sign: v as "+" | "-" })}
            >
              <SelectTrigger className="w-14 rounded-r-none border-r-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="-">−</SelectItem>
                <SelectItem value="+">+</SelectItem>
              </SelectContent>
            </Select>
            <Input
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              currency={CURRENCY}
              placeholder="Amount"
              className="-ml-2 w-32 rounded-l-none"
              value={entry.amount}
              onChange={(e) => patchAt(i, { amount: e.target.value })}
            />
            <Select
              value={entry.liabilityId === "" ? "__none__" : entry.liabilityId}
              onValueChange={(v) =>
                patchAt(i, { liabilityId: v === "__none__" ? "" : v })
              }
            >
              <SelectTrigger className="w-36">
                <SelectValue placeholder="Liability" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">No liability</SelectItem>
                {liabilities.map((l) => (
                  <SelectItem key={l.id} value={l.id}>
                    {l.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => removeAt(i)}
              aria-label={`Remove adjustment ${i + 1}`}
            >
              <X className="size-4" />
            </Button>
          </li>
        ))}
      </ul>
      <div className="mt-2">
        <Button type="button" variant="outline" size="sm" onClick={addEntry}>
          <Plus className="mr-1 size-3" />
          Add adjustment
        </Button>
      </div>
    </details>
  );
}

function FormField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  );
}

function formatDate(d: string): string {
  return new Date(d).toLocaleDateString(undefined, {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

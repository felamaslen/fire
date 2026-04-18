import { useMutation, useSuspenseQuery } from "@apollo/client/react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Pencil } from "lucide-react";
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

const PlanningBillsDialogDocument = graphql(
  `
    query PlanningBillsDialog($year: ID!) {
      bills(first: 100) {
        edges {
          node {
            id
            name
            start
            end
            frequency
            collectionDate
            amount {
              amount
              currency
              ...Figure
            }
            fromAccount {
              id
              name
            }
            liability {
              id
              name
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

const PlanningBillCreateDocument = graphql(`
  mutation PlanningBillCreate(
    $start: Date!
    $frequency: PlanningBillsFrequency!
    $collectionDate: [String!]!
    $amount: MoneyInput!
    $name: String!
    $fromAccountId: ID!
    $end: Date
    $liabilityId: ID
  ) {
    billCreate(
      start: $start
      frequency: $frequency
      collectionDate: $collectionDate
      amount: $amount
      name: $name
      fromAccountId: $fromAccountId
      end: $end
      liabilityId: $liabilityId
    ) {
      id
    }
  }
`);

const PlanningBillUpdateDocument = graphql(`
  mutation PlanningBillUpdate(
    $id: ID!
    $start: Date
    $frequency: PlanningBillsFrequency
    $collectionDate: [String!]
    $amount: MoneyInput
    $name: String
    $fromAccountId: ID
    $end: Date
    $liabilityId: ID
  ) {
    billUpdate(
      id: $id
      start: $start
      frequency: $frequency
      collectionDate: $collectionDate
      amount: $amount
      name: $name
      fromAccountId: $fromAccountId
      end: $end
      liabilityId: $liabilityId
    ) {
      id
    }
  }
`);

const PlanningBillDeleteDocument = graphql(`
  mutation PlanningBillDelete($id: ID!) {
    billDelete(id: $id) {
      id
    }
  }
`);

export const Route = createFileRoute("/planning/$year/bills")({
  component: PlanningBillsDialog,
});

type PlanningBillsData = ResultOf<typeof PlanningBillsDialogDocument>;
type Bill = NonNullable<
  PlanningBillsData["bills"]
>["edges"][number]["node"];
type AccountOption = NonNullable<
  PlanningBillsData["planningYear"]
>["accounts"][number];
type LiabilityOption = Extract<
  NonNullable<PlanningBillsData["netWorthCategories"]>["edges"][number]["node"],
  { __typename: "NetWorthCategoryLiability" }
>;

type RefetchEntry =
  | { query: typeof PlanningBillsDialogDocument; variables: { year: string } }
  | { query: typeof PlanningYearViewDocument; variables: { id: string } };

type Frequency = "MONTHLY" | "QUARTERLY" | "YEARLY";

type FormValues = {
  name: string;
  fromAccountId: string;
  /** Empty string = no liability linked. */
  liabilityId: string;
  frequency: Frequency;
  /** MONTHLY: one bare day; YEARLY: [month, day]; QUARTERLY: 4× [month, day]. */
  collectionDate: string[];
  amount: string;
  start: string;
  end: string;
};

const CURRENCY = "GBP";

const emptyForm: FormValues = {
  name: "",
  fromAccountId: "",
  liabilityId: "",
  frequency: "MONTHLY",
  collectionDate: ["1"],
  amount: "",
  start: "",
  end: "",
};

function defaultCollectionFor(frequency: Frequency): string[] {
  switch (frequency) {
    case "MONTHLY":
      return ["1"];
    case "YEARLY":
      return ["1-1"];
    case "QUARTERLY":
      return ["1-1", "4-1", "7-1", "10-1"];
  }
}

function billToForm(bill: Bill): FormValues {
  return {
    name: bill.name,
    fromAccountId: bill.fromAccount.id,
    liabilityId: bill.liability?.id ?? "",
    frequency: bill.frequency,
    collectionDate: bill.collectionDate,
    amount: String(bill.amount.amount),
    start: bill.start,
    end: bill.end ?? "",
  };
}

function formIsValid(v: FormValues): boolean {
  const parsedAmount = Number(v.amount);
  const expected = v.frequency === "QUARTERLY" ? 4 : 1;
  const entriesOk =
    v.collectionDate.length === expected &&
    v.collectionDate.every((s) => s.trim() !== "");
  return (
    !!v.name.trim() &&
    !!v.fromAccountId &&
    !!v.start &&
    Number.isFinite(parsedAmount) &&
    parsedAmount > 0 &&
    entriesOk
  );
}

function PlanningBillsDialog() {
  const { year } = Route.useParams();
  const navigate = useNavigate();
  const { data } = useSuspenseQuery(PlanningBillsDialogDocument, {
    variables: { year },
  });

  const refetch: RefetchEntry[] = [
    { query: PlanningBillsDialogDocument, variables: { year } },
    { query: PlanningYearViewDocument, variables: { id: year } },
  ];

  const bills: Bill[] = data.bills?.edges.map((e) => e.node) ?? [];
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
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Bills</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <ul className="divide-y rounded-md border">
            {bills.length === 0 && (
              <li className="px-3 py-6 text-center text-sm text-muted-foreground">
                No bills yet.
              </li>
            )}
            {bills.map((b) => (
              <BillRow
                key={b.id}
                bill={b}
                accounts={accounts}
                liabilities={liabilities}
                refetch={refetch}
              />
            ))}
          </ul>
          {accounts.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Assign a planning account first so bills have somewhere to come
              from.
            </p>
          ) : (
            <AddBillForm
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

function BillRow({
  bill,
  accounts,
  liabilities,
  refetch,
}: {
  bill: Bill;
  accounts: AccountOption[];
  liabilities: LiabilityOption[];
  refetch: RefetchEntry[];
}) {
  const [editing, setEditing] = useState(false);
  const [remove] = useMutation(PlanningBillDeleteDocument, {
    refetchQueries: refetch,
  });

  const onDelete = async () => {
    await remove({ variables: { id: bill.id } });
    toast.success(`Deleted ${bill.name}`);
  };

  if (editing) {
    return (
      <li className="px-3 py-2">
        <EditBillForm
          bill={bill}
          accounts={accounts}
          liabilities={liabilities}
          refetch={refetch}
          onDone={() => setEditing(false)}
        />
      </li>
    );
  }

  const range =
    bill.end == null
      ? `${formatDate(bill.start)} → ongoing`
      : `${formatDate(bill.start)} → ${formatDate(bill.end)}`;

  return (
    <li className="flex items-center gap-2 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-sm font-medium">{bill.name}</span>
          <Figure
            data={bill.amount}
            className="font-mono text-xs tabular-nums"
          />
        </div>
        <div className="mt-0.5 flex items-baseline justify-between gap-2 text-[11px] text-muted-foreground">
          <span>{range}</span>
          <span className="truncate">from {bill.fromAccount.name}</span>
        </div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">
          {formatCadence(bill.frequency, bill.collectionDate)}
        </div>
      </div>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setEditing(true)}
        aria-label={`Edit ${bill.name}`}
      >
        <Pencil className="size-4" />
      </Button>
      <DeleteButton onConfirm={onDelete} />
    </li>
  );
}

function AddBillForm({
  accounts,
  liabilities,
  refetch,
}: {
  accounts: AccountOption[];
  liabilities: LiabilityOption[];
  refetch: RefetchEntry[];
}) {
  const [values, setValues] = useState<FormValues>(emptyForm);
  const [create, { loading }] = useMutation(PlanningBillCreateDocument, {
    refetchQueries: refetch,
  });
  const disabled = loading || !formIsValid(values);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (disabled) return;
    await create({
      variables: {
        name: values.name.trim(),
        fromAccountId: values.fromAccountId,
        liabilityId: values.liabilityId === "" ? null : values.liabilityId,
        frequency: values.frequency,
        collectionDate: values.collectionDate,
        amount: { amount: Number(values.amount), currency: CURRENCY },
        start: values.start,
        end: values.end === "" ? null : values.end,
      },
    });
    toast.success(`Added ${values.name.trim()}`);
    setValues(emptyForm);
  };

  return (
    <form onSubmit={submit} className="space-y-3 rounded-md border p-3">
      <div className="text-sm font-medium">Add bill</div>
      <BillFormFields
        values={values}
        setValues={setValues}
        accounts={accounts}
        liabilities={liabilities}
      />
      <div className="flex justify-end">
        <Button type="submit" disabled={disabled}>
          Add bill
        </Button>
      </div>
    </form>
  );
}

function EditBillForm({
  bill,
  accounts,
  liabilities,
  refetch,
  onDone,
}: {
  bill: Bill;
  accounts: AccountOption[];
  liabilities: LiabilityOption[];
  refetch: RefetchEntry[];
  onDone: () => void;
}) {
  const [values, setValues] = useState<FormValues>(() => billToForm(bill));
  const [update, { loading }] = useMutation(PlanningBillUpdateDocument, {
    refetchQueries: refetch,
  });
  const disabled = loading || !formIsValid(values);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (disabled) return;
    await update({
      variables: {
        id: bill.id,
        name: values.name.trim(),
        fromAccountId: values.fromAccountId,
        liabilityId: values.liabilityId === "" ? null : values.liabilityId,
        frequency: values.frequency,
        collectionDate: values.collectionDate,
        amount: { amount: Number(values.amount), currency: CURRENCY },
        start: values.start,
        end: values.end === "" ? null : values.end,
      },
    });
    toast.success(`Updated ${values.name.trim()}`);
    onDone();
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="text-sm font-medium">Edit bill</div>
      <BillFormFields
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

function BillFormFields({
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
            placeholder="e.g. Broadband"
            value={values.name}
            onChange={(e) => patch({ name: e.target.value })}
          />
        </FormField>
        <FormField label="Paid from">
          <Select
            value={values.fromAccountId}
            onValueChange={(v) => patch({ fromAccountId: v })}
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
        <FormField label="Amount">
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
        <FormField label="Frequency">
          <Select
            value={values.frequency}
            onValueChange={(v) =>
              patch({
                frequency: v as Frequency,
                collectionDate: defaultCollectionFor(v as Frequency),
              })
            }
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="MONTHLY">Monthly</SelectItem>
              <SelectItem value="QUARTERLY">Quarterly</SelectItem>
              <SelectItem value="YEARLY">Yearly</SelectItem>
            </SelectContent>
          </Select>
        </FormField>
        <FormField label="Start">
          <Input
            type="date"
            value={values.start}
            onChange={(e) => patch({ start: e.target.value })}
          />
        </FormField>
        <FormField label="End (optional)">
          <Input
            type="date"
            value={values.end}
            onChange={(e) => patch({ end: e.target.value })}
          />
        </FormField>
        <FormField label="Linked liability (optional)">
          <Select
            value={values.liabilityId === "" ? "__none__" : values.liabilityId}
            onValueChange={(v) =>
              patch({ liabilityId: v === "__none__" ? "" : v })
            }
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="No liability" />
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
        </FormField>
      </div>
      <CollectionDateField
        frequency={values.frequency}
        entries={values.collectionDate}
        onChange={(collectionDate) => patch({ collectionDate })}
      />
    </>
  );
}

function CollectionDateField({
  frequency,
  entries,
  onChange,
}: {
  frequency: Frequency;
  entries: string[];
  onChange: (entries: string[]) => void;
}) {
  if (frequency === "MONTHLY") {
    return (
      <FormField label="Day of month">
        <Input
          type="number"
          min="1"
          max="31"
          className="w-28"
          value={entries[0] ?? ""}
          onChange={(e) => onChange([e.target.value])}
        />
      </FormField>
    );
  }
  if (frequency === "YEARLY") {
    const [month = "", day = ""] = (entries[0] ?? "-").split("-");
    const set = (m: string, d: string) => onChange([`${m}-${d}`]);
    return (
      <FormField label="Month / day">
        <div className="flex gap-2">
          <MonthSelect
            value={month}
            onChange={(m) => set(m, day)}
            className="w-40"
          />
          <Input
            type="number"
            min="1"
            max="31"
            placeholder="Day"
            className="w-24"
            value={day}
            onChange={(e) => set(month, e.target.value)}
          />
        </div>
      </FormField>
    );
  }
  // QUARTERLY — four `M-D` entries.
  return (
    <FormField label="Quarterly collection dates">
      <div className="grid gap-2 sm:grid-cols-2">
        {[0, 1, 2, 3].map((i) => {
          const [month = "", day = ""] = (entries[i] ?? "-").split("-");
          const set = (m: string, d: string) => {
            const next = [...entries];
            next[i] = `${m}-${d}`;
            onChange(next);
          };
          return (
            <div key={i} className="flex items-center gap-2">
              <span className="text-[10px] uppercase text-muted-foreground">
                Q{i + 1}
              </span>
              <MonthSelect
                value={month}
                onChange={(m) => set(m, day)}
                className="flex-1"
              />
              <Input
                type="number"
                min="1"
                max="31"
                placeholder="D"
                className="w-16"
                value={day}
                onChange={(e) => set(month, e.target.value)}
              />
            </div>
          );
        })}
      </div>
    </FormField>
  );
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function MonthSelect({
  value,
  onChange,
  className,
}: {
  value: string;
  onChange: (m: string) => void;
  className?: string;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className={className}>
        <SelectValue placeholder="Month" />
      </SelectTrigger>
      <SelectContent>
        {MONTH_NAMES.map((name, i) => (
          <SelectItem key={i} value={String(i + 1)}>
            {name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
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

function formatCadence(frequency: Frequency, entries: string[]): string {
  switch (frequency) {
    case "MONTHLY":
      return `Monthly on the ${ordinal(Number(entries[0]))}`;
    case "YEARLY":
      return `Yearly on ${formatMD(entries[0])}`;
    case "QUARTERLY":
      return `Quarterly on ${entries.map(formatMD).join(", ")}`;
  }
}

function formatMD(s: string): string {
  const [m, d] = s.split("-").map(Number);
  if (!m || !d) return s;
  const date = new Date(Date.UTC(2000, m - 1, d));
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function ordinal(n: number): string {
  if (!Number.isFinite(n)) return "";
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

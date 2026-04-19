import { useMutation, useSuspenseQuery } from "@apollo/client/react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { addDays, formatISO, parseISO } from "date-fns";
import { Pencil, Plus, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { DeleteButton } from "@/components/delete-button";
import { Figure, FigureDocument } from "@/components/figure";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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

const PlanningEarningsDialogDocument = graphql(
  `
    query PlanningEarningsDialog($year: ID!) {
      earnings(first: 100) {
        edges {
          node {
            id
            name
            start
            end
            amountGross {
              amount
              currency
              ...Figure
            }
            attributes
            pensionReliefAtSource
            pensionNetPay
            pensionSalarySacrifice
            studentLoanPlan2
            studentLoanLiability {
              id
              name
            }
            ukTaxCodes {
              start
              end
              taxCode
            }
            toAccount {
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

const PlanningEarningsCreateDocument = graphql(`
  mutation PlanningEarningsCreate(
    $name: String!
    $start: Date!
    $amountGross: MoneyInput!
    $countryCode: String!
    $toAccountId: ID!
    $end: Date
    $pensionReliefAtSource: Float
    $pensionNetPay: Float
    $pensionSalarySacrifice: Float
    $studentLoanPlan2: Boolean
    $studentLoanLiabilityId: ID
    $ukTaxCodes: [PlanningEarningUKTaxCodeInput!]
  ) {
    earningsCreate(
      name: $name
      start: $start
      amountGross: $amountGross
      countryCode: $countryCode
      pensionReliefAtSource: $pensionReliefAtSource
      pensionNetPay: $pensionNetPay
      toAccountId: $toAccountId
      end: $end
      pensionSalarySacrifice: $pensionSalarySacrifice
      studentLoanPlan2: $studentLoanPlan2
      studentLoanLiabilityId: $studentLoanLiabilityId
      ukTaxCodes: $ukTaxCodes
    ) {
      id
    }
  }
`);

const PlanningEarningsUpdateDocument = graphql(`
  mutation PlanningEarningsUpdate(
    $id: ID!
    $name: String
    $start: Date
    $amountGross: MoneyInput
    $pensionReliefAtSource: Float
    $pensionNetPay: Float
    $toAccountId: ID
    $end: Date
    $pensionSalarySacrifice: Float
    $studentLoanPlan2: Boolean
    $studentLoanLiabilityId: ID
    $ukTaxCodes: [PlanningEarningUKTaxCodeInput!]
  ) {
    earningsUpdate(
      id: $id
      name: $name
      start: $start
      amountGross: $amountGross
      pensionReliefAtSource: $pensionReliefAtSource
      pensionNetPay: $pensionNetPay
      toAccountId: $toAccountId
      end: $end
      pensionSalarySacrifice: $pensionSalarySacrifice
      studentLoanPlan2: $studentLoanPlan2
      studentLoanLiabilityId: $studentLoanLiabilityId
      ukTaxCodes: $ukTaxCodes
    ) {
      id
    }
  }
`);

const PlanningEarningsDeleteDocument = graphql(`
  mutation PlanningEarningsDelete($id: ID!) {
    earningsDelete(id: $id) {
      _
    }
  }
`);

export const Route = createFileRoute("/planning/$year/earnings")({
  component: PlanningEarningsDialog,
});

type PlanningEarningsData = ResultOf<typeof PlanningEarningsDialogDocument>;
type Earning = NonNullable<
  PlanningEarningsData["earnings"]
>["edges"][number]["node"];
type AccountOption = NonNullable<
  PlanningEarningsData["planningYear"]
>["accounts"][number];
type LiabilityOption = Extract<
  NonNullable<
    PlanningEarningsData["netWorthCategories"]
  >["edges"][number]["node"],
  { __typename: "NetWorthCategoryLiability" }
>;

type RefetchEntry =
  | {
      query: typeof PlanningEarningsDialogDocument;
      variables: { year: string };
    }
  | { query: typeof PlanningYearViewDocument; variables: { id: string } };

/** Percentage-shaped form values (0–100 strings) for the three pension rates
 * plus the amount and top-level fields. Stored as strings so empty inputs
 * don't coerce to 0. */
/** One entry in the user-facing tax-code timeline. `start` is computed on
 * submit (first entry = earning.start, later entries = previous.end), so the
 * form only tracks the code + its end date. */
type TaxCodeEntry = { taxCode: string; end: string };

type FormValues = {
  name: string;
  start: string;
  end: string;
  amount: string;
  toAccountId: string;
  pensionReliefAtSourcePct: string;
  pensionNetPayPct: string;
  pensionSalarySacrificePct: string;
  studentLoanPlan2: boolean;
  /** Empty string = no liability linked. Only meaningful when `studentLoanPlan2` is true. */
  studentLoanLiabilityId: string;
  taxCodes: TaxCodeEntry[];
};

const emptyForm: FormValues = {
  name: "",
  start: "",
  end: "",
  amount: "",
  toAccountId: "",
  pensionReliefAtSourcePct: "",
  pensionNetPayPct: "",
  pensionSalarySacrificePct: "",
  studentLoanPlan2: false,
  studentLoanLiabilityId: "",
  taxCodes: [],
};

function earningToForm(earning: Earning): FormValues {
  return {
    name: earning.name,
    start: earning.start,
    end: earning.end ?? "",
    amount: String(earning.amountGross.amount),
    toAccountId: earning.toAccount.id,
    pensionReliefAtSourcePct:
      earning.pensionReliefAtSource == null
        ? ""
        : String(earning.pensionReliefAtSource * 100),
    pensionNetPayPct:
      earning.pensionNetPay == null ? "" : String(earning.pensionNetPay * 100),
    pensionSalarySacrificePct:
      earning.pensionSalarySacrifice == null
        ? ""
        : String(earning.pensionSalarySacrifice * 100),
    studentLoanPlan2: earning.studentLoanPlan2 ?? false,
    studentLoanLiabilityId: earning.studentLoanLiability?.id ?? "",
    // Codes arrive unsorted; chain them by start date.
    taxCodes: [...earning.ukTaxCodes]
      .sort((a, b) => a.start.localeCompare(b.start))
      .map((c) => ({ taxCode: c.taxCode, end: c.end ?? "" })),
  };
}

/** Build the `PlanningEarningUKTaxCodeInput[]` the backend expects from the
 * form's entries: each row's `start` is the earning's start for the first
 * row, and `previous.end + 1 day` for every subsequent row (so the periods
 * abut without overlapping). */
function taxCodesForMutation(
  earningStart: string,
  entries: TaxCodeEntry[],
): { start: string; end: string | null; taxCode: string }[] {
  return entries
    .filter((e) => e.taxCode.trim() !== "")
    .map((e, i, arr) => ({
      start: i === 0 ? earningStart : dayAfter(arr[i - 1].end),
      end: e.end === "" ? null : e.end,
      taxCode: e.taxCode.trim(),
    }));
}

/** `YYYY-MM-DD` → the following calendar day in the same format. */
function dayAfter(iso: string): string {
  return formatISO(addDays(parseISO(iso), 1), { representation: "date" });
}

const CURRENCY = "GBP";

function formIsValid(values: FormValues): boolean {
  const parsedAmount = Number(values.amount);
  return (
    !!values.name.trim() &&
    !!values.start &&
    !!values.toAccountId &&
    Number.isFinite(parsedAmount) &&
    parsedAmount > 0
  );
}

function PlanningEarningsDialog() {
  const { year } = Route.useParams();
  const navigate = useNavigate();
  const { data } = useSuspenseQuery(PlanningEarningsDialogDocument, {
    variables: { year },
  });

  const refetch: RefetchEntry[] = [
    { query: PlanningEarningsDialogDocument, variables: { year } },
    { query: PlanningYearViewDocument, variables: { id: year } },
  ];

  const earnings: Earning[] = data.earnings?.edges.map((e) => e.node) ?? [];
  const accounts: AccountOption[] = data.planningYear?.accounts ?? [];
  const liabilities: LiabilityOption[] = (data.netWorthCategories?.edges ?? [])
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
          <DialogTitle>Earnings</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <ul className="divide-y rounded-md border">
            {earnings.length === 0 && (
              <li className="px-3 py-6 text-center text-sm text-muted-foreground">
                No earnings yet.
              </li>
            )}
            {earnings.map((e) => (
              <EarningRow
                key={e.id}
                earning={e}
                accounts={accounts}
                liabilities={liabilities}
                refetch={refetch}
              />
            ))}
          </ul>
          {accounts.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Assign a planning account first so earnings have somewhere to
              land.
            </p>
          ) : (
            <AddEarningForm
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

function EarningRow({
  earning,
  accounts,
  liabilities,
  refetch,
}: {
  earning: Earning;
  accounts: AccountOption[];
  liabilities: LiabilityOption[];
  refetch: RefetchEntry[];
}) {
  const [editing, setEditing] = useState(false);
  const [remove] = useMutation(PlanningEarningsDeleteDocument, {
    refetchQueries: refetch,
  });

  const onDelete = async () => {
    await remove({ variables: { id: earning.id } });
    toast.success(`Deleted ${earning.name}`);
  };

  if (editing) {
    return (
      <li className="px-3 py-2">
        <EditEarningForm
          earning={earning}
          accounts={accounts}
          liabilities={liabilities}
          refetch={refetch}
          onDone={() => setEditing(false)}
        />
      </li>
    );
  }

  const range =
    earning.end == null
      ? `${formatDate(earning.start)} → ongoing`
      : `${formatDate(earning.start)} → ${formatDate(earning.end)}`;

  return (
    <li className="flex items-center gap-2 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-sm font-medium">{earning.name}</span>
          <Figure
            data={earning.amountGross}
            className="font-mono text-xs tabular-nums"
          />
        </div>
        <div className="mt-0.5 flex items-baseline justify-between gap-2 text-[11px] text-muted-foreground">
          <span>{range}</span>
          <span className="truncate">→ {earning.toAccount.name}</span>
        </div>
        {earning.attributes && (
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            {earning.attributes}
          </div>
        )}
      </div>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setEditing(true)}
        aria-label={`Edit ${earning.name}`}
      >
        <Pencil className="size-4" />
      </Button>
      <DeleteButton onConfirm={onDelete} />
    </li>
  );
}

function AddEarningForm({
  accounts,
  liabilities,
  refetch,
}: {
  accounts: AccountOption[];
  liabilities: LiabilityOption[];
  refetch: RefetchEntry[];
}) {
  const [values, setValues] = useState<FormValues>(emptyForm);
  const [create, { loading }] = useMutation(PlanningEarningsCreateDocument, {
    refetchQueries: refetch,
  });

  const disabled = loading || !formIsValid(values);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (disabled) return;
    await create({
      variables: {
        name: values.name.trim(),
        start: values.start,
        end: values.end === "" ? null : values.end,
        amountGross: { amount: Number(values.amount), currency: CURRENCY },
        countryCode: "GB",
        pensionReliefAtSource:
          values.pensionReliefAtSourcePct.trim() === ""
            ? null
            : pctToFraction(values.pensionReliefAtSourcePct),
        pensionNetPay:
          values.pensionNetPayPct.trim() === ""
            ? null
            : pctToFraction(values.pensionNetPayPct),
        pensionSalarySacrifice:
          values.pensionSalarySacrificePct.trim() === ""
            ? null
            : pctToFraction(values.pensionSalarySacrificePct),
        studentLoanPlan2: values.studentLoanPlan2,
        studentLoanLiabilityId:
          values.studentLoanPlan2 && values.studentLoanLiabilityId !== ""
            ? values.studentLoanLiabilityId
            : null,
        toAccountId: values.toAccountId,
        ukTaxCodes: taxCodesForMutation(values.start, values.taxCodes),
      },
    });
    toast.success(`Added ${values.name.trim()}`);
    setValues(emptyForm);
  };

  return (
    <form onSubmit={submit} className="space-y-3 rounded-md border p-3">
      <div className="text-sm font-medium">Add earning</div>
      <EarningFormFields
        values={values}
        setValues={setValues}
        accounts={accounts}
        liabilities={liabilities}
      />
      <div className="flex justify-end">
        <Button type="submit" disabled={disabled}>
          Add earning
        </Button>
      </div>
    </form>
  );
}

function EditEarningForm({
  earning,
  accounts,
  liabilities,
  refetch,
  onDone,
}: {
  earning: Earning;
  accounts: AccountOption[];
  liabilities: LiabilityOption[];
  refetch: RefetchEntry[];
  onDone: () => void;
}) {
  const [values, setValues] = useState<FormValues>(() =>
    earningToForm(earning),
  );
  const [update, { loading }] = useMutation(PlanningEarningsUpdateDocument, {
    refetchQueries: refetch,
  });

  const disabled = loading || !formIsValid(values);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (disabled) return;
    await update({
      variables: {
        id: earning.id,
        name: values.name.trim(),
        start: values.start,
        end: values.end === "" ? null : values.end,
        amountGross: { amount: Number(values.amount), currency: CURRENCY },
        pensionReliefAtSource:
          values.pensionReliefAtSourcePct.trim() === ""
            ? null
            : pctToFraction(values.pensionReliefAtSourcePct),
        pensionNetPay:
          values.pensionNetPayPct.trim() === ""
            ? null
            : pctToFraction(values.pensionNetPayPct),
        pensionSalarySacrifice:
          values.pensionSalarySacrificePct.trim() === ""
            ? null
            : pctToFraction(values.pensionSalarySacrificePct),
        studentLoanPlan2: values.studentLoanPlan2,
        studentLoanLiabilityId: values.studentLoanPlan2
          ? values.studentLoanLiabilityId === ""
            ? null
            : values.studentLoanLiabilityId
          : null,
        toAccountId: values.toAccountId,
        ukTaxCodes: taxCodesForMutation(values.start, values.taxCodes),
      },
    });
    toast.success(`Updated ${values.name.trim()}`);
    onDone();
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="text-sm font-medium">Edit earning</div>
      <EarningFormFields
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

function EarningFormFields({
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
            placeholder="e.g. Day job"
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
        <FormField label="Gross (per year)">
          <Input
            type="number"
            inputMode="decimal"
            step="0.01"
            currency={CURRENCY}
            value={values.amount}
            onChange={(e) => patch({ amount: e.target.value })}
          />
        </FormField>
      </div>
      <details className="rounded-md border bg-muted/20 p-2 text-xs">
        <summary className="cursor-pointer font-medium">
          Pension & student loan
        </summary>
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          <FormField label="Relief at source">
            <PercentInput
              value={values.pensionReliefAtSourcePct}
              onChange={(v) => patch({ pensionReliefAtSourcePct: v })}
              placeholder="(none)"
            />
          </FormField>
          <FormField label="Net pay">
            <PercentInput
              value={values.pensionNetPayPct}
              onChange={(v) => patch({ pensionNetPayPct: v })}
              placeholder="(none)"
            />
          </FormField>
          <FormField label="Salary sacrifice">
            <PercentInput
              value={values.pensionSalarySacrificePct}
              onChange={(v) => patch({ pensionSalarySacrificePct: v })}
              placeholder="(none)"
            />
          </FormField>
        </div>
        <label className="mt-2 flex items-center gap-2">
          <Checkbox
            checked={values.studentLoanPlan2}
            onCheckedChange={(v) => {
              const next = v === true;
              // Clear any linked liability when plan 2 is disabled — the
              // backend rejects the pair.
              patch({
                studentLoanPlan2: next,
                ...(next ? {} : { studentLoanLiabilityId: "" }),
              });
            }}
          />
          <span>Repaying Student Loan plan 2</span>
        </label>
        {values.studentLoanPlan2 && (
          <div className="mt-2 space-y-1">
            <Label className="text-xs">Linked liability (optional)</Label>
            <Select
              value={
                values.studentLoanLiabilityId === ""
                  ? "__none__"
                  : values.studentLoanLiabilityId
              }
              onValueChange={(v) =>
                patch({
                  studentLoanLiabilityId: v === "__none__" ? "" : v,
                })
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
          </div>
        )}
      </details>
      <UKTaxCodesField
        earningStart={values.start}
        entries={values.taxCodes}
        onChange={(taxCodes) => patch({ taxCodes })}
      />
    </>
  );
}

function UKTaxCodesField({
  earningStart,
  entries,
  onChange,
}: {
  earningStart: string;
  entries: TaxCodeEntry[];
  onChange: (next: TaxCodeEntry[]) => void;
}) {
  // New entries are only allowed once the last one has an end date — otherwise
  // we couldn't compute the new entry's start.
  const lastEnd = entries[entries.length - 1]?.end ?? "";
  const canAdd = !!earningStart && (entries.length === 0 || lastEnd !== "");

  const addEntry = () => {
    onChange([...entries, { taxCode: "", end: "" }]);
  };
  const patchAt = (i: number, p: Partial<TaxCodeEntry>) => {
    onChange(entries.map((e, idx) => (idx === i ? { ...e, ...p } : e)));
  };
  const removeAt = (i: number) => {
    onChange(entries.filter((_, idx) => idx !== i));
  };

  return (
    <details className="rounded-md border bg-muted/20 p-2 text-xs">
      <summary className="cursor-pointer font-medium">UK tax codes</summary>
      <ul className="mt-2 space-y-2">
        {entries.map((entry, i) => {
          const prevEnd = entries[i - 1]?.end;
          const start =
            i === 0 ? earningStart : prevEnd ? dayAfter(prevEnd) : "";
          const isLast = i === entries.length - 1;
          return (
            <li key={i} className="flex items-end gap-2">
              <FormField label="From">
                <Input
                  type="date"
                  value={start}
                  readOnly
                  className="h-9 bg-muted"
                />
              </FormField>
              <FormField label="To">
                <Input
                  type="date"
                  value={entry.end}
                  onChange={(e) => patchAt(i, { end: e.target.value })}
                  // The final entry can stay open-ended; earlier ones must
                  // carry an end date since they're the start of the next.
                  required={!isLast}
                  placeholder={isLast ? "(ongoing)" : undefined}
                />
              </FormField>
              <FormField label="Code">
                <Input
                  placeholder="1257L"
                  value={entry.taxCode}
                  onChange={(e) => patchAt(i, { taxCode: e.target.value })}
                />
              </FormField>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => removeAt(i)}
                aria-label={`Remove tax code ${i + 1}`}
              >
                <X className="size-4" />
              </Button>
            </li>
          );
        })}
      </ul>
      <div className="mt-2 flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!canAdd}
          onClick={addEntry}
        >
          <Plus className="mr-1 size-3" />
          Add tax code
        </Button>
        {!earningStart && (
          <span className="text-muted-foreground">
            Pick a start date first.
          </span>
        )}
        {earningStart && entries.length > 0 && lastEnd === "" && (
          <span className="text-muted-foreground">
            Set the last entry's end date to add another.
          </span>
        )}
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

function PercentInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <Input
      type="number"
      inputMode="decimal"
      step="0.1"
      min="0"
      max="100"
      endAdornment="%"
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function pctToFraction(v: string): number {
  return (Number(v) || 0) / 100;
}

function formatDate(d: string): string {
  return new Date(d).toLocaleDateString(undefined, {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

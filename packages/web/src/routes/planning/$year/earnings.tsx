import { useMutation, useSuspenseQuery } from "@apollo/client/react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
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
    $pensionReliefAtSource: Float!
    $pensionNetPay: Float!
    $toAccountId: ID!
    $end: Date
    $pensionSalarySacrifice: Float
    $studentLoanPlan2: Boolean
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
    ) {
      id
    }
  }
`);

const PlanningEarningsDeleteDocument = graphql(`
  mutation PlanningEarningsDelete($id: ID!) {
    earningsDelete(id: $id) {
      id
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

type RefetchEntry =
  | {
      query: typeof PlanningEarningsDialogDocument;
      variables: { year: string };
    }
  | { query: typeof PlanningYearViewDocument; variables: { id: string } };

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
              <EarningRow key={e.id} earning={e} refetch={refetch} />
            ))}
          </ul>
          {accounts.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Assign a planning account first so earnings have somewhere to land.
            </p>
          ) : (
            <AddEarningForm accounts={accounts} refetch={refetch} />
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
  refetch,
}: {
  earning: Earning;
  refetch: RefetchEntry[];
}) {
  const [remove] = useMutation(PlanningEarningsDeleteDocument, {
    refetchQueries: refetch,
  });

  const onDelete = async () => {
    await remove({ variables: { id: earning.id } });
    toast.success(`Deleted ${earning.name}`);
  };

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
      <DeleteButton onConfirm={onDelete} />
    </li>
  );
}

function AddEarningForm({
  accounts,
  refetch,
}: {
  accounts: AccountOption[];
  refetch: RefetchEntry[];
}) {
  const [name, setName] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [amount, setAmount] = useState("");
  const [currency] = useState("GBP");
  const [toAccountId, setToAccountId] = useState("");
  const [pensionReliefAtSource, setPensionReliefAtSource] = useState("0");
  const [pensionNetPay, setPensionNetPay] = useState("0");
  const [pensionSalarySacrifice, setPensionSalarySacrifice] = useState("");
  const [studentLoanPlan2, setStudentLoanPlan2] = useState(false);

  const [create, { loading }] = useMutation(PlanningEarningsCreateDocument, {
    refetchQueries: refetch,
  });

  const parsedAmount = Number(amount);
  const disabled =
    loading ||
    !name.trim() ||
    !start ||
    !toAccountId ||
    !Number.isFinite(parsedAmount) ||
    parsedAmount <= 0;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (disabled) return;
    // Pension inputs are entered as 0-100 percentages; backend expects
    // 0-1 fractions.
    const relief = (Number(pensionReliefAtSource) || 0) / 100;
    const netPay = (Number(pensionNetPay) || 0) / 100;
    const salSac =
      pensionSalarySacrifice.trim() === ""
        ? null
        : Number(pensionSalarySacrifice) / 100;
    await create({
      variables: {
        name: name.trim(),
        start,
        end: end === "" ? null : end,
        amountGross: { amount: parsedAmount, currency },
        countryCode: "GB",
        pensionReliefAtSource: relief,
        pensionNetPay: netPay,
        pensionSalarySacrifice: salSac,
        studentLoanPlan2,
        toAccountId,
      },
    });
    toast.success(`Added ${name.trim()}`);
    setName("");
    setStart("");
    setEnd("");
    setAmount("");
    setPensionReliefAtSource("0");
    setPensionNetPay("0");
    setPensionSalarySacrifice("");
    setStudentLoanPlan2(false);
  };

  return (
    <form onSubmit={submit} className="space-y-3 rounded-md border p-3">
      <div className="text-sm font-medium">Add earning</div>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="Name">
          <Input
            placeholder="e.g. Day job"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </FormField>
        <FormField label="Account">
          <Select value={toAccountId} onValueChange={setToAccountId}>
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
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </FormField>
        <FormField label="End (optional)">
          <Input
            type="date"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
          />
        </FormField>
        <FormField label="Gross (per year)">
          <Input
            type="number"
            inputMode="decimal"
            step="0.01"
            currency={currency}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
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
              value={pensionReliefAtSource}
              onChange={setPensionReliefAtSource}
            />
          </FormField>
          <FormField label="Net pay">
            <PercentInput
              value={pensionNetPay}
              onChange={setPensionNetPay}
            />
          </FormField>
          <FormField label="Salary sacrifice">
            <PercentInput
              value={pensionSalarySacrifice}
              onChange={setPensionSalarySacrifice}
              placeholder="(none)"
            />
          </FormField>
        </div>
        <label className="mt-2 flex items-center gap-2">
          <Checkbox
            checked={studentLoanPlan2}
            onCheckedChange={(v) => setStudentLoanPlan2(v === true)}
          />
          <span>Repaying Student Loan plan 2</span>
        </label>
      </details>
      <div className="flex justify-end">
        <Button type="submit" disabled={disabled}>
          Add earning
        </Button>
      </div>
    </form>
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

function formatDate(d: string): string {
  return new Date(d).toLocaleDateString(undefined, {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

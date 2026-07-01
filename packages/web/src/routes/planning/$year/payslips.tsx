import { useMutation, useQuery, useSuspenseQuery } from "@apollo/client/react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  FileX,
  Loader2,
  Paperclip,
  Pencil,
  Plus,
  Sparkles,
  Upload,
  X,
} from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";

import { DeleteButton } from "@/components/delete-button";
import { Figure, FigureDocument } from "@/components/figure";
import { PdfPreviewDialog } from "@/components/pdf-preview-dialog";
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { resolveFileUrl } from "@/lib/files-origin";

import { graphql, type ResultOf } from "../../../graphql";
import { PlanningYearViewDocument } from "../$year";

const PlanningPayslipsDialogDocument = graphql(`
  query PlanningPayslipsDialog($year: ID!) {
    planningYear(id: $year) {
      id
      accounts {
        id
        name
      }
    }
    me {
      isDemo
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
`);

const PlanningPayslipsByYearDocument = graphql(
  `
    query PlanningPayslipsByYear($year: Int!) {
      payslipsByYear(year: $year) {
        month
        payslips {
          id
          name
          date
          amountGross {
            amount
            currency
          }
          amountGrossAdjusted {
            ...Figure
          }
          amountNet {
            ...Figure
          }
          fileUrl
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
  `,
  [FigureDocument],
);

export const PlanningPayslipCreateDocument = graphql(`
  mutation PlanningPayslipCreate(
    $date: Date!
    $amountGross: MoneyInput!
    $name: String!
    $toAccountId: ID!
    $adjustments: [PayslipAdjustmentInput!]
    $file: Upload
  ) {
    payslipCreate(
      date: $date
      amountGross: $amountGross
      name: $name
      toAccountId: $toAccountId
      adjustments: $adjustments
      file: $file
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
    $file: Upload
  ) {
    payslipUpdate(
      id: $id
      date: $date
      amountGross: $amountGross
      name: $name
      toAccountId: $toAccountId
      adjustments: $adjustments
      file: $file
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

export const PlanningPayslipParseDocument = graphql(`
  mutation PlanningPayslipParse($file: Upload!) {
    payslipParse(file: $file) {
      gross {
        amount
        currency
      }
      date
      suggestedName
      suggestedAccount {
        id
      }
      employeeFirstName
      adjustments {
        name
        amount {
          amount
          currency
        }
        liability {
          id
        }
      }
    }
  }
`);

const payslipsSearchSchema = z.object({
  year: z.coerce.number().int().optional().catch(undefined),
});

export const Route = createFileRoute("/planning/$year/payslips")({
  component: PlanningPayslipsDialog,
  validateSearch: payslipsSearchSchema,
});

type PlanningPayslipsData = ResultOf<typeof PlanningPayslipsDialogDocument>;
type PlanningPayslipsByYearData = ResultOf<
  typeof PlanningPayslipsByYearDocument
>;
type MonthBucket = NonNullable<
  PlanningPayslipsByYearData["payslipsByYear"]
>[number];
type Payslip = MonthBucket["payslips"][number];
export type AccountOption = NonNullable<
  PlanningPayslipsData["planningYear"]
>["accounts"][number];
export type LiabilityOption = Extract<
  NonNullable<
    PlanningPayslipsData["netWorthCategories"]
  >["edges"][number]["node"],
  { __typename: "NetWorthCategoryLiability" }
>;

type RefetchEntry =
  | {
      query: typeof PlanningPayslipsByYearDocument;
      variables: { year: number };
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

export type FormValues = {
  name: string;
  date: string;
  amount: string;
  toAccountId: string;
  adjustments: AdjustmentEntry[];
  file: File | null;
};

export const CURRENCY = "GBP";

const emptyForm: FormValues = {
  name: "",
  date: "",
  amount: "",
  toAccountId: "",
  adjustments: [],
  file: null,
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
    file: null,
  };
}

export function adjustmentsForMutation(entries: AdjustmentEntry[]) {
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

export function formIsValid(v: FormValues): boolean {
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
  const search = Route.useSearch();
  const navigate = useNavigate();
  const fallbackYear = Number.parseInt(year, 10);
  const viewYear =
    search.year ??
    (Number.isFinite(fallbackYear)
      ? fallbackYear
      : new Date().getUTCFullYear());
  const setViewYear = (next: number) =>
    void navigate({
      to: "/planning/$year/payslips",
      params: { year },
      search: { year: next },
      replace: true,
    });
  const { data } = useSuspenseQuery(PlanningPayslipsDialogDocument, {
    variables: { year },
  });
  const accounts: AccountOption[] = data.planningYear?.accounts ?? [];
  const liabilities: LiabilityOption[] = (data.netWorthCategories?.edges ?? [])
    .map((e) => e.node)
    .filter(
      (n): n is LiabilityOption => n.__typename === "NetWorthCategoryLiability",
    );

  const refetch: RefetchEntry[] = [
    {
      query: PlanningPayslipsByYearDocument,
      variables: { year: viewYear },
    },
    { query: PlanningYearViewDocument, variables: { id: year } },
  ];

  const close = () =>
    void navigate({ to: "/planning/$year", params: { year } });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Payslips</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          {accounts.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Assign a planning account first so payslips have a landing
              account.
            </p>
          ) : (
            <PayslipParseDropZone
              accounts={accounts}
              isDemo={!!data.me?.isDemo}
              liabilities={liabilities}
              refetch={refetch}
            />
          )}
          <PayslipsYearGrid
            viewYear={viewYear}
            setViewYear={setViewYear}
            accounts={accounts}
            liabilities={liabilities}
          />
          {accounts.length > 0 && (
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

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function PayslipsYearGrid({
  viewYear,
  setViewYear,
  accounts,
  liabilities,
}: {
  viewYear: number;
  setViewYear: (next: number) => void;
  accounts: AccountOption[];
  liabilities: LiabilityOption[];
}) {
  const variables = { year: viewYear };
  // Non-suspending so switching years keeps the previous data on screen
  // (dimmed) instead of re-mounting via a Suspense fallback.
  const { data, previousData, loading } = useQuery(
    PlanningPayslipsByYearDocument,
    { variables },
  );
  const effective = data ?? previousData;

  const refetch: RefetchEntry[] = [
    { query: PlanningPayslipsByYearDocument, variables },
  ];

  const months: MonthBucket[] = effective?.payslipsByYear ?? [];
  const dim = loading && effective != null;
  const initialLoad = loading && effective == null;

  return (
    <div className="relative rounded-md border">
      <div className="flex items-center justify-between border-b px-2 py-1.5">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setViewYear(viewYear - 1)}
          aria-label="Previous year"
        >
          ← {viewYear - 1}
        </Button>
        <span className="text-sm font-medium tabular-nums">{viewYear}</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setViewYear(viewYear + 1)}
          aria-label="Next year"
        >
          {viewYear + 1} →
        </Button>
      </div>
      <ul
        className={`divide-y transition-opacity ${
          dim ? "pointer-events-none opacity-50" : ""
        }`}
      >
        {(initialLoad
          ? Array.from({ length: 12 }, (_, i) => ({
              month: i + 1,
              payslips: [] as Payslip[],
            }))
          : months
        ).map((m) => (
          <li
            key={m.month}
            className={`flex min-h-16 items-stretch gap-2 px-3 py-2 ${
              m.payslips.length === 0 ? "bg-muted/30" : ""
            }`}
          >
            <div className="w-10 shrink-0 self-center text-xs font-medium text-muted-foreground tabular-nums">
              {MONTH_NAMES[m.month - 1]}
            </div>
            <div className="flex flex-1 flex-wrap gap-2">
              {m.payslips.map((p) => (
                <PayslipCard
                  key={p.id}
                  payslip={p}
                  accounts={accounts}
                  liabilities={liabilities}
                  refetch={refetch}
                />
              ))}
            </div>
          </li>
        ))}
      </ul>
      {initialLoad && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      )}
    </div>
  );
}

function PayslipCard({
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
  const [dragging, setDragging] = useState(false);
  const [remove] = useMutation(PlanningPayslipDeleteDocument, {
    refetchQueries: refetch,
  });
  const [update] = useMutation(PlanningPayslipUpdateDocument, {
    refetchQueries: refetch,
  });
  const quickInputId = useId();

  const onDelete = async () => {
    await remove({ variables: { id: payslip.id } });
    toast.success(`Deleted ${payslip.name}`);
  };

  const uploadFile = async (file: File) => {
    if (
      file.type !== "application/pdf" &&
      !file.name.toLowerCase().endsWith(".pdf")
    ) {
      toast.error("Only PDF files are supported.");
      return;
    }
    await update({ variables: { id: payslip.id, file } });
    toast.success(
      payslip.fileUrl
        ? `Replaced file for ${payslip.name}`
        : `Uploaded file for ${payslip.name}`,
    );
  };

  // Dragging onto a card with an existing file highlights amber to signal
  // "this will replace", vs. primary for "this will add a file".
  const highlight = dragging
    ? payslip.fileUrl
      ? "bg-amber-500/10 ring-2 ring-amber-500"
      : "bg-primary/10 ring-2 ring-primary"
    : "";

  const adjCount = payslip.adjustments.length;

  const dragHandlers = {
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes("Files")) return;
      e.preventDefault();
      setDragging(true);
    },
    onDragLeave: (e: React.DragEvent) => {
      if (e.currentTarget.contains(e.relatedTarget as Node)) return;
      setDragging(false);
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const f = e.dataTransfer.files[0];
      if (f) void uploadFile(f);
    },
  };

  // Card title: shown on hover so the name remains discoverable without
  // taking layout space.
  const title = `${payslip.name} — ${formatDate(payslip.date)}`;

  const cardClass = `relative flex w-72 cursor-pointer items-center gap-3 overflow-hidden rounded-md border bg-background px-3 py-1.5 text-xs no-underline transition-colors hover:bg-muted/40 ${highlight}`;

  const cardBody = (
    <>
      {!payslip.fileUrl && (
        <FileX
          aria-label="Missing PDF"
          className="pointer-events-none absolute bottom-0.5 right-0.5 size-3 text-muted-foreground"
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <Figure
          data={payslip.amountNet}
          className="truncate font-mono text-base font-semibold tabular-nums"
        />
        <span className="truncate text-[11px] text-muted-foreground">
          → {payslip.toAccount.name}
        </span>
      </div>
      <div className="flex shrink-0 flex-col items-end text-[11px] text-muted-foreground">
        <Figure
          data={payslip.amountGrossAdjusted}
          className="font-mono tabular-nums"
        />
        <span>{adjCount} adj.</span>
      </div>
      <div
        className="flex shrink-0 items-center"
        // Stop clicks here from following the wrapping link / triggering the
        // hidden upload input.
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setEditing(true)}
          aria-label={`Edit ${payslip.name}`}
        >
          <Pencil className="size-4" />
        </Button>
        <DeleteButton onConfirm={onDelete} />
      </div>
    </>
  );

  return (
    <>
      {payslip.fileUrl ? (
        <PdfPreviewDialog
          url={resolveFileUrl(payslip.fileUrl)}
          label={`View ${payslip.name} file`}
        >
          <div
            {...dragHandlers}
            className={cardClass}
            title={title}
            role="button"
            tabIndex={0}
          >
            {cardBody}
          </div>
        </PdfPreviewDialog>
      ) : (
        <label
          {...dragHandlers}
          className={cardClass}
          htmlFor={quickInputId}
          title={title}
          aria-label={`Upload file for ${payslip.name}`}
        >
          <input
            id={quickInputId}
            type="file"
            accept="application/pdf"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void uploadFile(f);
              e.target.value = "";
            }}
          />
          {cardBody}
        </label>
      )}
      {editing && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setEditing(false);
          }}
        >
          <DialogContent className="sm:max-w-xl">
            <DialogHeader>
              <DialogTitle>Edit payslip</DialogTitle>
            </DialogHeader>
            <EditPayslipForm
              payslip={payslip}
              accounts={accounts}
              liabilities={liabilities}
              refetch={refetch}
              onDone={() => setEditing(false)}
            />
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

function AddPayslipForm({
  accounts,
  liabilities,
  refetch,
  onCreated,
}: {
  accounts: AccountOption[];
  liabilities: LiabilityOption[];
  refetch: RefetchEntry[];
  onCreated?: () => void;
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
        file: values.file,
      },
    });
    toast.success(`Added ${values.name.trim()}`);
    setValues(emptyForm);
    onCreated?.();
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
  const [values, setValues] = useState<FormValues>(() =>
    payslipToForm(payslip),
  );
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
        ...(values.file ? { file: values.file } : {}),
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
        existingFileUrl={payslip.fileUrl}
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

export function PayslipFormFields({
  values,
  setValues,
  accounts,
  liabilities,
  existingFileUrl,
}: {
  values: FormValues;
  setValues: React.Dispatch<React.SetStateAction<FormValues>>;
  accounts: AccountOption[];
  liabilities: LiabilityOption[];
  existingFileUrl?: string | null;
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
      <FileField
        file={values.file}
        existingFileUrl={existingFileUrl ?? null}
        onChange={(file) => patch({ file })}
      />
    </>
  );
}

function FileField({
  file,
  existingFileUrl,
  onChange,
}: {
  file: File | null;
  existingFileUrl: string | null;
  onChange: (file: File | null) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const inputId = `payslip-file-${useId()}`;

  const accept = (f: File | null | undefined): f is File => {
    if (!f) return false;
    if (
      f.type !== "application/pdf" &&
      !f.name.toLowerCase().endsWith(".pdf")
    ) {
      toast.error("Only PDF files are supported.");
      return false;
    }
    return true;
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files[0];
    if (accept(f)) onChange(f);
  };

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      className={`rounded-md border border-dashed p-3 text-xs transition-colors ${
        dragging ? "border-primary bg-primary/5" : "bg-muted/20"
      }`}
    >
      <div className="flex items-center gap-2">
        <Paperclip className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          {file ? (
            <span className="truncate font-medium">{file.name}</span>
          ) : existingFileUrl ? (
            <PdfPreviewDialog
              url={resolveFileUrl(existingFileUrl)}
              label="View current file"
            >
              <button
                type="button"
                className="truncate text-left font-medium underline underline-offset-2"
              >
                Current file (preview)
              </button>
            </PdfPreviewDialog>
          ) : (
            <span className="text-muted-foreground">
              Drop a PDF here, or choose a file.
            </span>
          )}
        </div>
        <input
          id={inputId}
          type="file"
          accept="application/pdf"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0] ?? null;
            if (f && accept(f)) onChange(f);
            e.target.value = "";
          }}
        />
        <Button type="button" variant="outline" size="sm" asChild>
          <label htmlFor={inputId} className="cursor-pointer">
            <Upload className="mr-1 size-3" />
            {file || existingFileUrl ? "Replace" : "Choose"}
          </label>
        </Button>
        {file && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => onChange(null)}
            aria-label="Clear selected file"
          >
            <X className="size-4" />
          </Button>
        )}
      </div>
    </div>
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
          <li
            key={i}
            className="flex flex-wrap items-center gap-2 rounded-md sm:flex-nowrap"
          >
            <Input
              placeholder="Name (e.g. Income tax)"
              className="min-w-0 flex-1 basis-full sm:basis-auto"
              value={entry.name}
              onChange={(e) => patchAt(i, { name: e.target.value })}
            />
            <Select
              value={entry.sign}
              onValueChange={(v) => patchAt(i, { sign: v as "+" | "-" })}
            >
              <SelectTrigger className="w-14 shrink-0 rounded-r-none border-r-0">
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
              className="-ml-2 min-w-0 flex-1 rounded-l-none sm:w-32 sm:flex-none"
              value={entry.amount}
              onChange={(e) => patchAt(i, { amount: e.target.value })}
            />
            <Select
              value={entry.liabilityId === "" ? "__none__" : entry.liabilityId}
              onValueChange={(v) =>
                patchAt(i, { liabilityId: v === "__none__" ? "" : v })
              }
            >
              <SelectTrigger className="min-w-0 flex-1 sm:w-36 sm:flex-none">
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
              className="shrink-0"
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

/** Drop zone + quick-pick button that sends a payslip PDF to Gemini, then opens the review sub-dialog pre-filled with whatever the model extracted. Nothing is persisted until the user hits Save inside that dialog. */
function PayslipParseDropZone({
  accounts,
  isDemo,
  liabilities,
  refetch,
  onCreated,
}: {
  accounts: AccountOption[];
  isDemo: boolean;
  liabilities: LiabilityOption[];
  refetch: RefetchEntry[];
  onCreated?: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  const [pendingFileName, setPendingFileName] = useState<string | null>(null);
  const [review, setReview] = useState<{
    parsed: PayslipParseResultView;
    file: File;
  } | null>(null);
  const inputId = useId();
  const [parse, { loading }] = useMutation(PlanningPayslipParseDocument);
  const disabled = loading || isDemo;

  const accept = (f: File | null | undefined): f is File => {
    if (!f) return false;
    if (
      f.type !== "application/pdf" &&
      !f.name.toLowerCase().endsWith(".pdf")
    ) {
      toast.error("Only PDF files are supported.");
      return false;
    }
    return true;
  };

  const run = async (file: File) => {
    setPendingFileName(file.name);
    try {
      const { data } = await parse({ variables: { file } });
      const parsed = data?.payslipParse;
      if (!parsed) {
        toast.error("Gemini returned no data for this payslip.");
        return;
      }
      setReview({ parsed, file });
    } catch (e) {
      // Apollo already logs; surface the message as a toast so the user can
      // tell free-tier exhaustion apart from a malformed PDF.
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(msg);
    } finally {
      setPendingFileName(null);
    }
  };

  return (
    <>
      <div
        onDragEnter={(e) => {
          if (disabled) return;
          if (!e.dataTransfer.types.includes("Files")) return;
          setDragging(true);
        }}
        onDragOver={(e) => {
          if (disabled) return;
          if (e.dataTransfer.types.includes("Files")) e.preventDefault();
        }}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node)) return;
          setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          if (disabled) return;
          setDragging(false);
          const f = e.dataTransfer.files[0];
          if (accept(f)) void run(f);
        }}
        className={`flex items-center gap-3 rounded-md border border-dashed p-3 text-xs ${
          dragging ? "border-primary bg-primary/5" : "bg-muted/20"
        } ${isDemo ? "opacity-60" : ""}`}
      >
        {loading ? (
          <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
        ) : (
          <Sparkles className="size-4 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1">
          <div className="font-medium">Import from PDF</div>
          <div className="text-muted-foreground">
            Drop a payslip PDF here and Gemini Flash will pre-fill the form.
          </div>
          {pendingFileName && (
            <div className="mt-1 flex items-center gap-1.5 text-muted-foreground">
              <Loader2 className="size-3 animate-spin" aria-hidden="true" />
              <span>Reading {pendingFileName}…</span>
            </div>
          )}
        </div>
        <input
          id={inputId}
          type="file"
          accept="application/pdf"
          className="hidden"
          disabled={disabled}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (accept(f)) void run(f);
            e.target.value = "";
          }}
        />
        {isDemo ? (
          <Tooltip>
            <TooltipTrigger asChild>
              {/* Wrapping span needed because a `disabled` button doesn't fire
                  pointer events, which Radix Tooltip relies on to open. */}
              <span tabIndex={0}>
                <Button type="button" variant="outline" size="sm" disabled>
                  <Upload className="mr-1 size-3" />
                  Choose PDF
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>
              Disabled in demo mode — PDF parsing uses paid Gemini API calls.
            </TooltipContent>
          </Tooltip>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            asChild
            disabled={loading}
          >
            <label htmlFor={inputId} className="cursor-pointer">
              {loading ? (
                <Loader2 className="mr-1 size-3 animate-spin" />
              ) : (
                <Upload className="mr-1 size-3" />
              )}
              {loading ? "Reading…" : "Choose PDF"}
            </label>
          </Button>
        )}
      </div>
      {review && (
        <ReviewParsedPayslipDialog
          parsed={review.parsed}
          file={review.file}
          accounts={accounts}
          liabilities={liabilities}
          refetch={refetch}
          onClose={() => setReview(null)}
          onCreated={() => {
            setReview(null);
            onCreated?.();
          }}
        />
      )}
    </>
  );
}

export type PayslipParseResultView = NonNullable<
  ResultOf<typeof PlanningPayslipParseDocument>["payslipParse"]
>;

/** Sub-dialog that wraps `PayslipFormFields` with values pre-populated from the `payslipParse` result. The PDF is prepopulated as the chosen file so the user doesn't have to re-attach it when saving. */
function ReviewParsedPayslipDialog({
  parsed,
  file,
  accounts,
  liabilities,
  refetch,
  onClose,
  onCreated,
}: {
  parsed: PayslipParseResultView;
  file: File;
  accounts: AccountOption[];
  liabilities: LiabilityOption[];
  refetch: RefetchEntry[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [values, setValues] = useState<FormValues>(() =>
    parseToForm(parsed, accounts, file),
  );
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
        file: values.file,
      },
    });
    toast.success(`Added ${values.name.trim()}`);
    onCreated();
  };

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Review payslip</DialogTitle>
        </DialogHeader>
        {parsed.suggestedAccount == null && parsed.employeeFirstName && (
          <p className="text-xs text-muted-foreground">
            Couldn't find a planning account matching{" "}
            <span className="font-medium">{parsed.employeeFirstName}</span>.
            Pick one below.
          </p>
        )}
        <form onSubmit={submit} className="space-y-3">
          <PayslipFormFields
            values={values}
            setValues={setValues}
            accounts={accounts}
            liabilities={liabilities}
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={disabled}>
              Save payslip
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function parseToForm(
  parsed: PayslipParseResultView,
  accounts: AccountOption[],
  file: File,
): FormValues {
  const suggested = parsed.suggestedAccount?.id;
  const toAccountId =
    suggested && accounts.some((a) => a.id === suggested) ? suggested : "";
  return {
    name: parsed.suggestedName,
    date: parsed.date,
    amount: String(parsed.gross.amount),
    toAccountId,
    adjustments: parsed.adjustments.map((a) => ({
      id: null,
      name: a.name,
      amount: String(Math.abs(a.amount.amount)),
      sign: a.amount.amount < 0 ? "-" : "+",
      liabilityId: a.liability?.id ?? "",
    })),
    file,
  };
}

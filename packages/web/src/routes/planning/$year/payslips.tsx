import { useMutation, useSuspenseQuery } from "@apollo/client/react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  FileText,
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

import { DeleteButton } from "@/components/delete-button";
import { Figure, FigureDocument } from "@/components/figure";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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
    query PlanningPayslipsDialog($year: ID!, $first: Int!, $after: ID) {
      payslips(first: $first, after: $after) {
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
        pageInfo {
          hasNextPage
          hasPreviousPage
          endCursor
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

const PlanningPayslipParseDocument = graphql(`
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
  NonNullable<
    PlanningPayslipsData["netWorthCategories"]
  >["edges"][number]["node"],
  { __typename: "NetWorthCategoryLiability" }
>;

type RefetchEntry =
  | {
      query: typeof PlanningPayslipsDialogDocument;
      variables: { year: string; first: number; after: string | null };
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
  file: File | null;
};

const CURRENCY = "GBP";

const FILES_ORIGIN = new URL(
  import.meta.env.VITE_GRAPHQL_URL ?? "http://localhost:4000/graphql",
).origin;

function resolveFileUrl(fileUrl: string): string {
  return /^https?:\/\//.test(fileUrl) ? fileUrl : `${FILES_ORIGIN}${fileUrl}`;
}

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

const PAGE_SIZE = 10;

function PlanningPayslipsDialog() {
  const { year } = Route.useParams();
  const navigate = useNavigate();
  // Stack of `after` cursors, one per page already shown. Page 1 is `null`,
  // page 2 is stack[0], etc — pushing appends the end-cursor of the current
  // page when paging forward; popping takes us back.
  const [cursorStack, setCursorStack] = useState<Array<string | null>>([null]);
  const after = cursorStack[cursorStack.length - 1];
  const variables = { year, first: PAGE_SIZE, after };
  const { data } = useSuspenseQuery(PlanningPayslipsDialogDocument, {
    variables,
  });

  const refetch: RefetchEntry[] = [
    { query: PlanningPayslipsDialogDocument, variables },
    { query: PlanningYearViewDocument, variables: { id: year } },
  ];

  const payslips: Payslip[] = data.payslips?.edges.map((e) => e.node) ?? [];
  const pageInfo = data.payslips?.pageInfo;
  const accounts: AccountOption[] = data.planningYear?.accounts ?? [];
  const liabilities: LiabilityOption[] = (data.netWorthCategories?.edges ?? [])
    .map((e) => e.node)
    .filter(
      (n): n is LiabilityOption => n.__typename === "NetWorthCategoryLiability",
    );

  const close = () =>
    void navigate({ to: "/planning/$year", params: { year } });
  const onNext = () => {
    if (pageInfo?.hasNextPage && pageInfo.endCursor) {
      setCursorStack((s) => [...s, pageInfo.endCursor as string]);
    }
  };
  const onPrev = () => {
    setCursorStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
  };
  const resetToFirstPage = () => setCursorStack([null]);
  const pageNumber = cursorStack.length;

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
          {(pageInfo?.hasNextPage || pageInfo?.hasPreviousPage) && (
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>Page {pageNumber}</span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onPrev}
                  disabled={!pageInfo?.hasPreviousPage}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onNext}
                  disabled={!pageInfo?.hasNextPage}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
          {accounts.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Assign a planning account first so payslips have a landing
              account.
            </p>
          ) : (
            <>
              <PayslipParseDropZone
                accounts={accounts}
                liabilities={liabilities}
                refetch={refetch}
                onCreated={resetToFirstPage}
              />
              <AddPayslipForm
                accounts={accounts}
                liabilities={liabilities}
                refetch={refetch}
                onCreated={resetToFirstPage}
              />
            </>
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

  // Dragging onto a row with an existing file highlights amber to signal
  // "this will replace", vs. primary for "this will add a file".
  const highlight = dragging
    ? payslip.fileUrl
      ? "bg-amber-500/10 ring-2 ring-amber-500"
      : "bg-primary/10 ring-2 ring-primary"
    : "";

  return (
    <li
      className={`flex items-center gap-2 px-3 py-2 transition-colors ${highlight}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        // `onDragLeave` fires when the drag crosses into a child element too;
        // only reset when it leaves the row entirely.
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const f = e.dataTransfer.files[0];
        if (f) void uploadFile(f);
      }}
    >
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
      {payslip.fileUrl ? (
        <PdfPreviewDialog
          url={resolveFileUrl(payslip.fileUrl)}
          label={`View ${payslip.name} file`}
        />
      ) : (
        <>
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
          <Button
            variant="ghost"
            size="icon"
            asChild
            aria-label={`Upload file for ${payslip.name}`}
          >
            <label htmlFor={quickInputId} className="cursor-pointer">
              <Upload className="size-4" />
            </label>
          </Button>
        </>
      )}
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

function PayslipFormFields({
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

function PdfPreviewDialog({
  url,
  label,
  children,
}: {
  url: string;
  label: string;
  children?: React.ReactNode;
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        {children ?? (
          <Button variant="ghost" size="icon" aria-label={label}>
            <FileText className="size-4" />
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-4xl p-0 sm:max-w-4xl">
        <DialogHeader className="flex-row items-center justify-between gap-2 space-y-0 border-b px-4 py-3">
          <DialogTitle className="text-sm">{label}</DialogTitle>
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="mr-8 text-xs underline underline-offset-2"
          >
            Open in new tab
          </a>
        </DialogHeader>
        <iframe src={url} title={label} className="h-[80vh] w-full" />
      </DialogContent>
    </Dialog>
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

/** Drop zone + quick-pick button that sends a payslip PDF to Gemini, then opens the review sub-dialog pre-filled with whatever the model extracted. Nothing is persisted until the user hits Save inside that dialog. */
function PayslipParseDropZone({
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
  const [dragging, setDragging] = useState(false);
  const [pendingFileName, setPendingFileName] = useState<string | null>(null);
  const [review, setReview] = useState<{
    parsed: PayslipParseResultView;
    file: File;
  } | null>(null);
  const inputId = useId();
  const [parse, { loading }] = useMutation(PlanningPayslipParseDocument);

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
          if (!e.dataTransfer.types.includes("Files")) return;
          setDragging(true);
        }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) e.preventDefault();
        }}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node)) return;
          setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const f = e.dataTransfer.files[0];
          if (accept(f)) void run(f);
        }}
        className={`flex items-center gap-3 rounded-md border border-dashed p-3 text-xs ${
          dragging ? "border-primary bg-primary/5" : "bg-muted/20"
        }`}
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
          disabled={loading}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (accept(f)) void run(f);
            e.target.value = "";
          }}
        />
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

type PayslipParseResultView = NonNullable<
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

function parseToForm(
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

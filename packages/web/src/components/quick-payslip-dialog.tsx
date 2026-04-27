import { useMutation, useSuspenseQuery } from "@apollo/client/react";
import { Loader2, Sparkles, Upload } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import { graphql } from "../graphql";
import {
  type AccountOption,
  adjustmentsForMutation,
  CURRENCY,
  formIsValid,
  type FormValues,
  type LiabilityOption,
  parseToForm,
  PayslipFormFields,
  type PayslipParseResultView,
  PlanningPayslipCreateDocument,
  PlanningPayslipParseDocument,
} from "../routes/planning/$year/payslips";

const QuickPayslipContextDocument = graphql(`
  query QuickPayslipContext {
    planningYearCurrent {
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

export function QuickPayslipDialog({
  initialFile,
  onClose,
}: {
  /** A file the FAB stashed for us. We start parsing immediately if present; otherwise we show a "Choose PDF" dialog. */
  initialFile: File | null;
  onClose: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Inner initialFile={initialFile} onClose={onClose} />
    </Dialog>
  );
}

function Inner({
  initialFile,
  onClose,
}: {
  initialFile: File | null;
  onClose: () => void;
}) {
  const { data } = useSuspenseQuery(QuickPayslipContextDocument);

  const accounts: AccountOption[] = data.planningYearCurrent?.accounts ?? [];
  const liabilities: LiabilityOption[] = (data.netWorthCategories?.edges ?? [])
    .map((e) => e.node)
    .filter(
      (n): n is LiabilityOption => n.__typename === "NetWorthCategoryLiability",
    );
  const isDemo = !!data.me?.isDemo;

  const [parse, { loading: parsing }] = useMutation(
    PlanningPayslipParseDocument,
  );
  const [review, setReview] = useState<{
    parsed: PayslipParseResultView;
    file: File;
  } | null>(null);

  const runParse = async (file: File) => {
    if (
      file.type !== "application/pdf" &&
      !file.name.toLowerCase().endsWith(".pdf")
    ) {
      toast.error("Only PDF files are supported.");
      return;
    }
    if (isDemo) {
      toast.error("Disabled in demo mode.");
      return;
    }
    try {
      const { data } = await parse({ variables: { file } });
      const parsed = data?.payslipParse;
      if (!parsed) {
        toast.error("Gemini returned no data for this payslip.");
        return;
      }
      setReview({ parsed, file });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  // On mount, if the FAB stashed a file, kick off parsing immediately.
  // `startedRef` guards against React strict-mode double-invocation in dev.
  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    if (initialFile) void runParse(initialFile);
  }, [initialFile, runParse]);

  if (review) {
    return (
      <ReviewContent
        parsed={review.parsed}
        file={review.file}
        accounts={accounts}
        liabilities={liabilities}
        onClose={onClose}
      />
    );
  }

  if (parsing) return <ParsingContent />;

  return (
    <ChooseFileContent
      isDemo={isDemo}
      onClose={onClose}
      onChosen={(f) => void runParse(f)}
    />
  );
}

function ChooseFileContent({
  isDemo,
  onClose,
  onChosen,
}: {
  isDemo: boolean;
  onClose: () => void;
  onChosen: (file: File) => void;
}) {
  const inputId = useId();
  return (
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Add payslip</DialogTitle>
      </DialogHeader>
      <p className="text-sm text-muted-foreground">
        Pick a payslip PDF and Gemini Flash will pre-fill the details.
      </p>
      <input
        id={inputId}
        type="file"
        accept="application/pdf"
        className="hidden"
        disabled={isDemo}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onChosen(f);
          e.target.value = "";
        }}
      />
      <div className="flex justify-end gap-2 pt-2">
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button asChild disabled={isDemo}>
          <label htmlFor={inputId} className="cursor-pointer">
            <Upload /> Choose PDF
          </label>
        </Button>
      </div>
    </DialogContent>
  );
}

function ParsingContent() {
  return (
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Reading payslip</DialogTitle>
      </DialogHeader>
      <div className="flex items-center gap-3 py-2 text-sm text-muted-foreground">
        <Sparkles className="size-4" />
        <Loader2 className="size-4 animate-spin" />
        <span>Gemini Flash is extracting the details…</span>
      </div>
    </DialogContent>
  );
}

function ReviewContent({
  parsed,
  file,
  accounts,
  liabilities,
  onClose,
}: {
  parsed: PayslipParseResultView;
  file: File;
  accounts: AccountOption[];
  liabilities: LiabilityOption[];
  onClose: () => void;
}) {
  const [values, setValues] = useState<FormValues>(() =>
    parseToForm(parsed, accounts, file),
  );
  const [create, { loading }] = useMutation(PlanningPayslipCreateDocument);
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
    onClose();
  };

  return (
    <DialogContent className="sm:max-w-xl">
      <DialogHeader>
        <DialogTitle>Review payslip</DialogTitle>
      </DialogHeader>
      {parsed.suggestedAccount == null && parsed.employeeFirstName && (
        <p className="text-xs text-muted-foreground">
          Couldn't find a planning account matching{" "}
          <span className="font-medium">{parsed.employeeFirstName}</span>. Pick
          one below.
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
  );
}

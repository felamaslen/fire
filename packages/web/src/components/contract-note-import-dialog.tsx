import { useMutation, useSuspenseQuery } from "@apollo/client/react";
import { FileText, Loader2, Sparkles, Upload } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";

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
import { graphql, type ResultOf } from "@/graphql";

const ContractNoteImportContextDocument = graphql(`
  query ContractNoteImportContext {
    me {
      isDemo
    }
    investments(first: 200) {
      edges {
        node {
          id
          name
          currency
          asset {
            ... on InvestmentStock {
              __typename
              code
            }
            ... on InvestmentFund {
              __typename
            }
          }
        }
      }
    }
    netWorthCategories(first: 200) {
      edges {
        node {
          __typename
          ... on NetWorthCategoryAsset {
            id
            name
            type
          }
        }
      }
    }
  }
`);

const ContractNoteImportDocument = graphql(`
  mutation ContractNoteImport($file: Upload!, $investmentId: ID) {
    investmentContractNoteImport(file: $file, investmentId: $investmentId) {
      investment {
        id
        name
        currency
      }
      asset {
        id
        name
        type
      }
      date
      units
      drip
      fileKey
      price {
        amount
        currency
      }
      taxes {
        amount
        currency
      }
      fees {
        amount
        currency
      }
    }
  }
`);

const TransactionCreateDocument = graphql(`
  mutation ContractNoteTransactionCreate(
    $investmentId: ID!
    $assetId: ID!
    $date: Date!
    $units: Float!
    $price: MoneyInput!
    $taxes: MoneyInput
    $fees: MoneyInput
    $drip: Boolean
    $fileKey: String
  ) {
    investmentTransactionCreate(
      investmentId: $investmentId
      assetId: $assetId
      date: $date
      units: $units
      price: $price
      taxes: $taxes
      fees: $fees
      drip: $drip
      fileKey: $fileKey
    ) {
      id
    }
  }
`);

type ParsedResult = NonNullable<
  ResultOf<typeof ContractNoteImportDocument>["investmentContractNoteImport"]
>;

export function ContractNoteImportDialog({
  initialFile,
  lockedInvestmentId,
  onClose,
  onSaved,
}: {
  /** File picked by the caller (drag-drop or file input). When set, parsing starts immediately. `null` means we show a file-picker step. */
  initialFile: File | null;
  /** When set, the mutation is called with `investmentId` so Gemini skips the candidate-match step, and the review form hides the investment selector. */
  lockedInvestmentId: string | null;
  /** Called whenever the dialog closes (cancel, escape, click-outside, post-save). The parent should use this to drop the dialog from its tree, and nothing else — refetching here re-suspends the parent's `useSuspenseQuery` even on a plain cancel. */
  onClose: () => void;
  /** Called immediately after a successful save (before `onClose`). Use this for any post-save side effects the parent owns (cursor reset, refetch of non-suspense queries, etc.). */
  onSaved?: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Inner
        initialFile={initialFile}
        lockedInvestmentId={lockedInvestmentId}
        onClose={onClose}
        onSaved={onSaved}
      />
    </Dialog>
  );
}

function Inner({
  initialFile,
  lockedInvestmentId,
  onClose,
  onSaved,
}: {
  initialFile: File | null;
  lockedInvestmentId: string | null;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const { data } = useSuspenseQuery(ContractNoteImportContextDocument);
  const isDemo = !!data.me?.isDemo;

  const investments = (data.investments?.edges ?? []).map((e) => e.node);
  const wrappers = (data.netWorthCategories?.edges ?? [])
    .map((e) => e.node)
    .flatMap((n) =>
      n.__typename === "NetWorthCategoryAsset" &&
      (n.type === "STOCK" || n.type === "PENSION")
        ? [{ id: n.id, name: n.name, type: n.type }]
        : [],
    );

  const [parse, { loading: parsing }] = useMutation(ContractNoteImportDocument);
  const [review, setReview] = useState<{ parsed: ParsedResult } | null>(null);

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
      const { data } = await parse({
        variables: { file, investmentId: lockedInvestmentId ?? null },
      });
      const parsed = data?.investmentContractNoteImport;
      if (!parsed) {
        toast.error("Gemini returned no data for this contract note.");
        return;
      }
      setReview({ parsed });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

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
        investments={investments}
        wrappers={wrappers}
        lockedInvestmentId={lockedInvestmentId}
        onClose={onClose}
        onSaved={onSaved}
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
        <DialogTitle>Import contract note</DialogTitle>
      </DialogHeader>
      <p className="text-sm text-muted-foreground">
        Pick a broker contract note PDF and Gemini Flash will pre-fill the trade
        details.
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
        <DialogTitle>Reading contract note</DialogTitle>
      </DialogHeader>
      <div className="flex items-center gap-3 py-2 text-sm text-muted-foreground">
        <Sparkles className="size-4" />
        <Loader2 className="size-4 animate-spin" />
        <span>Gemini Flash is extracting the trade details…</span>
      </div>
    </DialogContent>
  );
}

type InvestmentOption = {
  id: string;
  name: string;
  currency: string;
};
type WrapperOption = { id: string; name: string; type: string };

function ReviewContent({
  parsed,
  investments,
  wrappers,
  lockedInvestmentId,
  onClose,
  onSaved,
}: {
  parsed: ParsedResult;
  investments: InvestmentOption[];
  wrappers: WrapperOption[];
  lockedInvestmentId: string | null;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const initialInvestmentId =
    lockedInvestmentId ?? parsed.investment?.id ?? investments[0]?.id ?? "";
  const [investmentId, setInvestmentId] = useState(initialInvestmentId);
  const investment =
    investments.find((i) => i.id === investmentId) ?? parsed.investment ?? null;
  const currency = investment?.currency ?? parsed.price.currency;

  const [assetId, setAssetId] = useState(
    parsed.asset?.id ?? wrappers[0]?.id ?? "",
  );
  const [date, setDate] = useState(parsed.date);
  const [units, setUnits] = useState(parsed.units);
  const [priceAmount, setPriceAmount] = useState(parsed.price.amount);
  const [taxesAmount, setTaxesAmount] = useState(parsed.taxes?.amount ?? 0);
  const [feesAmount, setFeesAmount] = useState(parsed.fees?.amount ?? 0);
  const [drip, setDrip] = useState(parsed.drip);

  const [createTx, { loading }] = useMutation(TransactionCreateDocument, {
    refetchQueries: [
      "InvestmentDetail",
      "InvestmentTransactions",
      "InvestmentsList",
    ],
    awaitRefetchQueries: true,
  });

  const disabled = loading || !investmentId || !assetId;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (disabled) return;
    try {
      await createTx({
        variables: {
          investmentId,
          assetId,
          date,
          units: Number(units),
          price: { amount: Number(priceAmount), currency },
          taxes: taxesAmount ? { amount: Number(taxesAmount), currency } : null,
          fees: feesAmount ? { amount: Number(feesAmount), currency } : null,
          drip,
          fileKey: parsed.fileKey,
        },
      });
      toast.success("Transaction added");
      onSaved?.();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  // Implied consideration: |units| × unit price, in major units of `currency`.
  // Mirrors what the backend's DRIP heuristic uses, and is the gross trade
  // value before taxes / fees — useful as a sanity check against the
  // `Consideration` line printed on most contract notes.
  const u = Number(units) || 0;
  const consideration = Math.abs(u) * (Number(priceAmount) || 0);
  // Net total: what actually moves out of (or into) the cash account.
  // Buys: consideration + taxes + fees (cost). Sells: consideration - taxes - fees (proceeds).
  const sign = u < 0 ? -1 : 1;
  const netTotal =
    consideration +
    sign * ((Number(taxesAmount) || 0) + (Number(feesAmount) || 0));
  const fmt = new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
  });
  const considerationFmt = fmt.format(consideration);
  const netTotalFmt = fmt.format(netTotal);

  return (
    <DialogContent className="sm:max-w-3xl">
      <DialogHeader>
        <DialogTitle>Review contract note</DialogTitle>
      </DialogHeader>
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <FileText className="size-3.5" />
        Adjust anything Gemini got wrong before saving.
      </p>
      <form onSubmit={submit} className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {!lockedInvestmentId && (
            <div className="space-y-1">
              <Label>Investment</Label>
              <Select value={investmentId} onValueChange={setInvestmentId}>
                <SelectTrigger>
                  <SelectValue placeholder="Pick investment" />
                </SelectTrigger>
                <SelectContent>
                  {investments.map((i) => (
                    <SelectItem key={i.id} value={i.id}>
                      {i.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-1">
            <Label>Wrapper</Label>
            <Select value={assetId} onValueChange={setAssetId}>
              <SelectTrigger>
                <SelectValue placeholder="Pick wrapper" />
              </SelectTrigger>
              <SelectContent>
                {wrappers.map((w) => (
                  <SelectItem key={w.id} value={w.id}>
                    {w.name} ({w.type})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="flex flex-wrap gap-3">
          <div className="min-w-32 flex-1 space-y-1">
            <Label>Date</Label>
            <Input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div className="min-w-32 flex-1 space-y-1">
            <Label>Units</Label>
            <Input
              type="number"
              step="any"
              value={units}
              onChange={(e) => setUnits(Number(e.target.value))}
            />
          </div>
          <div className="min-w-32 flex-1 space-y-1">
            <Label>Unit price</Label>
            <Input
              type="number"
              step="any"
              currency={currency}
              value={priceAmount}
              onChange={(e) => setPriceAmount(Number(e.target.value))}
            />
          </div>
          <div className="min-w-28 flex-1 space-y-1">
            <Label>Taxes</Label>
            <Input
              type="number"
              step="any"
              currency={currency}
              value={taxesAmount}
              onChange={(e) => setTaxesAmount(Number(e.target.value))}
            />
          </div>
          <div className="min-w-28 flex-1 space-y-1">
            <Label>Fees</Label>
            <Input
              type="number"
              step="any"
              currency={currency}
              value={feesAmount}
              onChange={(e) => setFeesAmount(Number(e.target.value))}
            />
          </div>
        </div>
        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
          <div className="flex items-baseline gap-2">
            <dt>Consideration</dt>
            <dd className="font-medium tabular-nums text-foreground">
              {considerationFmt}
            </dd>
          </div>
          <div className="flex items-baseline gap-2">
            <dt>Net {u < 0 ? "proceeds" : "cost"}</dt>
            <dd className="font-medium tabular-nums text-foreground">
              {netTotalFmt}
            </dd>
          </div>
        </dl>
        <label className="flex items-center gap-2">
          <Checkbox
            checked={drip}
            onCheckedChange={(v) => setDrip(v === true)}
          />
          <span className="text-sm">Dividend reinvestment</span>
        </label>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={disabled}>
            Save transaction
          </Button>
        </div>
      </form>
    </DialogContent>
  );
}

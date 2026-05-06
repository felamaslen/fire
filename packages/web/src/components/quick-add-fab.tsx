import { useLocation, useNavigate } from "@tanstack/react-router";
import { FileText, HandCoins, Plus, Wallet, X } from "lucide-react";
import { Suspense, useId, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/cn";

import { ContractNoteImportDialog } from "./contract-note-import-dialog";
import { QuickNetWorthDialog } from "./quick-net-worth-dialog";
import { QuickPayslipDialog } from "./quick-payslip-dialog";

const HIDDEN_ON = ["/login", "/planning"];

const HASH_KEY_QUICK = "quick";
const HASH_KEY_W = "w";

/** Read the modal state from the URL hash. The hash is parsed as `URLSearchParams` (e.g. `#quick=net-worth&w=<encoded>`), so the state survives a page refresh and lives outside any route's `validateSearch`. */
function parseHash(hash: string): { quick: string | null; w: string | null } {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  return {
    quick: params.get(HASH_KEY_QUICK),
    w: params.get(HASH_KEY_W),
  };
}

function buildHash(patch: { quick?: string | null; w?: string | null }): {
  quick: string | null;
  w: string | null;
} {
  const current = parseHash(window.location.hash);
  const next = {
    quick: HASH_KEY_QUICK in patch ? (patch.quick ?? null) : current.quick,
    w: HASH_KEY_W in patch ? (patch.w ?? null) : current.w,
  };
  return next;
}

function serializeHash(parts: {
  quick: string | null;
  w: string | null;
}): string {
  const params = new URLSearchParams();
  if (parts.quick) params.set(HASH_KEY_QUICK, parts.quick);
  if (parts.w) params.set(HASH_KEY_W, parts.w);
  return params.toString();
}

export function QuickAddFab() {
  const navigate = useNavigate();
  const location = useLocation();
  const { pathname } = location;
  const fabHidden = HIDDEN_ON.some((p) => pathname.startsWith(p));
  // Read the hash from the router so updates re-render. `useNavigate` writes
  // it; the router's location reflects it.
  const { quick, w } = parseHash(location.hash);

  // The payslip / contract-note flows need a `File`, which can't go in the
  // URL. We hold it in a ref so opening the picker (a user gesture) can pass
  // it to the dialog without forcing the dialog to live in this component's
  // render tree.
  const pendingFileRef = useRef<File | null>(null);

  const writeHash = (
    patch: { quick?: string | null; w?: string | null },
    opts?: { replace?: boolean },
  ) => {
    const next = serializeHash(buildHash(patch));
    // Pass `search: true` so router-core's search middleware preserves the
    // current search params instead of wiping them. Without it, the route's
    // `beforeLoad` (e.g. `/investments`) sees empty search, redirects to
    // restore persisted defaults, and that redirect drops the hash we just
    // set — closing the modal before it opens.
    void navigate({
      search: true,
      hash: next || undefined,
      replace: opts?.replace ?? false,
    });
  };

  const closeModal = () => {
    // Use back when there's something to go back to so the FAB opening can be
    // undone in one click. Direct visit (e.g. opening a deep link with the
    // hash already set) has no entry to pop, so we just clear the hash.
    if (window.history.length > 1) {
      window.history.back();
    } else {
      writeHash({ quick: null, w: null }, { replace: true });
    }
  };

  return (
    <>
      {!fabHidden && (
        <FabTrigger
          onWizard={() => writeHash({ quick: "net-worth" })}
          onPayslipFile={(file) => {
            pendingFileRef.current = file;
            writeHash({ quick: "payslip" });
          }}
          onContractNoteFile={(file) => {
            pendingFileRef.current = file;
            writeHash({ quick: "contract-note" });
          }}
        />
      )}
      {quick === "net-worth" && (
        <Suspense fallback={null}>
          <QuickNetWorthDialog
            encodedState={w ?? undefined}
            onUpdateState={(encoded) =>
              writeHash({ w: encoded }, { replace: true })
            }
            onClose={closeModal}
          />
        </Suspense>
      )}
      {quick === "payslip" && (
        <Suspense fallback={null}>
          <QuickPayslipDialog
            initialFile={pendingFileRef.current}
            onClose={closeModal}
          />
        </Suspense>
      )}
      {quick === "contract-note" && (
        <Suspense fallback={null}>
          <ContractNoteImportDialog
            initialFile={pendingFileRef.current}
            lockedInvestmentId={null}
            onClose={closeModal}
          />
        </Suspense>
      )}
    </>
  );
}

function FabTrigger({
  onWizard,
  onPayslipFile,
  onContractNoteFile,
}: {
  onWizard: () => void;
  onPayslipFile: (file: File) => void;
  onContractNoteFile: (file: File) => void;
}) {
  const [open, setOpen] = useState(false);
  const payslipInputId = useId();
  const contractNoteInputId = useId();

  const handlePayslipFile = (file: File | undefined) => {
    if (!file) return;
    if (
      file.type !== "application/pdf" &&
      !file.name.toLowerCase().endsWith(".pdf")
    ) {
      toast.error("Only PDF files are supported.");
      return;
    }
    setOpen(false);
    onPayslipFile(file);
  };

  const handleContractNoteFile = (file: File | undefined) => {
    if (!file) return;
    if (
      file.type !== "application/pdf" &&
      !file.name.toLowerCase().endsWith(".pdf")
    ) {
      toast.error("Only PDF files are supported.");
      return;
    }
    setOpen(false);
    onContractNoteFile(file);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          aria-label="Quick add"
          className={cn(
            "fixed bottom-4 right-4 z-30 h-14 w-14 rounded-full shadow-lg sm:bottom-6 sm:right-6",
          )}
        >
          {open ? <X className="!size-6" /> : <Plus className="!size-6" />}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="top"
        sideOffset={12}
        className="w-56 p-2"
      >
        <div className="flex flex-col">
          <input
            id={payslipInputId}
            type="file"
            accept="application/pdf"
            className="hidden"
            onChange={(e) => {
              handlePayslipFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          <input
            id={contractNoteInputId}
            type="file"
            accept="application/pdf"
            className="hidden"
            onChange={(e) => {
              handleContractNoteFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          <Button variant="ghost" className="justify-start" asChild>
            <label htmlFor={payslipInputId} className="cursor-pointer">
              <HandCoins /> Add payslip
            </label>
          </Button>
          <Button variant="ghost" className="justify-start" asChild>
            <label htmlFor={contractNoteInputId} className="cursor-pointer">
              <FileText /> Import contract note
            </label>
          </Button>
          <Button
            variant="ghost"
            className="justify-start"
            onClick={() => {
              setOpen(false);
              onWizard();
            }}
          >
            <Wallet /> Quick net-worth update
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

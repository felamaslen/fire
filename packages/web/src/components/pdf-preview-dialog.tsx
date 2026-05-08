import { FileText } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useIsDesktop } from "@/lib/use-is-desktop";

/** Append the PDF Open Parameters that suppress the embedded viewer's pages / bookmarks sidebar (`pagemode=none` for Adobe / Firefox; `navpanes=0` for Chromium's built-in viewer). The signed URL's existing query string carries through unchanged — these are URL-fragment parameters, which are viewer-only and not sent to the server. */
function withPdfViewerParams(url: string): string {
  const sep = url.includes("#") ? "&" : "#";
  return `${url}${sep}pagemode=none&navpanes=0`;
}

/** Open a PDF (e.g. a payslip or contract note attachment) inside an in-app modal `iframe`, with an "Open in new tab" escape hatch. On screens narrower than the `sm` breakpoint the iframe is skipped entirely — the trigger just opens the file in a new tab. The trigger defaults to a paperclip-style ghost icon button; pass `children` to use a custom trigger element. `url` should already be an absolute, signed URL — backend resolvers serialize file links pre-signed via the API origin so the SPA can embed them directly. */
export function PdfPreviewDialog({
  url,
  label,
  children,
}: {
  url: string;
  label: string;
  children?: React.ReactNode;
}) {
  const isDesktop = useIsDesktop();
  if (!isDesktop) {
    return children ? (
      <a href={url} target="_blank" rel="noreferrer" aria-label={label}>
        {children}
      </a>
    ) : (
      <Button variant="ghost" size="icon" asChild aria-label={label}>
        <a href={url} target="_blank" rel="noreferrer">
          <FileText className="size-4" />
        </a>
      </Button>
    );
  }
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
        <iframe
          src={withPdfViewerParams(url)}
          title={label}
          className="h-[80vh] w-full"
        />
      </DialogContent>
    </Dialog>
  );
}

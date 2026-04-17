import { Loader2 } from "lucide-react";

export function Spinner() {
  return (
    <div
      role="status"
      aria-label="Loading"
      className="flex items-center justify-center p-12"
    >
      <Loader2 className="size-8 animate-spin text-muted-foreground" />
    </div>
  );
}

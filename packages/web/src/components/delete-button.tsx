import { Check, Trash2, X } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

interface DeleteButtonProps {
  onConfirm: () => void | Promise<unknown>;
}

export function DeleteButton({ onConfirm }: DeleteButtonProps) {
  const [pending, setPending] = useState(false);

  return (
    <div className="ml-auto flex items-center justify-end">
      <Button
        type="button"
        variant={pending ? "outline" : "ghost"}
        size="icon"
        aria-label={pending ? "Cancel delete" : "Delete"}
        onClick={() => setPending((p) => !p)}
      >
        {pending ? <X /> : <Trash2 />}
      </Button>
      <div
        aria-hidden={!pending}
        className={cn(
          "overflow-hidden transition-[width,margin-left,opacity] duration-200",
          pending ? "ml-1 w-9 opacity-100" : "pointer-events-none w-0 opacity-0",
        )}
      >
        <Button
          type="button"
          variant="destructive"
          size="icon"
          aria-label="Confirm delete"
          className="w-full"
          tabIndex={pending ? 0 : -1}
          onClick={async () => {
            setPending(false);
            await onConfirm();
          }}
        >
          <Check />
        </Button>
      </div>
    </div>
  );
}

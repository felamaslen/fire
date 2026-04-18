import { ChevronDown } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/cn";

/** Styled native `<select>` — use this when the volume of selects would make Radix's `<Select>` expensive (it mounts ~4 provider components per instance). Drop-in for any form-field binding: takes `value` / `onChange` like a plain input. */
export const NativeSelect = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, children, ...props }, ref) => (
  <div className={cn("relative", className)}>
    <select
      ref={ref}
      className={cn(
        "flex h-9 w-full cursor-pointer appearance-none rounded-md border border-input bg-transparent px-3 pr-8 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
      )}
      {...props}
    >
      {children}
    </select>
    <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 opacity-50" />
  </div>
));
NativeSelect.displayName = "NativeSelect";

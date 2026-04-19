import * as React from "react";

import { cn } from "@/lib/cn";
import { currencySymbol } from "@/lib/format";

export interface InputProps
  extends React.InputHTMLAttributes<HTMLInputElement> {
  startAdornment?: React.ReactNode;
  endAdornment?: React.ReactNode;
  /** ISO-4217 currency code (e.g. `"GBP"`). When set, the locale-appropriate currency symbol is rendered as the start adornment. Overrides `startAdornment`. */
  currency?: string;
}

const baseInputClasses =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

const plainInputClasses =
  "file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground";

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  (
    { className, type, startAdornment, endAdornment, currency, ...props },
    ref,
  ) => {
    const resolvedStart =
      currency !== undefined ? currencySymbol(currency) : startAdornment;

    if (!resolvedStart && !endAdornment) {
      return (
        <input
          type={type}
          ref={ref}
          className={cn(baseInputClasses, plainInputClasses, className)}
          {...props}
        />
      );
    }

    // Wrap adornments + input in a flex row so spacing comes from `gap-2`
    // rather than hand-tuned padding. The outer element carries the border /
    // focus styling; the inner `<input>` is transparent so its own chrome
    // doesn't collide with the adornments.
    return (
      <div
        className={cn(
          baseInputClasses,
          "items-center gap-2 focus-within:outline-none focus-within:ring-1 focus-within:ring-ring",
          className,
        )}
      >
        {resolvedStart && (
          <span className="pointer-events-none flex items-center text-sm text-muted-foreground">
            {resolvedStart}
          </span>
        )}
        <input
          type={type}
          ref={ref}
          className="h-full min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
          {...props}
        />
        {endAdornment && (
          <span className="pointer-events-none flex items-center text-sm text-muted-foreground">
            {endAdornment}
          </span>
        )}
      </div>
    );
  },
);
Input.displayName = "Input";

import * as CollapsiblePrimitive from "@radix-ui/react-collapsible";
import * as React from "react";

import { cn } from "@/lib/cn";

export const Collapsible = CollapsiblePrimitive.Root;
export const CollapsibleTrigger = CollapsiblePrimitive.Trigger;

export const CollapsibleContent = React.forwardRef<
  React.ElementRef<typeof CollapsiblePrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof CollapsiblePrimitive.Content>
>(({ className, ...props }, ref) => (
  <CollapsiblePrimitive.Content
    ref={ref}
    className={cn(
      "overflow-hidden data-[state=open]:animate-[collapsible-down_200ms_ease-out] data-[state=closed]:animate-[collapsible-up_200ms_ease-out]",
      className,
    )}
    {...props}
  />
));
CollapsibleContent.displayName = CollapsiblePrimitive.Content.displayName;

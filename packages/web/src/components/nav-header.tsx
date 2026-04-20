import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/cn";

const ACTIONS_SLOT_ID = "nav-header-actions";
const TITLE_SLOT_ID = "nav-header-title";

/** Portal children into the `NavHeader`'s right-side actions slot. Used by
 * pages that want page-scoped controls in the global app header. */
export function NavHeaderActions({ children }: { children: React.ReactNode }) {
  return <Portal slotId={ACTIONS_SLOT_ID}>{children}</Portal>;
}

/** Portal children into the `NavHeader`'s title slot (shown next to the brand).
 * Pages typically render into this only when their page-level title has
 * scrolled out of view. */
export function NavHeaderTitle({ children }: { children: React.ReactNode }) {
  return <Portal slotId={TITLE_SLOT_ID}>{children}</Portal>;
}

function Portal({
  slotId,
  children,
}: {
  slotId: string;
  children: React.ReactNode;
}) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setEl(document.getElementById(slotId));
  }, [slotId]);
  return el ? createPortal(children, el) : null;
}

const LINKS: {
  to: "/" | "/planning" | "/investments";
  label: string;
  exact?: boolean;
}[] = [
  { to: "/", label: "Overview", exact: true },
  { to: "/planning", label: "Planning" },
  { to: "/investments", label: "Investments" },
];

export function NavHeader() {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur">
      <nav className="mx-auto flex max-w-6xl items-center gap-1 px-6 py-3">
        <Link to="/" className="mr-4 text-sm font-semibold tracking-tight">
          fire
        </Link>
        <div id={TITLE_SLOT_ID} className="flex items-center" />
        <div id={ACTIONS_SLOT_ID} className="ml-auto flex items-center gap-1" />
        {LINKS.map((l) => (
          <Link
            key={l.to}
            to={l.to}
            activeOptions={{ exact: l.exact ?? false }}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground",
            )}
            activeProps={{ className: "bg-accent text-foreground" }}
          >
            {l.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}

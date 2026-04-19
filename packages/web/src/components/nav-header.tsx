import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/cn";

const ACTIONS_SLOT_ID = "nav-header-actions";

/** Portal children into the `NavHeader`'s right-side actions slot. Used by
 * pages that want page-scoped controls in the global app header. */
export function NavHeaderActions({ children }: { children: React.ReactNode }) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setEl(document.getElementById(ACTIONS_SLOT_ID));
  }, []);
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
        <div id={ACTIONS_SLOT_ID} className="ml-auto flex items-center gap-1" />
      </nav>
    </header>
  );
}

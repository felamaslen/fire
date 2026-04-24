import { useApolloClient, useMutation } from "@apollo/client/react";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  CalendarRange,
  Home as HomeIcon,
  LogOut,
  TrendingUp,
} from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { FragmentOf, graphql, readFragment, ResultOf } from "@/graphql";
import { cn } from "@/lib/cn";
import { RootDocument } from "@/routes/__root";

import { clearToken } from "../auth/token";
import { ThemeToggle } from "./theme-toggle";
import { Button } from "./ui/button";

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
  icon: React.ComponentType<{ className?: string }>;
  exact?: boolean;
}[] = [
  { to: "/", label: "Overview", icon: HomeIcon, exact: true },
  { to: "/planning", label: "Planning", icon: CalendarRange },
  { to: "/investments", label: "Investments", icon: TrendingUp },
];

export const NavHeaderDocument = graphql(`
  fragment NavHeader on Query {
    me {
      token
    }
  }
`);

export function NavHeader({
  data,
}: {
  data: FragmentOf<typeof NavHeaderDocument> | null | undefined;
}) {
  return (
    <header className="fixed inset-x-0 top-0 z-40 border-b bg-background/80 backdrop-blur">
      <nav className="mx-auto flex h-8 max-w-6xl items-center gap-0.5 px-3 sm:h-10 sm:gap-1 sm:px-6">
        <Link
          to="/"
          className="mr-2 text-sm font-semibold tracking-tight sm:mr-4"
        >
          fire
        </Link>
        <div
          id={TITLE_SLOT_ID}
          className="flex items-center whitespace-nowrap"
        />
        <div id={ACTIONS_SLOT_ID} className="ml-auto flex items-center gap-1" />
        {LINKS.map((l) => {
          const Icon = l.icon;
          return (
            <Link
              key={l.to}
              to={l.to}
              activeOptions={{ exact: l.exact ?? false }}
              aria-label={l.label}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground sm:px-3 sm:py-1.5",
              )}
              activeProps={{ className: "bg-accent text-foreground" }}
            >
              <Icon className="h-4 w-4 sm:hidden" />
              <span className="hidden sm:inline">{l.label}</span>
            </Link>
          );
        })}
        <ThemeToggle />
        <LogoutButton data={readFragment(NavHeaderDocument, data)} />
      </nav>
    </header>
  );
}

const LogoutDocument = graphql(`
  mutation Logout {
    logout {
      __typename
    }
  }
`);

function LogoutButton({
  data,
}: {
  data: ResultOf<typeof NavHeaderDocument> | null | undefined;
}) {
  const navigate = useNavigate();
  const apollo = useApolloClient();
  const [logoutMutation] = useMutation(LogoutDocument);
  const isLoggedIn = data?.me?.token != null;
  if (!isLoggedIn) return;
  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-7 w-7 sm:h-9 sm:w-9"
      aria-label="Log out"
      onClick={async () => {
        clearToken();
        await logoutMutation().catch(() => {});
        await apollo.clearStore();
        await navigate({ to: "/login" });
        await apollo.refetchQueries({ include: [RootDocument] });
      }}
    >
      <LogOut />
    </Button>
  );
}

import {
  createFileRoute,
  Link,
  Outlet,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import { Suspense } from "react";

import { Spinner } from "@/components/spinner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/cn";

export const Route = createFileRoute("/net-worth")({
  component: NetWorthDialogLayout,
});

const TABS = [
  { to: "/net-worth/categories", label: "Categories" },
  { to: "/net-worth/entries", label: "Entries" },
] as const;

function NetWorthDialogLayout() {
  const navigate = useNavigate();
  const { pathname } = useLocation();

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) void navigate({ to: "/" });
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Net worth</DialogTitle>
        </DialogHeader>
        <nav className="flex gap-1 border-b">
          {TABS.map((t) => {
            const active = pathname.startsWith(t.to);
            return (
              <Link
                key={t.to}
                to={t.to}
                className={cn(
                  "-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors",
                  active
                    ? "border-foreground text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {t.label}
              </Link>
            );
          })}
        </nav>
        <Suspense fallback={<Spinner />}>
          <Outlet />
        </Suspense>
      </DialogContent>
    </Dialog>
  );
}

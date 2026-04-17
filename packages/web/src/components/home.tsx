import { Link } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";

export function Home() {
  return (
    <main className="mx-auto flex min-h-svh max-w-4xl flex-col items-start justify-center gap-6 p-8">
      <div className="space-y-2">
        <h1 className="text-4xl font-semibold tracking-tight">fire</h1>
        <p className="text-muted-foreground">
          Personal net-worth tracker. Pick up where you left off.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button asChild variant="outline">
          <Link to="/net-worth/categories">Categories</Link>
        </Button>
        <Button asChild variant="outline">
          <Link to="/net-worth/entries">Entries</Link>
        </Button>
      </div>
    </main>
  );
}

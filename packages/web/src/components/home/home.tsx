import { useSuspenseQuery } from "@apollo/client/react";
import { Link } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import { graphql, type ResultOf } from "@/graphql";
import { formatAccountingMoneyRounded } from "@/lib/format";

import {
  NetWorthChart,
  type NetWorthChartBucket,
  NetWorthChartLegend,
  type NetWorthChartPoint,
} from "./net-worth-chart";

const HomeDocument = graphql(`
  query Home {
    netWorthHistory {
      date
      assetsByType {
        type
        amount {
          amount
          currency
        }
      }
      liabilities {
        amount
        currency
      }
      net {
        amount
        currency
      }
    }
    currencyDefault
  }
`);

type HomeData = ResultOf<typeof HomeDocument>;
type HistoryPoint = NonNullable<HomeData["netWorthHistory"]>[number];
type AssetType = HistoryPoint["assetsByType"][number]["type"];

// Ordered bottom-to-top in the stack; first entry sits on the zero line.
const BUCKET_DEFS: { key: AssetType; label: string; color: string }[] = [
  { key: "CASH", label: "Cash", color: "#10b981" }, // emerald-500
  { key: "STOCK", label: "Stock", color: "#0ea5e9" }, // sky-500
  { key: "PENSION", label: "Pension", color: "#8b5cf6" }, // violet-500
  { key: "PROPERTY", label: "Property", color: "#f59e0b" }, // amber-500
  { key: "VEHICLE", label: "Vehicle", color: "#f43f5e" }, // rose-500
  { key: "OPTION", label: "Options", color: "#d946ef" }, // fuchsia-500
  { key: "MISC", label: "Misc", color: "#64748b" }, // slate-500
];

export function Home() {
  const { data } = useSuspenseQuery(HomeDocument);
  const history = data.netWorthHistory ?? [];
  const currency = data.currencyDefault ?? "GBP";

  const usedKeys = new Set<string>();
  for (const p of history) {
    for (const b of p.assetsByType)
      if (b.amount.amount > 0) usedKeys.add(b.type);
  }
  const buckets: NetWorthChartBucket[] = BUCKET_DEFS.filter((b) =>
    usedKeys.has(b.key),
  );

  const points: NetWorthChartPoint[] = history.map((h) => {
    const assetsByKey: Record<string, number> = {};
    for (const b of h.assetsByType) assetsByKey[b.type] = b.amount.amount;
    return {
      date: new Date(`${h.date}T00:00:00Z`),
      assetsByKey,
      liabilities: h.liabilities.amount,
      net: h.net.amount,
    };
  });

  const latest = history.at(-1);
  const prev = history.length > 1 ? history.at(-2) : null;
  const deltaNet = latest && prev ? latest.net.amount - prev.net.amount : null;

  const showLiabilities = history.some((h) => h.liabilities.amount > 0);

  return (
    <main className="mx-auto flex min-h-svh max-w-6xl flex-col gap-6 p-6">
      <header className="space-y-2">
        <h1 className="text-4xl font-semibold tracking-tight">fire</h1>
        <p className="text-muted-foreground">Personal net-worth tracker.</p>
      </header>

      <section className="rounded-lg border bg-card p-5 shadow-sm">
        <div className="flex flex-wrap items-baseline justify-between gap-4">
          <div>
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
              Net worth
            </div>
            <div className="text-3xl font-semibold tabular-nums">
              {latest
                ? formatAccountingMoneyRounded(
                    latest.net.currency,
                    latest.net.amount,
                  )
                : "—"}
            </div>
            {latest && deltaNet !== null && (
              <div
                className={
                  "text-xs tabular-nums " +
                  (deltaNet > 0
                    ? "text-emerald-600 dark:text-emerald-400"
                    : deltaNet < 0
                      ? "text-red-600 dark:text-red-400"
                      : "text-muted-foreground")
                }
              >
                {deltaNet >= 0 ? "+" : ""}
                {formatAccountingMoneyRounded(
                  latest.net.currency,
                  deltaNet,
                )}{" "}
                since previous month
              </div>
            )}
          </div>
          {latest && (
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm tabular-nums">
              <dt className="text-muted-foreground">Assets</dt>
              <dd className="text-right">
                {formatAccountingMoneyRounded(
                  currency,
                  latest.assetsByType.reduce((a, b) => a + b.amount.amount, 0),
                )}
              </dd>
              <dt className="text-muted-foreground">Liabilities</dt>
              <dd className="text-right">
                {formatAccountingMoneyRounded(
                  currency,
                  latest.liabilities.amount,
                )}
              </dd>
            </dl>
          )}
        </div>

        <div className="mt-4 space-y-2">
          <NetWorthChart
            points={points}
            buckets={buckets}
            currency={currency}
            className="w-full"
          />
          <NetWorthChartLegend
            buckets={buckets}
            showLiabilities={showLiabilities}
          />
        </div>
      </section>

      <nav className="flex flex-wrap gap-2">
        <Button asChild variant="outline">
          <Link to="/net-worth/entries">Entries</Link>
        </Button>
        <Button asChild variant="outline">
          <Link to="/net-worth/categories">Categories</Link>
        </Button>
        <Button asChild variant="outline">
          <Link to="/investments">Investments</Link>
        </Button>
        <Button asChild variant="outline">
          <Link to="/planning">Planning</Link>
        </Button>
      </nav>
    </main>
  );
}

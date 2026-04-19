import { useSuspenseQuery } from "@apollo/client/react";
import { Link } from "@tanstack/react-router";
import { Info } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { graphql } from "@/graphql";
import { formatAccountingMoneyRounded } from "@/lib/format";

import {
  ForecastWorkings,
  ForecastWorkingsFragment,
} from "./forecast-workings";
import { NetWorthChart } from "./net-worth-chart";

const HomeDocument = graphql(
  `
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
        assets {
          amount
          currency
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
      netWorthForecast(years: 10, limit: 20) {
        points {
          date
          assetsByType {
            type
            amount {
              amount
              currency
            }
          }
          assets {
            amount
            currency
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
        workings {
          ...ForecastWorkings
        }
      }
      currencyDefault
    }
  `,
  [ForecastWorkingsFragment],
);

// Deep-tone palette — high saturation, low lightness. Reads rich on the
// card background without the neon of Tailwind's mid swatches.
const CASH_COLOR = "#176b4a"; // deep forest green
const STOCK_COLOR = "#4a4a4a"; // medium-dark grey
const PENSION_COLOR = "#1a5490"; // deep blue
const MISC_COLOR = "#5b3a80"; // deep purple
const REMAINDER_COLOR = "#8f6b18"; // deep ochre
const NET_LINE_COLOR = "currentColor";
const ASSETS_COLOR = "#1a5490"; // deep blue
const LIABILITIES_COLOR = "#8f1a1a"; // deep crimson

export function Home() {
  const { data } = useSuspenseQuery(HomeDocument);
  const history = data.netWorthHistory ?? [];
  const forecastPoints = data.netWorthForecast?.points ?? [];
  const currency = data.currencyDefault ?? "GBP";

  // Stitch history + forecast into a single series per bucket. Drop any
  // history point whose month is on or after the forecast's first point
  // (the engine's `asOfMonthStart` is start-of-current-month, which
  // usually overlaps with the latest snapshot).
  const cutoff = forecastPoints[0]?.date ?? null;
  const historyPoints = cutoff
    ? history.filter((h) => h.date < cutoff)
    : history;
  const combined = [...historyPoints, ...forecastPoints];
  const forecastStart = historyPoints.length;

  const dates = combined.map((h) => new Date(`${h.date}T00:00:00Z`));
  const net = combined.map((h) => h.net.amount);
  const assets = combined.map((h) => h.assets.amount);
  const liabilities = combined.map((h) => h.liabilities.amount);

  // Stacks on the main chart, bottom → top. The remainder band is every
  // asset that isn't cash / stock / pension net of all liabilities, so the
  // top of its stack = `net`. When it's negative the band overlays the
  // pension stack as a translucent shadow and the net line dips into it.
  const amountOf = (
    h: (typeof combined)[number],
    type: "CASH" | "STOCK" | "PENSION" | "MISC",
  ) => h.assetsByType.find((b) => b.type === type)?.amount.amount ?? 0;
  const cash = combined.map((h) => amountOf(h, "CASH"));
  const stock = combined.map((h) => amountOf(h, "STOCK"));
  const pension = combined.map((h) => amountOf(h, "PENSION"));
  const misc = combined.map((h) => amountOf(h, "MISC"));
  const cumCash = cash;
  const cumStock = cash.map((v, i) => v + stock[i]);
  const cumPension = cumStock.map((v, i) => v + pension[i]);
  const cumMisc = cumPension.map((v, i) => v + misc[i]);
  // Top of the remainder band equals net worth by construction:
  //   net = cash + stock + pension + misc + remainder
  const cumRemainder = net;

  const latest = history.at(-1);
  const prev = history.length > 1 ? history.at(-2) : null;
  const deltaNet = latest && prev ? latest.net.amount - prev.net.amount : null;

  return (
    <main className="mx-auto flex min-h-svh max-w-6xl flex-col gap-6 p-6">
      <header className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <h1 className="text-4xl font-semibold tracking-tight">Overview</h1>
          <p className="text-muted-foreground">Personal net-worth tracker.</p>
        </div>
        <Button asChild variant="outline">
          <Link to="/net-worth/categories">Edit net worth</Link>
        </Button>
      </header>

      <section className="rounded-lg border bg-card p-5 shadow-sm">
        <div className="flex flex-wrap items-baseline justify-between gap-4">
          <div>
            <div className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-muted-foreground">
              <span>Net worth</span>
              {data.netWorthForecast?.workings && (
                <ForecastInfoButton workings={data.netWorthForecast.workings} />
              )}
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
                {formatAccountingMoneyRounded(currency, latest.assets.amount)}
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
            points={dates}
            series={[
              {
                key: "cash",
                label: "Cash",
                color: CASH_COLOR,
                fill: "zero",
                fillOpacity: 0.7,
                strokeWidth: 0,
                values: cumCash,
                tooltipValues: cash,
              },
              {
                key: "stock",
                label: "Stocks",
                color: STOCK_COLOR,
                fill: "baseline",
                baseline: cumCash,
                values: cumStock,
                tooltipValues: stock,
                fillOpacity: 0.7,
                strokeWidth: 0,
              },
              {
                key: "pension",
                label: "Pension",
                color: PENSION_COLOR,
                fill: "baseline",
                baseline: cumStock,
                values: cumPension,
                tooltipValues: pension,
                fillOpacity: 0.7,
                strokeWidth: 0,
              },
              {
                key: "misc",
                label: "Other",
                color: MISC_COLOR,
                fill: "baseline",
                baseline: cumPension,
                values: cumMisc,
                tooltipValues: misc,
                fillOpacity: 0.7,
                strokeWidth: 0,
              },
              {
                key: "remainder",
                label: "Remaining net equity",
                color: REMAINDER_COLOR,
                // Translucent so the layer beneath shows through when this
                // band is negative and painted on top of it.
                fill: "baseline",
                baseline: cumMisc,
                values: cumRemainder,
                tooltipValues: net.map((n, i) => n - cumMisc[i]),
                fillOpacity: 0.35,
                strokeWidth: 0,
              },
              {
                key: "net",
                label: "Net worth",
                color: NET_LINE_COLOR,
                fill: "none",
                strokeWidth: 1.5,
                values: net,
              },
            ]}
            currency={currency}
            className="w-full"
            forecastStart={forecastStart}
          />
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <span
                className="inline-block h-2 w-3 rounded-sm"
                style={{ background: CASH_COLOR }}
              />
              Cash
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span
                className="inline-block h-2 w-3 rounded-sm"
                style={{ background: STOCK_COLOR }}
              />
              Stocks
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span
                className="inline-block h-2 w-3 rounded-sm"
                style={{ background: PENSION_COLOR }}
              />
              Pension
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span
                className="inline-block h-2 w-3 rounded-sm"
                style={{ background: MISC_COLOR }}
              />
              Other
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span
                className="inline-block h-2 w-3 rounded-sm"
                style={{ background: REMAINDER_COLOR, opacity: 0.5 }}
              />
              Remaining net equity
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block h-0.5 w-3 bg-foreground" />
              Net worth
            </span>
          </div>
        </div>
      </section>

      <section className="rounded-lg border bg-card p-5 shadow-sm">
        <div className="flex items-baseline justify-between gap-4">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            Assets vs liabilities
          </div>
          <div className="flex items-center gap-4 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <span
                className="inline-block h-0.5 w-3"
                style={{ background: ASSETS_COLOR }}
              />
              Assets
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span
                className="inline-block h-0.5 w-3"
                style={{ background: LIABILITIES_COLOR }}
              />
              Liabilities
            </span>
          </div>
        </div>
        <div className="mt-3">
          <NetWorthChart
            points={dates}
            series={[
              {
                key: "assets",
                label: "Assets",
                color: ASSETS_COLOR,
                fill: "zero",
                values: assets,
              },
              {
                key: "liabilities",
                label: "Liabilities",
                color: LIABILITIES_COLOR,
                fill: "zero",
                values: liabilities,
              },
            ]}
            currency={currency}
            className="w-full"
            forecastStart={forecastStart}
          />
        </div>
      </section>
    </main>
  );
}

function ForecastInfoButton({
  workings,
}: {
  workings: React.ComponentProps<typeof ForecastWorkings>["data"];
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex cursor-pointer items-center rounded-sm text-muted-foreground hover:text-foreground"
        aria-label="Forecast workings"
      >
        <Info className="h-3.5 w-3.5" />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Forecast workings</DialogTitle>
            <DialogDescription>
              How the projection is built from your current categories.
            </DialogDescription>
          </DialogHeader>
          <ForecastWorkings data={workings} />
        </DialogContent>
      </Dialog>
    </>
  );
}

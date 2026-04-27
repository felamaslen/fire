import { useMutation, useSuspenseQuery } from "@apollo/client/react";
import { Link } from "@tanstack/react-router";
import { Info, Settings2 } from "lucide-react";
import { useDeferredValue, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { graphql } from "@/graphql";
import { cn } from "@/lib/cn";
import { formatAccountingMoneyRounded } from "@/lib/format";

import {
  ForecastWorkings,
  ForecastWorkingsFragment,
} from "./forecast-workings";
import { LoanOverpaymentCalculatorButton } from "./loan-overpayment-calculator";
import { NetWorthBlockMapButton } from "./net-worth-block-map";
import { NetWorthChart } from "./net-worth-chart";

const HomeDocument = graphql(
  `
    query Home($years: Int!) {
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
      retirementSettings {
        retirementYear
        inflationRate
        drawdownRate
      }
      netWorthForecast(years: $years, limit: 20) {
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
          milestones {
            kind
            date
            categories {
              __typename
              ... on NetWorthCategoryAsset {
                id
                name
              }
              ... on NetWorthCategoryLiability {
                id
                name
              }
              ... on NetWorthCategoryOption {
                id
                name
              }
            }
          }
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

const RetirementSettingsUpdateDocument = graphql(`
  mutation RetirementSettingsUpdate($retirementYear: Int) {
    retirementSettingsUpdate(retirementYear: $retirementYear) {
      retirementYear
    }
  }
`);

const FORECAST_STORAGE_KEY = "fire.home.forecast";
const LOG_SCALE_STORAGE_KEY = "fire.home.log-scale";
const FORECAST_YEARS_STORAGE_KEY = "fire.home.forecast-years";
const FORECAST_YEARS_MIN = 2;
const FORECAST_YEARS_MAX = 30;
const FORECAST_YEARS_DEFAULT = 10;

function usePersistedBool(
  key: string,
  fallback: boolean,
): [boolean, (v: boolean) => void] {
  const [state, setState] = useState<boolean>(() => {
    if (typeof window === "undefined") return fallback;
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : raw === "1";
  });
  const set = (v: boolean) => {
    setState(v);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(key, v ? "1" : "0");
    }
  };
  return [state, set];
}

/**
 * Interpolate a calendar date onto the combined history + forecast chart axis. Returns the fractional index into the chart's `combined` array, or `undefined` when the date falls outside the forecast window. `forecastPoints` is already sorted by ascending date.
 */
function forecastDateToChartIndex(
  target: string,
  forecastPoints: readonly { date: string }[],
  historyLength: number,
): number | undefined {
  if (forecastPoints.length === 0) return undefined;
  const idx = forecastPoints.findIndex((p) => p.date >= target);
  if (idx < 0) return undefined;
  if (idx === 0) return historyLength;
  const prev = forecastPoints[idx - 1].date;
  const curr = forecastPoints[idx].date;
  const span = Date.parse(curr) - Date.parse(prev);
  const frac = span > 0 ? (Date.parse(target) - Date.parse(prev)) / span : 0;
  return historyLength + (idx - 1) + Math.max(0, Math.min(1, frac));
}

function clampYears(n: number): number {
  if (!Number.isFinite(n)) return FORECAST_YEARS_DEFAULT;
  return Math.max(
    FORECAST_YEARS_MIN,
    Math.min(FORECAST_YEARS_MAX, Math.round(n)),
  );
}

function useForecastYears(): [number, (n: number) => void] {
  const [state, setState] = useState<number>(() => {
    if (typeof window === "undefined") return FORECAST_YEARS_DEFAULT;
    const raw = window.localStorage.getItem(FORECAST_YEARS_STORAGE_KEY);
    return raw === null ? FORECAST_YEARS_DEFAULT : clampYears(Number(raw));
  });
  const set = (n: number) => {
    const v = clampYears(n);
    setState(v);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(FORECAST_YEARS_STORAGE_KEY, String(v));
    }
  };
  return [state, set];
}

export function Home() {
  const [showForecast, setShowForecast] = usePersistedBool(
    FORECAST_STORAGE_KEY,
    true,
  );
  const [logScale, setLogScale] = usePersistedBool(LOG_SCALE_STORAGE_KEY, true);
  const [years, setYears] = useForecastYears();
  // Keep a separate local value for the slider thumb so drag updates
  // feel instant, then debounce into `years` (the query variable) so
  // we don't fire a backend round-trip per pixel of drag.
  const [draftYears, setDraftYears] = useState(years);
  useEffect(() => {
    if (draftYears === years) return;
    const id = window.setTimeout(() => setYears(draftYears), 200);
    return () => window.clearTimeout(id);
  }, [draftYears, years, setYears]);
  // Defer the query variable on top of the debounce so the refetch
  // suspends in a non-interrupting pass — the previous chart stays
  // visible while the new horizon loads.
  const deferredYears = useDeferredValue(years);
  const refetching = deferredYears !== years || draftYears !== years;
  const { data } = useSuspenseQuery(HomeDocument, {
    variables: { years: deferredYears },
  });
  const [saveRetirementYear] = useMutation(RetirementSettingsUpdateDocument, {
    refetchQueries: [
      { query: HomeDocument, variables: { years: deferredYears } },
    ],
    awaitRefetchQueries: true,
  });
  const onRetirementYearChange = (year: number | null) => {
    void saveRetirementYear({ variables: { retirementYear: year } });
  };
  const serverRetirementYear = data.retirementSettings?.retirementYear ?? null;
  // During a drag, show the draft year immediately without waiting for the
  // mutation round-trip. Cleared when the server catches up.
  const [draftRetirementYear, setDraftRetirementYear] = useState<number | null>(
    null,
  );
  const retirementYear = draftRetirementYear ?? serverRetirementYear;
  useEffect(() => {
    if (draftRetirementYear === serverRetirementYear) {
      setDraftRetirementYear(null);
    }
  }, [serverRetirementYear, draftRetirementYear]);
  const onRetirementDrag = (date: Date) => {
    setDraftRetirementYear(date.getUTCFullYear());
  };
  const onRetirementDragEnd = (date: Date) => {
    const year = date.getUTCFullYear();
    setDraftRetirementYear(year);
    onRetirementYearChange(year);
  };
  const history = data.netWorthHistory ?? [];
  const forecastPoints = showForecast
    ? (data.netWorthForecast?.points ?? [])
    : [];
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
  const forecastStart = showForecast ? historyPoints.length : undefined;

  // Place a retirement marker at the first forecast point whose month is
  // inside the retirement year. Interpolate between its predecessor and
  // itself so the marker lands on Jan 1 of the retirement year even when
  // the forecast is thinned to a handful of points.
  const retirementStart =
    showForecast && retirementYear != null && forecastPoints.length > 0
      ? forecastDateToChartIndex(
          `${retirementYear}-01-01`,
          forecastPoints,
          historyPoints.length,
        )
      : undefined;

  // Milestones: loans paid off + pensions becoming accessible. Group labels
  // within the `milestones` array are already collapsed on the backend
  // (multiple categories on one (kind, monthIndex) entry). Drop ones that
  // aren't in the visible forecast window.
  const milestones = showForecast
    ? (data.netWorthForecast?.workings.milestones ?? [])
        .map((m) => {
          const index = forecastDateToChartIndex(
            m.date,
            forecastPoints,
            historyPoints.length,
          );
          if (index == null) return null;
          const names = m.categories.map((c) => c.name).join(", ");
          const verb = m.kind === "LOAN_PAID_OFF" ? "paid off" : "accessible";
          const kind: "loan" | "pension" =
            m.kind === "LOAN_PAID_OFF" ? "loan" : "pension";
          return { index, label: `${names} ${verb}`, kind };
        })
        .filter(
          (
            m,
          ): m is { index: number; label: string; kind: "loan" | "pension" } =>
            m != null,
        )
    : undefined;

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
    <main className="mx-auto flex min-h-svh max-w-6xl flex-col gap-3 p-3 sm:gap-6 sm:p-6">
      <header className="flex items-center justify-between gap-4">
        <h1 className="text-xl font-semibold tracking-tight sm:text-4xl">
          Overview
        </h1>
        <Button asChild variant="outline" size="sm" className="sm:h-9">
          <Link to="/net-worth/categories">Edit net worth</Link>
        </Button>
      </header>

      <section
        className={cn(
          "rounded-lg border bg-card p-3 shadow-sm transition-opacity sm:p-5",
          refetching && "opacity-60",
        )}
      >
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
          <div>
            <div className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-muted-foreground">
              <span>Net worth</span>
              {data.netWorthForecast?.workings && (
                <ForecastInfoButton workings={data.netWorthForecast.workings} />
              )}
            </div>
            <div className="flex items-center gap-2">
              <div className="text-2xl font-semibold tabular-nums sm:text-3xl">
                {latest
                  ? formatAccountingMoneyRounded(
                      latest.net.currency,
                      latest.net.amount,
                    )
                  : "—"}
              </div>
              {latest && <NetWorthBlockMapButton />}
              {latest && <LoanOverpaymentCalculatorButton />}
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
          <div className="flex items-center gap-4">
            {latest && (
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm tabular-nums sm:gap-x-6">
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
            <div className="hidden flex-col gap-1 sm:flex">
              <ForecastControls
                showForecast={showForecast}
                setShowForecast={setShowForecast}
                logScale={logScale}
                setLogScale={setLogScale}
                draftYears={draftYears}
                setDraftYears={setDraftYears}
                retirementYear={retirementYear}
                onRetirementYearChange={onRetirementYearChange}
              />
            </div>
            <ForecastSettingsDialog
              showForecast={showForecast}
              setShowForecast={setShowForecast}
              logScale={logScale}
              setLogScale={setLogScale}
              draftYears={draftYears}
              setDraftYears={setDraftYears}
              retirementYear={retirementYear}
              onRetirementYearChange={onRetirementYearChange}
            />
          </div>
        </div>

        <div className="mt-2 space-y-2 sm:mt-4">
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
            retirementStart={retirementStart}
            onRetirementDrag={onRetirementDrag}
            onRetirementDragEnd={onRetirementDragEnd}
            milestones={milestones}
            logY={logScale}
          />
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {(
              [
                { label: "Cash", color: CASH_COLOR, values: cash },
                { label: "Stocks", color: STOCK_COLOR, values: stock },
                { label: "Pension", color: PENSION_COLOR, values: pension },
                { label: "Other", color: MISC_COLOR, values: misc },
                {
                  label: "Remaining net equity",
                  color: REMAINDER_COLOR,
                  opacity: 0.5,
                  values: net.map((n, i) => n - cumMisc[i]),
                },
                {
                  label: "Net worth",
                  color: NET_LINE_COLOR,
                  line: true,
                  values: net,
                },
              ] as const
            )
              .filter((item) => item.values.some((v) => v !== 0))
              .map((item) => (
                <span
                  key={item.label}
                  className="inline-flex items-center gap-1.5"
                >
                  {"line" in item && item.line ? (
                    <span className="inline-block h-0.5 w-3 bg-foreground" />
                  ) : (
                    <span
                      className="inline-block h-2 w-3 rounded-sm"
                      style={{
                        background: item.color,
                        opacity: "opacity" in item ? item.opacity : undefined,
                      }}
                    />
                  )}
                  {item.label}
                </span>
              ))}
          </div>
        </div>
      </section>

      <section
        className={cn(
          "rounded-lg border bg-card p-3 shadow-sm transition-opacity sm:p-5",
          refetching && "opacity-60",
        )}
      >
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
        <div className="mt-2 sm:mt-3">
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
            retirementStart={retirementStart}
            logY={logScale}
          />
        </div>
      </section>
    </main>
  );
}

type ForecastControlsProps = {
  showForecast: boolean;
  setShowForecast: (v: boolean) => void;
  logScale: boolean;
  setLogScale: (v: boolean) => void;
  draftYears: number;
  setDraftYears: (n: number) => void;
  retirementYear: number | null;
  onRetirementYearChange: (year: number | null) => void;
};

function ForecastControls({
  showForecast,
  setShowForecast,
  logScale,
  setLogScale,
  draftYears,
  setDraftYears,
  retirementYear,
  onRetirementYearChange,
}: ForecastControlsProps) {
  return (
    <>
      <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
        <Checkbox
          checked={showForecast}
          onCheckedChange={(v) => setShowForecast(v === true)}
        />
        Forecast
      </label>
      <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
        <Checkbox
          checked={logScale}
          onCheckedChange={(v) => setLogScale(v === true)}
        />
        Log scale
      </label>
      <label
        className={cn(
          "flex items-center gap-2 text-xs text-muted-foreground transition-opacity",
          !showForecast && "pointer-events-none opacity-40",
        )}
      >
        <input
          type="range"
          min={FORECAST_YEARS_MIN}
          max={FORECAST_YEARS_MAX}
          step={1}
          value={draftYears}
          onChange={(e) => setDraftYears(Number(e.target.value))}
          disabled={!showForecast}
          className="w-32 accent-primary"
          aria-label="Forecast horizon (years)"
        />
        <span className="tabular-nums">{draftYears}y</span>
      </label>
      <RetirementYearField
        value={retirementYear}
        disabled={!showForecast}
        onCommit={onRetirementYearChange}
      />
    </>
  );
}

function RetirementYearField({
  value,
  disabled,
  onCommit,
}: {
  value: number | null;
  disabled: boolean;
  onCommit: (year: number | null) => void;
}) {
  const [draft, setDraft] = useState<string>(
    value == null ? "" : String(value),
  );
  useEffect(() => {
    setDraft(value == null ? "" : String(value));
  }, [value]);

  const commit = () => {
    const trimmed = draft.trim();
    const parsed = trimmed === "" ? null : Number(trimmed);
    if (
      parsed != null &&
      (!Number.isFinite(parsed) || parsed < 1900 || parsed > 2200)
    ) {
      setDraft(value == null ? "" : String(value));
      return;
    }
    if (parsed === value) return;
    onCommit(parsed);
  };

  return (
    <label
      className={cn(
        "flex items-center gap-2 text-xs text-muted-foreground transition-opacity",
        disabled && "pointer-events-none opacity-40",
      )}
    >
      <span>Retire in</span>
      <Input
        type="number"
        inputMode="numeric"
        min={1900}
        max={2200}
        step={1}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") setDraft(value == null ? "" : String(value));
        }}
        placeholder="year"
        disabled={disabled}
        aria-label="Retirement year"
        className="h-7 w-20 px-2 py-0 text-xs"
      />
    </label>
  );
}

function ForecastSettingsDialog(props: ForecastControlsProps) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8 sm:hidden"
          aria-label="Chart settings"
        >
          <Settings2 className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-xs">
        <DialogHeader>
          <DialogTitle>Chart settings</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3 text-sm">
          <ForecastControls {...props} />
        </div>
      </DialogContent>
    </Dialog>
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

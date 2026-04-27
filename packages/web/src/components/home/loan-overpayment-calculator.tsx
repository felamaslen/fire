import { useQuery } from "@apollo/client/react";
import { Calculator } from "lucide-react";
import { useMemo, useState } from "react";

import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { graphql, type ResultOf } from "@/graphql";
import { cn } from "@/lib/cn";
import { formatAccountingMoney } from "@/lib/format";

import type { NetWorthChartSeries } from "./net-worth-chart";
import { NetWorthChart } from "./net-worth-chart";

const LoanOverpaymentDocument = graphql(`
  query LoanOverpayment {
    netWorth(last: 120) {
      edges {
        node {
          id
          date
          loans {
            id
            amountHome {
              amount
              currency
            }
            liability {
              id
              name
            }
          }
        }
      }
    }
    netWorthForecast(years: 1, limit: 5) {
      workings {
        categories {
          __typename
          ... on NetWorthForecastLoan {
            category {
              id
              name
            }
            startingBalance {
              amount
              currency
            }
            interestRate
            monthlyRepayment {
              amount
              currency
            }
          }
        }
      }
    }
    currencyDefault
  }
`);

type Result = ResultOf<typeof LoanOverpaymentDocument>;
type Entry = NonNullable<Result["netWorth"]>["edges"][number]["node"];
type ForecastCategory = NonNullable<
  Result["netWorthForecast"]
>["workings"]["categories"][number];
type LoanForecast = Extract<
  ForecastCategory,
  { __typename: "NetWorthForecastLoan" }
>;

/** Saturated, dark-readable palette for individual loan lines. Picked deterministically from the loan id so a given loan keeps its colour across reloads and across hide/show toggles. */
const LOAN_COLORS = [
  "#8f1a1a",
  "#1a5490",
  "#3b6c2a",
  "#7a5b18",
  "#5b3a80",
  "#176b4a",
  "#a83b3b",
  "#1f6b6b",
];

function colorForLoan(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) >>> 0;
  }
  return LOAN_COLORS[h % LOAN_COLORS.length];
}

type Loan = {
  id: string;
  name: string;
  startingBalance: number;
  interestRate: number;
  monthlyRepayment: number;
  history: { date: Date; balance: number }[];
};

function startOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function addMonths(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
}

function buildLoans(entries: Entry[], forecasts: LoanForecast[]): Loan[] {
  const historyByLoan = new Map<string, { date: Date; balance: number }[]>();
  for (const e of entries) {
    const date = new Date(`${e.date}T00:00:00Z`);
    for (const v of e.loans) {
      if (!v.liability) continue;
      const arr = historyByLoan.get(v.liability.id) ?? [];
      arr.push({ date, balance: Math.abs(v.amountHome.amount) });
      historyByLoan.set(v.liability.id, arr);
    }
  }
  // A loan that's absent from the most recent net-worth entry is treated
  // as paid off — the user has implicitly cleared it by no longer
  // recording a balance, so it shouldn't keep being projected forward.
  const latestEntry = entries[entries.length - 1];
  const liveLoanIds = new Set<string>();
  if (latestEntry) {
    for (const v of latestEntry.loans) {
      if (v.liability) liveLoanIds.add(v.liability.id);
    }
  }
  const loans: Loan[] = [];
  for (const f of forecasts) {
    if (!liveLoanIds.has(f.category.id)) continue;
    const history = (historyByLoan.get(f.category.id) ?? []).sort(
      (a, b) => a.date.getTime() - b.date.getTime(),
    );
    loans.push({
      id: f.category.id,
      name: f.category.name,
      startingBalance: f.startingBalance.amount,
      interestRate: f.interestRate,
      monthlyRepayment: f.monthlyRepayment.amount,
      history,
    });
  }
  loans.sort((a, b) => b.startingBalance - a.startingBalance);
  return loans;
}

/** Maximum number of months to project forward — caps long-running interest-only loans (rate > repayment) so the chart x-axis stays bounded. */
const MAX_FORECAST_MONTHS = 12 * 40;

/** Project `months` of monthly balances forward starting from `start`, applying `monthlyRepayment + overpayment` against the `interestRate` each month. Returned array has length `months + 1` (index 0 is the starting balance). The payoff month is returned as `0` so the line touches the axis; every subsequent month is `null` so the line ends there rather than running flat along zero. */
function projectBalance(
  start: number,
  monthlyRepayment: number,
  overpayment: number,
  annualRatePercent: number,
  months: number,
): (number | null)[] {
  const r = annualRatePercent / 100 / 12;
  const out: (number | null)[] = [start];
  let bal = start;
  let cleared = start <= 0;
  for (let i = 0; i < months; i++) {
    if (cleared) {
      out.push(null);
      continue;
    }
    const interest = bal * r;
    const payment = monthlyRepayment + overpayment;
    bal = bal + interest - payment;
    if (bal <= 0) {
      out.push(0);
      cleared = true;
    } else {
      out.push(bal);
    }
  }
  return out;
}

/** Months to pay off the loan with the given total monthly payment (`monthlyRepayment + overpayment`). Returns `null` if the payment doesn't cover monthly interest. */
function monthsToPayoff(
  start: number,
  monthlyRepayment: number,
  overpayment: number,
  annualRatePercent: number,
): number | null {
  if (start <= 0) return 0;
  const r = annualRatePercent / 100 / 12;
  const payment = monthlyRepayment + overpayment;
  if (payment <= start * r) return null;
  let bal = start;
  for (let i = 1; i <= MAX_FORECAST_MONTHS; i++) {
    bal = bal + bal * r - payment;
    if (bal <= 0) return i;
  }
  return null;
}

/** Total amount paid (principal + interest) until the loan clears, with `monthlyRepayment + overpayment` as the monthly outflow. Returns `null` if the payment doesn't cover monthly interest (loan never clears). The final month pays the remaining balance, not a full instalment. */
function totalPaid(
  start: number,
  monthlyRepayment: number,
  overpayment: number,
  annualRatePercent: number,
): number | null {
  if (start <= 0) return 0;
  const r = annualRatePercent / 100 / 12;
  const payment = monthlyRepayment + overpayment;
  if (payment <= start * r) return null;
  let bal = start;
  let total = 0;
  for (let i = 0; i < MAX_FORECAST_MONTHS; i++) {
    if (bal <= 0) return total;
    const due = bal + bal * r;
    const thisPayment = Math.min(payment, due);
    total += thisPayment;
    bal = due - thisPayment;
  }
  return null;
}

export function LoanOverpaymentCalculatorButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex cursor-pointer items-center rounded-sm text-muted-foreground hover:text-foreground"
        aria-label="Loan overpayment calculator"
      >
        <Calculator className="h-3.5 w-3.5" />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex h-svh max-h-none w-screen max-w-none flex-col overflow-hidden rounded-none p-4 sm:h-[90vh] sm:max-h-[90vh] sm:w-[calc(100vw-2rem)] sm:max-w-6xl sm:rounded-lg sm:p-6">
          {open && <CalculatorBody />}
        </DialogContent>
      </Dialog>
    </>
  );
}

function CalculatorBody() {
  const { data, loading, error } = useQuery(LoanOverpaymentDocument);

  const loans = useMemo<Loan[]>(() => {
    if (!data) return [];
    const entries = data.netWorth?.edges.map((e) => e.node) ?? [];
    const cats = data.netWorthForecast?.workings.categories ?? [];
    const forecasts = cats.filter(
      (c): c is LoanForecast => c.__typename === "NetWorthForecastLoan",
    );
    return buildLoans(entries, forecasts);
  }, [data]);

  const currency =
    data?.netWorthForecast?.workings.categories.find(
      (c): c is LoanForecast => c.__typename === "NetWorthForecastLoan",
    )?.startingBalance.currency ??
    data?.currencyDefault ??
    "GBP";

  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [overpayments, setOverpayments] = useState<Map<string, number>>(
    () => new Map(),
  );

  return (
    <>
      <DialogHeader>
        <DialogTitle>Loan overpayment calculator</DialogTitle>
      </DialogHeader>
      <div className="flex min-h-0 flex-1 flex-col">
        {loading && loans.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            Loading…
          </div>
        ) : error ? (
          <div className="py-12 text-center text-sm text-red-600">
            {error.message}
          </div>
        ) : loans.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            No loans tracked. Add a `LOAN` liability with an interest rate to
            see projections here.
          </div>
        ) : (
          <CalculatorContent
            loans={loans}
            currency={currency}
            hidden={hidden}
            setHidden={setHidden}
            overpayments={overpayments}
            setOverpayments={setOverpayments}
          />
        )}
      </div>
    </>
  );
}

function CalculatorContent({
  loans,
  currency,
  hidden,
  setHidden,
  overpayments,
  setOverpayments,
}: {
  loans: Loan[];
  currency: string;
  hidden: Set<string>;
  setHidden: (s: Set<string>) => void;
  overpayments: Map<string, number>;
  setOverpayments: (m: Map<string, number>) => void;
}) {
  const { points, seriesByLoan, forecastStart } = useMemo(() => {
    // Build the unified monthly x-axis: from the earliest snapshot month
    // across all loans, through "today" (start of current month), out to
    // however many months the slowest loan takes to pay off given its
    // current overpayment slider value (capped at MAX_FORECAST_MONTHS).
    const today = startOfMonth(new Date());
    let earliest = today;
    for (const loan of loans) {
      const first = loan.history[0]?.date;
      if (first && first < earliest) earliest = startOfMonth(first);
    }
    // Size the x-axis off each loan's *baseline* (no-overpayment) payoff
    // horizon so dragging the slider doesn't shrink the chart from under
    // the user — the with-overpayment line hits zero earlier inside the
    // same span and the original projection stays fully visible.
    let projectionMonths = 12;
    for (const loan of loans) {
      const m = monthsToPayoff(
        loan.startingBalance,
        loan.monthlyRepayment,
        0,
        loan.interestRate,
      );
      const cap = m ?? MAX_FORECAST_MONTHS;
      if (cap > projectionMonths)
        projectionMonths = Math.min(cap, MAX_FORECAST_MONTHS);
    }
    // A small tail past payoff so the zero-line is visible.
    projectionMonths = Math.min(projectionMonths + 6, MAX_FORECAST_MONTHS);

    const historyMonths: Date[] = [];
    let cursor = earliest;
    while (cursor <= today) {
      historyMonths.push(cursor);
      cursor = addMonths(cursor, 1);
    }
    const forecastDates: Date[] = [];
    for (let i = 1; i <= projectionMonths; i++) {
      forecastDates.push(addMonths(today, i));
    }
    const allPoints = [...historyMonths, ...forecastDates];
    const fStart = historyMonths.length - 1; // last history point doubles as first forecast

    const seriesByLoan = new Map<
      string,
      { values: (number | null)[]; baseline: (number | null)[] | null }
    >();
    for (const loan of loans) {
      // Forward-fill historical balances across the monthly grid. Months
      // before the loan's first observation are `null` so the line begins
      // at the loan's opening balance rather than ramping up from zero.
      const histVals: (number | null)[] = [];
      let lastKnown: number | null = null;
      let hi = 0;
      for (const m of historyMonths) {
        while (
          hi < loan.history.length &&
          startOfMonth(loan.history[hi].date).getTime() <= m.getTime()
        ) {
          lastKnown = loan.history[hi].balance;
          hi++;
        }
        histVals.push(lastKnown);
      }
      const op = overpayments.get(loan.id) ?? 0;
      const projection = projectBalance(
        loan.startingBalance,
        loan.monthlyRepayment,
        op,
        loan.interestRate,
        projectionMonths,
      );
      // `projection[0]` is "today"; we already have a value at the last
      // history point, so drop projection[0] when concatenating.
      const values = [...histVals, ...projection.slice(1)];

      // When an overpayment is set, render a faded baseline (no overpayment)
      // alongside so the user can read the gap as the saving. History is
      // shared, so the baseline is null across history months and anchors
      // at the last observed balance ("today") before diverging.
      let baseline: (number | null)[] | null = null;
      if (op > 0) {
        const baseProjection = projectBalance(
          loan.startingBalance,
          loan.monthlyRepayment,
          0,
          loan.interestRate,
          projectionMonths,
        );
        baseline = histVals.map(() => null);
        baseline[historyMonths.length - 1] = histVals[historyMonths.length - 1];
        for (let k = 1; k <= projectionMonths; k++) {
          baseline.push(baseProjection[k]);
        }
      }
      seriesByLoan.set(loan.id, { values, baseline });
    }

    return { points: allPoints, seriesByLoan, forecastStart: fStart };
  }, [loans, overpayments]);

  const series: NetWorthChartSeries[] = [];
  for (const loan of loans) {
    if (hidden.has(loan.id)) continue;
    const built = seriesByLoan.get(loan.id);
    if (!built) continue;
    const color = colorForLoan(loan.id);
    if (built.baseline) {
      series.push({
        key: `${loan.id}:baseline`,
        label: `${loan.name} (baseline)`,
        color,
        fill: "none",
        strokeWidth: 1.5,
        strokeOpacity: 0.35,
        strokeDasharray: "4 3",
        values: built.baseline,
      });
    }
    series.push({
      key: loan.id,
      label: loan.name,
      color,
      fill: "none",
      strokeWidth: 1.75,
      values: built.values,
    });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
      <NetWorthChart
        points={points}
        series={series}
        currency={currency}
        forecastStart={forecastStart}
      />
      <div className="flex flex-col gap-3">
        {loans.map((loan) => {
          const isHidden = hidden.has(loan.id);
          const op = overpayments.get(loan.id) ?? 0;
          const sliderMax = Math.max(
            500,
            Math.ceil((loan.monthlyRepayment * 5) / 50) * 50,
          );
          const step = Math.max(10, Math.round(sliderMax / 200 / 5) * 5);
          const payoff = monthsToPayoff(
            loan.startingBalance,
            loan.monthlyRepayment,
            op,
            loan.interestRate,
          );
          const baselinePayoff = monthsToPayoff(
            loan.startingBalance,
            loan.monthlyRepayment,
            0,
            loan.interestRate,
          );
          const monthsSaved =
            payoff != null && baselinePayoff != null
              ? baselinePayoff - payoff
              : null;
          const paid = totalPaid(
            loan.startingBalance,
            loan.monthlyRepayment,
            op,
            loan.interestRate,
          );
          const baselinePaid = totalPaid(
            loan.startingBalance,
            loan.monthlyRepayment,
            0,
            loan.interestRate,
          );
          const paidDelta =
            paid != null && baselinePaid != null ? paid - baselinePaid : null;
          return (
            <div
              key={loan.id}
              className={cn(
                "flex flex-col gap-2 rounded-md border p-3",
                isHidden && "opacity-60",
              )}
            >
              <div className="flex items-center justify-between gap-3">
                <label className="flex items-center gap-2 text-sm font-medium">
                  <Checkbox
                    checked={!isHidden}
                    onCheckedChange={(v) => {
                      const next = new Set(hidden);
                      if (v) next.delete(loan.id);
                      else next.add(loan.id);
                      setHidden(next);
                    }}
                  />
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-full"
                    style={{
                      background: colorForLoan(loan.id),
                    }}
                  />
                  <span>{loan.name}</span>
                </label>
                <div className="text-sm tabular-nums text-muted-foreground">
                  {formatAccountingMoney(currency, loan.startingBalance)} ·{" "}
                  {loan.interestRate.toFixed(2)}% ·{" "}
                  {formatAccountingMoney(currency, loan.monthlyRepayment)}/mo
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span className="w-28 shrink-0 text-xs text-muted-foreground">
                  Extra / month
                </span>
                <input
                  type="range"
                  min={0}
                  max={sliderMax}
                  step={step}
                  value={op}
                  onChange={(e) => {
                    const next = new Map(overpayments);
                    const val = Number(e.target.value);
                    if (val === 0) next.delete(loan.id);
                    else next.set(loan.id, val);
                    setOverpayments(next);
                  }}
                  className="flex-1 accent-primary"
                  disabled={isHidden}
                />
                <span className="w-20 shrink-0 text-right text-sm tabular-nums">
                  {formatAccountingMoney(currency, op)}
                </span>
              </div>
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span>
                  {payoff == null
                    ? "Repayment doesn't cover interest — balance never clears."
                    : `Paid off in ${formatMonths(payoff)}`}
                  {paid != null && (
                    <>
                      {" · "}
                      <span className="tabular-nums">
                        {formatAccountingMoney(currency, paid)} total
                      </span>
                    </>
                  )}
                </span>
                <span className="flex items-baseline gap-3">
                  {monthsSaved != null && monthsSaved > 0 && (
                    <span className="text-emerald-700 dark:text-emerald-400">
                      {formatMonths(monthsSaved)} sooner
                    </span>
                  )}
                  {paidDelta != null && paidDelta !== 0 && (
                    <span
                      className={cn(
                        "tabular-nums",
                        paidDelta < 0
                          ? "text-emerald-700 dark:text-emerald-400"
                          : "text-red-700 dark:text-red-400",
                      )}
                    >
                      {paidDelta < 0 ? "−" : "+"}
                      {formatAccountingMoney(
                        currency,
                        Math.abs(paidDelta),
                      )}{" "}
                      {paidDelta < 0 ? "saved" : "extra"} overall
                    </span>
                  )}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function formatMonths(months: number): string {
  if (months < 12) return `${months} month${months === 1 ? "" : "s"}`;
  const y = Math.floor(months / 12);
  const m = months % 12;
  if (m === 0) return `${y} year${y === 1 ? "" : "s"}`;
  return `${y}y ${m}m`;
}

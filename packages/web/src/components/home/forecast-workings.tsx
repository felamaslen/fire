import {
  type FragmentOf,
  graphql,
  readFragment,
  type ResultOf,
} from "@/graphql";
import { formatAccountingMoneyRounded } from "@/lib/format";

export const ForecastWorkingsFragment = graphql(`
  fragment ForecastWorkings on NetWorthForecastWorkings {
    cashflow {
      monthlyIncome {
        amount
        currency
      }
      monthlyBills {
        amount
        currency
      }
      monthlyCreditCardPayoff {
        amount
        currency
      }
      monthlyLoanRepayment {
        amount
        currency
      }
      monthlyInvestmentContribution {
        amount
        currency
      }
      monthlyCashOut {
        amount
        currency
      }
      monthlyNetCashFlow {
        amount
        currency
      }
    }
    categories {
      __typename
      ... on NetWorthForecastGrowthAsset {
        category {
          id
          name
          type
        }
        startingBalance {
          amount
          currency
        }
        growthRate
      }
      ... on NetWorthForecastPortfolio {
        category {
          id
          name
          type
        }
        startingBalance {
          amount
          currency
        }
        xirr
        monthlyContribution {
          amount
          currency
        }
      }
      ... on NetWorthForecastFlatAsset {
        category {
          id
          name
          type
        }
        startingBalance {
          amount
          currency
        }
      }
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
      ... on NetWorthForecastFlatLiability {
        category {
          id
          name
        }
        startingBalance {
          amount
          currency
        }
      }
      ... on NetWorthForecastOptionCategory {
        category {
          id
          name
        }
        startingBalance {
          amount
          currency
        }
      }
    }
  }
`);

type Workings = ResultOf<typeof ForecastWorkingsFragment>;
type Cashflow = Workings["cashflow"];
type Category = Workings["categories"][number];

const ASSET_TYPE_LABELS: Record<string, string> = {
  CASH: "Cash",
  STOCK: "Stocks",
  PENSION: "Pension",
  PROPERTY: "Property",
  VEHICLE: "Vehicle",
  OPTION: "Options",
  MISC: "Other",
};

export function ForecastWorkings({
  data,
}: {
  data: FragmentOf<typeof ForecastWorkingsFragment>;
}) {
  const workings = readFragment(ForecastWorkingsFragment, data);
  return (
    <section className="rounded-lg border bg-card p-5 shadow-sm">
      <header className="mb-4">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">
          Forecast workings
        </div>
        <p className="text-xs text-muted-foreground">
          How every monthly projection is built from your current categories and
          planning history.
        </p>
      </header>
      <CashflowSummary cashflow={workings.cashflow} />
      <CategoryBreakdown categories={workings.categories} />
    </section>
  );
}

function CashflowSummary({ cashflow }: { cashflow: Cashflow }) {
  const currency = cashflow.monthlyIncome.currency;
  const rows: { label: string; amount: number; tone: "in" | "out" }[] = [
    {
      label: "Income (payslip EWMA)",
      amount: cashflow.monthlyIncome.amount,
      tone: "in",
    },
    {
      label: "Bills",
      amount: cashflow.monthlyBills.amount,
      tone: "out",
    },
    {
      label: "Credit-card payoff",
      amount: cashflow.monthlyCreditCardPayoff.amount,
      tone: "out",
    },
    {
      label: "Loan repayment",
      amount: cashflow.monthlyLoanRepayment.amount,
      tone: "out",
    },
    {
      label: "Investment contribution",
      amount: cashflow.monthlyInvestmentContribution.amount,
      tone: "out",
    },
  ];
  const net = cashflow.monthlyNetCashFlow.amount;
  return (
    <div className="mb-6">
      <h3 className="mb-2 text-sm font-medium">Monthly cashflow</h3>
      <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm tabular-nums">
        {rows
          .filter((r) => r.amount !== 0)
          .map((r) => (
            <CashflowRow key={r.label} {...r} currency={currency} />
          ))}
        <dt className="border-t pt-1 font-medium">Net cashflow</dt>
        <dd
          className={
            "border-t pt-1 text-right font-medium " +
            (net > 0
              ? "text-emerald-600 dark:text-emerald-400"
              : net < 0
                ? "text-red-600 dark:text-red-400"
                : "")
          }
        >
          {net >= 0 ? "+" : ""}
          {formatAccountingMoneyRounded(currency, net)}
        </dd>
      </dl>
    </div>
  );
}

function CashflowRow({
  label,
  amount,
  tone,
  currency,
}: {
  label: string;
  amount: number;
  tone: "in" | "out";
  currency: string;
}) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right">
        {tone === "out" ? "−" : "+"}
        {formatAccountingMoneyRounded(currency, amount)}
      </dd>
    </>
  );
}

function CategoryBreakdown({ categories }: { categories: Category[] }) {
  const groups = [
    {
      key: "NetWorthForecastGrowthAsset",
      title: "Appreciating / depreciating assets",
      intro: "Balance compounds monthly at the configured growth rate.",
    },
    {
      key: "NetWorthForecastPortfolio",
      title: "Investment portfolios",
      intro:
        "Balance compounds at the portfolio's XIRR plus monthly contributions.",
    },
    {
      key: "NetWorthForecastLoan",
      title: "Loans",
      intro:
        "Balance compounds at the loan's interest rate; the EWMA of recent repayments knocks it down each month (clamped at zero).",
    },
    {
      key: "NetWorthForecastFlatAsset",
      title: "Flat assets",
      intro:
        "No growth rate or XIRR configured — balance is held at today's value across the forecast.",
    },
    {
      key: "NetWorthForecastFlatLiability",
      title: "Flat liabilities",
      intro:
        "Balance held at today's value. Credit-card balances land here — their spending shows up in the cashflow table above.",
    },
    {
      key: "NetWorthForecastOptionCategory",
      title: "Options",
      intro:
        "Held flat — the forecast doesn't model vesting or price movement.",
    },
  ] as const;

  return (
    <div className="space-y-5">
      {groups.map((g) => {
        const rows = categories.filter((c) => c.__typename === g.key);
        if (rows.length === 0) return null;
        return (
          <div key={g.key}>
            <h3 className="text-sm font-medium">{g.title}</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">{g.intro}</p>
            <ul className="mt-2 divide-y text-sm tabular-nums">
              {rows.map((row) => (
                <CategoryRow key={rowKey(row)} row={row} />
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function rowKey(row: Category): string {
  return row.category.id;
}

function CategoryRow({ row }: { row: Category }) {
  const currency = row.startingBalance.currency;
  const balance = row.startingBalance.amount;
  const balanceText = formatAccountingMoneyRounded(currency, balance);

  switch (row.__typename) {
    case "NetWorthForecastGrowthAsset":
      return (
        <Line
          left={row.category.name}
          leftSub={ASSET_TYPE_LABELS[row.category.type] ?? row.category.type}
          right={balanceText}
          rightSub={`${row.growthRate >= 0 ? "+" : ""}${row.growthRate}% / yr`}
        />
      );
    case "NetWorthForecastPortfolio":
      return (
        <Line
          left={row.category.name}
          leftSub={ASSET_TYPE_LABELS[row.category.type] ?? row.category.type}
          right={balanceText}
          rightSub={
            <>
              XIRR {(row.xirr * 100).toFixed(1)}% / yr
              {row.monthlyContribution.amount !== 0 && (
                <>
                  {" · "}+
                  {formatAccountingMoneyRounded(
                    currency,
                    row.monthlyContribution.amount,
                  )}
                  /mo
                </>
              )}
            </>
          }
        />
      );
    case "NetWorthForecastFlatAsset":
      return (
        <Line
          left={row.category.name}
          leftSub={ASSET_TYPE_LABELS[row.category.type] ?? row.category.type}
          right={balanceText}
        />
      );
    case "NetWorthForecastLoan":
      return (
        <Line
          left={row.category.name}
          right={balanceText}
          rightSub={
            <>
              {row.interestRate}% / yr
              {row.monthlyRepayment.amount > 0 && (
                <>
                  {" · "}−
                  {formatAccountingMoneyRounded(
                    currency,
                    row.monthlyRepayment.amount,
                  )}
                  /mo
                </>
              )}
              {row.monthlyRepayment.amount === 0 && (
                <span className="text-amber-600 dark:text-amber-400">
                  {" "}
                  · no recent payments — balance grows
                </span>
              )}
            </>
          }
        />
      );
    case "NetWorthForecastFlatLiability":
      return <Line left={row.category.name} right={balanceText} />;
    case "NetWorthForecastOptionCategory":
      return <Line left={row.category.name} right={balanceText} />;
  }
}

function Line({
  left,
  leftSub,
  right,
  rightSub,
}: {
  left: React.ReactNode;
  leftSub?: React.ReactNode;
  right: React.ReactNode;
  rightSub?: React.ReactNode;
}) {
  return (
    <li className="flex items-baseline justify-between gap-4 py-1.5">
      <div className="min-w-0 flex-1">
        <div className="truncate">{left}</div>
        {leftSub && (
          <div className="text-xs text-muted-foreground">{leftSub}</div>
        )}
      </div>
      <div className="text-right">
        <div>{right}</div>
        {rightSub && (
          <div className="text-xs text-muted-foreground">{rightSub}</div>
        )}
      </div>
    </li>
  );
}

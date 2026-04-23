import {
  type FragmentOf,
  graphql,
  readFragment,
  type ResultOf,
} from "@/graphql";
import { formatAccountingMoneyRounded } from "@/lib/format";

export const ForecastWorkingsFragment = graphql(`
  fragment ForecastWorkings on NetWorthForecastWorkings {
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
        monthlyBillRepayment {
          amount
          currency
        }
        monthlyPayslipRepayment {
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
    retirement {
      retirementYear
      date
      monthlyIncome {
        amount
        currency
      }
      monthlySpending {
        amount
        currency
      }
      inflationRate
      drawdownRate
    }
  }
`);

type Workings = ResultOf<typeof ForecastWorkingsFragment>;
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
    <div className="space-y-4">
      <header>
        <p className="text-xs text-muted-foreground">
          Cash is held flat pre-retirement — the forecast assumes your
          month-to-month balance stays roughly steady (investment contributions
          plus loan repayments already account for post-spending surplus). Each
          non-cash category evolves independently below.
        </p>
      </header>
      <CategoryBreakdown categories={workings.categories} />
      {workings.retirement && (
        <RetirementSection retirement={workings.retirement} />
      )}
    </div>
  );
}

function RetirementSection({
  retirement,
}: {
  retirement: NonNullable<Workings["retirement"]>;
}) {
  const currency = retirement.monthlySpending.currency;
  return (
    <div>
      <h3 className="text-sm font-medium">
        Retirement ({retirement.retirementYear})
      </h3>
      <p className="mt-0.5 text-xs text-muted-foreground">
        From {retirement.date} income drops to zero. Portfolios continue to grow
        at their existing XIRR but pay out{" "}
        {(retirement.drawdownRate * 100).toFixed(1)}% per year (a
        safe-withdrawal rate applied monthly). Cash absorbs the drawdown minus
        spending and any bill-funded loan repayments still outstanding. Spending
        compounds at {(retirement.inflationRate * 100).toFixed(1)}% per year for
        inflation. Loan repayments funded from payslip deductions stop at
        retirement (no more income to deduct from); loans paid via bills
        continue out of cash.
      </p>
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm tabular-nums">
        <dt className="text-muted-foreground">
          Monthly income (pre-retirement)
        </dt>
        <dd className="text-right">
          {formatAccountingMoneyRounded(
            currency,
            retirement.monthlyIncome.amount,
          )}
        </dd>
        <dt className="text-muted-foreground">Monthly spending (today)</dt>
        <dd className="text-right">
          {formatAccountingMoneyRounded(
            currency,
            retirement.monthlySpending.amount,
          )}
        </dd>
      </dl>
    </div>
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
        "Held at today's value across the forecast — cash, and anything without a growth rate or XIRR.",
    },
    {
      key: "NetWorthForecastFlatLiability",
      title: "Flat liabilities",
      intro:
        "Held at today's value. Credit-card balances land here; the model assumes they're paid off in full each month.",
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
        const rows = categories
          .filter((c) => c.__typename === g.key)
          .filter((c) => c.startingBalance.amount !== 0);
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

import { type FragmentOf, graphql, readFragment } from "@/graphql";
import { formatAccountingMoney } from "@/lib/format";

export const FigureDocument = graphql(`
  fragment Figure on Money {
    amount
    currency
  }
`);

export function Figure({
  data,
  className,
  compact = false,
}: {
  data: FragmentOf<typeof FigureDocument>;
  className?: string;
  /** When `true`, render values compactly (e.g. `£34.2k`, `£1.2m`) with one decimal place. */
  compact?: boolean;
}) {
  const money = readFragment(FigureDocument, data);
  return (
    <span className={className}>
      {formatAccountingMoney(money.currency, money.amount, { compact })}
    </span>
  );
}

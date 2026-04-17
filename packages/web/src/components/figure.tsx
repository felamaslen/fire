import { type FragmentOf, graphql, readFragment } from "@/graphql";

export const FigureDocument = graphql(`
  fragment Figure on Money {
    amount
    currency
  }
`);

/** `Intl.NumberFormat` is expensive to construct; cache one per currency. */
const formatterCache = new Map<string, Intl.NumberFormat>();

function formatter(currency: string): Intl.NumberFormat {
  let f = formatterCache.get(currency);
  if (!f) {
    f = new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    });
    formatterCache.set(currency, f);
  }
  return f;
}

export function Figure({
  data,
  className,
}: {
  data: FragmentOf<typeof FigureDocument>;
  className?: string;
}) {
  const money = readFragment(FigureDocument, data);
  return (
    <span className={className}>{formatter(money.currency).format(money.amount)}</span>
  );
}

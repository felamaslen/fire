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
    // `en-GB` locale is pinned so SSR and CSR produce identical output
    // regardless of Node's / the browser's default locale.
    // `currencySign: "accounting"` wraps negatives in parentheses, e.g.
    // `£(2,702.35)` instead of `-£2,702.35`.
    f = new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency,
      currencySign: "accounting",
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

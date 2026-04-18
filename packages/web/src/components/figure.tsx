import { type FragmentOf, graphql, readFragment } from "@/graphql";

export const FigureDocument = graphql(`
  fragment Figure on Money {
    amount
    currency
  }
`);

/** `Intl.NumberFormat` is expensive to construct; cache one per (currency, compact) pair. */
const formatterCache = new Map<string, Intl.NumberFormat>();

function formatter(currency: string, compact: boolean): Intl.NumberFormat {
  const key = `${currency}|${compact ? "c" : "s"}`;
  let f = formatterCache.get(key);
  if (!f) {
    // `en-GB` locale is pinned so SSR and CSR produce identical output
    // regardless of Node's / the browser's default locale.
    // `currencySign: "accounting"` wraps negatives in parentheses, e.g.
    // `£(2,702.35)` instead of `-£2,702.35`.
    f = new Intl.NumberFormat(
      "en-GB",
      compact
        ? {
            style: "currency",
            currency,
            currencySign: "accounting",
            notation: "compact",
            maximumFractionDigits: 1,
          }
        : {
            style: "currency",
            currency,
            currencySign: "accounting",
            maximumFractionDigits: 2,
          },
    );
    formatterCache.set(key, f);
  }
  return f;
}

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
  const formatted = formatter(money.currency, compact).format(money.amount);
  // `Intl` produces upper-case K / M / B; lower-case matches the product's style.
  const display = compact ? formatted.replace(/([KMBT])/g, (c) => c.toLowerCase()) : formatted;
  return <span className={className}>{display}</span>;
}

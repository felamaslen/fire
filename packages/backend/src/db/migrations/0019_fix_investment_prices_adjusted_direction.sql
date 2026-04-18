-- `priceAdjusted` should normalise historical prices into today's share-count
-- terms — i.e. divide by the product of later splits, not multiply. A £50
-- pre-split price at a 10:1 split becomes £5 when viewed in today's post-split
-- share count, not £500.

CREATE OR REPLACE FUNCTION "InvestmentPrices_computeAdjusted"(
  p_investment_id uuid,
  p_date date,
  p_price double precision
) RETURNS double precision LANGUAGE sql STABLE AS $$
  SELECT p_price / COALESCE(
    (SELECT EXP(SUM(LN(ratio)))
     FROM "InvestmentStockSplits"
     WHERE "investmentId" = p_investment_id AND date > p_date)::double precision,
    1
  );
$$;--> statement-breakpoint

-- Backfill every row so any pre-existing data is re-computed under the new
-- convention. The BEFORE UPDATE trigger overrides whatever we pass so we just
-- poke each row.
UPDATE "InvestmentPrices"
SET "priceAdjusted" = "InvestmentPrices_computeAdjusted"(
  "investmentId", "date", "price"
);

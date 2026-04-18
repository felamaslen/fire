-- Maintain `InvestmentPrices.priceAdjusted` = `price * product(ratio of every split dated strictly after the price's date)`.

CREATE FUNCTION "InvestmentPrices_computeAdjusted"(
  p_investment_id uuid,
  p_date date,
  p_price double precision
) RETURNS double precision LANGUAGE sql STABLE AS $$
  SELECT p_price * COALESCE(
    (SELECT EXP(SUM(LN(ratio)))
     FROM "InvestmentStockSplits"
     WHERE "investmentId" = p_investment_id AND date > p_date)::double precision,
    1
  );
$$;--> statement-breakpoint

CREATE FUNCTION "InvestmentPrices_setAdjusted_fn"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."priceAdjusted" := "InvestmentPrices_computeAdjusted"(
    NEW."investmentId", NEW.date, NEW.price
  );
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "InvestmentPrices_setAdjusted_trg"
BEFORE INSERT OR UPDATE OF price, date, "investmentId" ON "InvestmentPrices"
FOR EACH ROW EXECUTE FUNCTION "InvestmentPrices_setAdjusted_fn"();--> statement-breakpoint

CREATE FUNCTION "InvestmentStockSplits_recomputePrices_fn"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  affected uuid[] := ARRAY[]::uuid[];
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    affected := affected || NEW."investmentId";
  END IF;
  IF TG_OP IN ('DELETE', 'UPDATE') THEN
    affected := affected || OLD."investmentId";
  END IF;

  UPDATE "InvestmentPrices" p
  SET "priceAdjusted" = "InvestmentPrices_computeAdjusted"(p."investmentId", p.date, p.price)
  WHERE p."investmentId" = ANY(affected);

  RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "InvestmentStockSplits_recomputePrices_trg"
AFTER INSERT OR UPDATE OR DELETE ON "InvestmentStockSplits"
FOR EACH ROW EXECUTE FUNCTION "InvestmentStockSplits_recomputePrices_fn"();

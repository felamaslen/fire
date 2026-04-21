ALTER TABLE "InvestmentPrices" ADD COLUMN "isLatest" boolean;--> statement-breakpoint
CREATE UNIQUE INDEX "InvestmentPrices_investmentId_isLatest_uq" ON "InvestmentPrices" USING btree ("investmentId","isLatest") WHERE "InvestmentPrices"."isLatest" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "InvestmentPrices" ADD CONSTRAINT "InvestmentPrices_isLatest_ck" CHECK ("InvestmentPrices"."isLatest" IS NULL OR "InvestmentPrices"."isLatest" = true);--> statement-breakpoint

-- Backfill `isLatest` for every investment with existing price history.
UPDATE "InvestmentPrices" p
SET "isLatest" = true
FROM (
  SELECT DISTINCT ON ("investmentId") id
  FROM "InvestmentPrices"
  ORDER BY "investmentId", date DESC
) latest
WHERE p.id = latest.id;--> statement-breakpoint

-- Trigger: after any insert / update / delete on `InvestmentPrices`, recompute
-- which row is the "latest" for the affected investment(s). The partial unique
-- index on `(investmentId, isLatest) WHERE isLatest IS NOT NULL` would reject
-- a naive "flip the new winner to true" before the old winner is cleared, so
-- the function clears `isLatest` on every row of the affected investment first,
-- then sets it back on the single row with the greatest date.
CREATE FUNCTION "InvestmentPrices_setIsLatest_fn"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  affected uuid[] := ARRAY[]::uuid[];
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    affected := affected || NEW."investmentId";
  END IF;
  IF TG_OP IN ('DELETE', 'UPDATE') THEN
    affected := affected || OLD."investmentId";
  END IF;

  UPDATE "InvestmentPrices"
  SET "isLatest" = NULL
  WHERE "investmentId" = ANY(affected) AND "isLatest" IS NOT NULL;

  UPDATE "InvestmentPrices" p
  SET "isLatest" = true
  FROM (
    SELECT DISTINCT ON ("investmentId") id
    FROM "InvestmentPrices"
    WHERE "investmentId" = ANY(affected)
    ORDER BY "investmentId", date DESC
  ) latest
  WHERE p.id = latest.id;

  RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "InvestmentPrices_setIsLatest_trg"
AFTER INSERT OR UPDATE OF "investmentId", date OR DELETE ON "InvestmentPrices"
FOR EACH ROW EXECUTE FUNCTION "InvestmentPrices_setIsLatest_fn"();
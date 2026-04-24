-- Convert `InvestmentPrices_setIsLatest_trg` from FOR EACH ROW to FOR EACH
-- STATEMENT with transition tables. The row-level version fired the function
-- 2500× on a 10-year daily-price bulk insert and ran two full-table updates
-- each time — O(N²) behaviour that made demo seeding take tens of seconds per
-- ticker. Statement-level fires once per INSERT regardless of row count, and
-- collapses all affected `investmentId`s into a single pair of UPDATEs.

DROP TRIGGER "InvestmentPrices_setIsLatest_trg" ON "InvestmentPrices";--> statement-breakpoint
DROP FUNCTION "InvestmentPrices_setIsLatest_fn"();--> statement-breakpoint

CREATE FUNCTION "InvestmentPrices_setIsLatest_stmt_fn"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  affected uuid[] := ARRAY[]::uuid[];
BEGIN
  -- The function re-enters via its own UPDATEs below. Without a column list
  -- (not permitted on transition-table triggers) the UPDATE trigger fires on
  -- every UPDATE including `isLatest = …`. Guard on `pg_trigger_depth()` so
  -- only the outermost call does any work.
  IF pg_trigger_depth() > 1 THEN
    RETURN NULL;
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    affected := affected || ARRAY(SELECT DISTINCT "investmentId" FROM new_rows);
  END IF;
  IF TG_OP IN ('DELETE', 'UPDATE') THEN
    affected := affected || ARRAY(SELECT DISTINCT "investmentId" FROM old_rows);
  END IF;
  IF cardinality(affected) = 0 THEN
    RETURN NULL;
  END IF;

  -- Clear every `isLatest` on the affected investments first so the partial
  -- unique index on `(investmentId, isLatest) WHERE isLatest IS NOT NULL`
  -- doesn't reject the second UPDATE below.
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

CREATE TRIGGER "InvestmentPrices_setIsLatest_ins_trg"
AFTER INSERT ON "InvestmentPrices"
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION "InvestmentPrices_setIsLatest_stmt_fn"();--> statement-breakpoint

-- Postgres forbids column lists on UPDATE triggers that use transition tables,
-- so we fire on any UPDATE and let the function do the work. The affected-set
-- computation is cheap; the subsequent UPDATEs only touch rows for those
-- `investmentId`s, so a no-op update (e.g. changing only `price`) costs one
-- index scan per affected investment.
CREATE TRIGGER "InvestmentPrices_setIsLatest_upd_trg"
AFTER UPDATE ON "InvestmentPrices"
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION "InvestmentPrices_setIsLatest_stmt_fn"();--> statement-breakpoint

CREATE TRIGGER "InvestmentPrices_setIsLatest_del_trg"
AFTER DELETE ON "InvestmentPrices"
REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT EXECUTE FUNCTION "InvestmentPrices_setIsLatest_stmt_fn"();

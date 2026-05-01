DROP VIEW if EXISTS "public"."InvestmentPortfolioDailyBreakdown";

CREATE TABLE "public"."InvestmentValuePoints" (
  "id" uuid NOT NULL DEFAULT uuidv7(),
  "investmentId" uuid NOT NULL,
  "assetId" uuid NOT NULL,
  "date" date NOT NULL,
  "units" double precision NOT NULL,
  "value" bigint NOT NULL,
  "currency" "CurrencyCode" NOT NULL,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "InvestmentValuePoints_assetId_date_idx" ON public."InvestmentValuePoints" USING btree ("assetId", date);

CREATE UNIQUE INDEX "InvestmentValuePoints_investmentId_assetId_date_uq" ON public."InvestmentValuePoints" USING btree ("investmentId", "assetId", date);

CREATE INDEX "InvestmentValuePoints_investmentId_date_idx" ON public."InvestmentValuePoints" USING btree ("investmentId", date);

CREATE UNIQUE INDEX "InvestmentValuePoints_pkey" ON public."InvestmentValuePoints" USING btree (id);

ALTER TABLE "public"."InvestmentValuePoints"
ADD CONSTRAINT "InvestmentValuePoints_pkey" PRIMARY KEY USING index "InvestmentValuePoints_pkey";

ALTER TABLE "public"."InvestmentValuePoints"
ADD CONSTRAINT "InvestmentValuePoints_assetId_NetWorthCategoryAssets_id_fk" FOREIGN KEY ("assetId") REFERENCES "NetWorthCategoryAssets" (id) ON DELETE CASCADE NOT valid;

ALTER TABLE "public"."InvestmentValuePoints" validate CONSTRAINT "InvestmentValuePoints_assetId_NetWorthCategoryAssets_id_fk";

ALTER TABLE "public"."InvestmentValuePoints"
ADD CONSTRAINT "InvestmentValuePoints_investmentId_Investments_id_fk" FOREIGN KEY ("investmentId") REFERENCES "Investments" (id) ON DELETE CASCADE NOT valid;

ALTER TABLE "public"."InvestmentValuePoints" validate CONSTRAINT "InvestmentValuePoints_investmentId_Investments_id_fk";

SET
  check_function_bodies = off;

CREATE OR REPLACE FUNCTION public."InvestmentValuePoints_refreshFromTrigger_fn" () RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  affected uuid[] := ARRAY[]::uuid[];
  from_date date := NULL;
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN NULL;
  END IF;

  -- Splits change every historic priceAdjusted and every historic
  -- adjUnits multiplier — leave from_date NULL so refresh_fn rebuilds
  -- the entire history for the affected investments. For Tx/Prices we
  -- gather MIN(date) across both transition tables; that's the earliest
  -- date whose IVP row could possibly change.
  IF TG_TABLE_NAME = 'InvestmentStockSplits' THEN
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
      affected := affected || ARRAY(SELECT DISTINCT "investmentId" FROM new_rows);
    END IF;
    IF TG_OP IN ('DELETE', 'UPDATE') THEN
      affected := affected || ARRAY(SELECT DISTINCT "investmentId" FROM old_rows);
    END IF;
  ELSE
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
      affected := affected || ARRAY(SELECT DISTINCT "investmentId" FROM new_rows);
      from_date := LEAST(from_date, (SELECT MIN(date) FROM new_rows));
    END IF;
    IF TG_OP IN ('DELETE', 'UPDATE') THEN
      affected := affected || ARRAY(SELECT DISTINCT "investmentId" FROM old_rows);
      from_date := LEAST(from_date, (SELECT MIN(date) FROM old_rows));
    END IF;
  END IF;

  IF cardinality(affected) = 0 THEN
    RETURN NULL;
  END IF;

  PERFORM "InvestmentValuePoints_refresh_fn"(
    ARRAY(SELECT DISTINCT unnest(affected)),
    from_date
  );
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public."InvestmentValuePoints_refresh_fn" (p_ids UUID[], p_from_date date DEFAULT NULL::date) RETURNS void LANGUAGE plpgsql AS $function$
BEGIN
  IF cardinality(p_ids) = 0 THEN
    RETURN;
  END IF;

  IF p_from_date IS NULL THEN
    DELETE FROM "InvestmentValuePoints" WHERE "investmentId" = ANY(p_ids);
  ELSE
    DELETE FROM "InvestmentValuePoints"
     WHERE "investmentId" = ANY(p_ids)
       AND date >= p_from_date;
  END IF;

  INSERT INTO "InvestmentValuePoints"
    ("investmentId", "assetId", "date", "units", "value", "currency")
  WITH
    -- Per (investmentId, assetId): the date band to materialise.
    --
    -- first_date is the earliest day we re-insert for. It's clamped so we
    -- never insert rows for dates the caller asked us not to touch
    -- (>= p_from_date), but ALSO clamped so that if the new write extends
    -- the IVP series past the previously-materialised last_date, the gap
    -- between the surviving max IVP date and p_from_date gets filled in.
    -- Without this clamp, inserting a price that pushes last_date into a
    -- previously-unmaterialised future would leave the days between the
    -- old last_date and the new price absent from IVP.
    --
    -- last_date is max(latest tx, latest price) so days after the last
    -- "interesting" event aren't materialised (charts forward-fill).
    scope AS (
      SELECT
        t."investmentId",
        t."assetId",
        i.currency,
        GREATEST(
          MIN(t.date),
          LEAST(
            COALESCE(p_from_date, '0001-01-01'::date),
            COALESCE(
              (SELECT MAX(ivp.date) + 1
               FROM "InvestmentValuePoints" ivp
               WHERE ivp."investmentId" = t."investmentId"
                 AND ivp."assetId" = t."assetId"),
              '0001-01-01'::date
            )
          )
        ) AS first_date,
        GREATEST(
          MAX(t.date),
          (SELECT MAX(p.date) FROM "InvestmentPrices" p
            WHERE p."investmentId" = t."investmentId")
        ) AS last_date
      FROM "InvestmentTransactions" t
      INNER JOIN "Investments" i ON i.id = t."investmentId"
      WHERE t."investmentId" = ANY(p_ids)
      GROUP BY t."investmentId", t."assetId", i.currency
    ),
    days AS (
      SELECT s."investmentId", s."assetId", s.currency, gs::date AS date
      FROM scope s,
           generate_series(s.first_date, s.last_date, '1 day'::interval) gs
      WHERE s.first_date <= s.last_date
    ),
    -- Split-adjusted units cumulative through each day. Same shape as
    -- the tx_adj CTE in loadInvestmentStats — keep the ROUND(..., 6) so
    -- floating-point drift in EXP(SUM(LN(...))) doesn't surface as
    -- non-integer unit counts.
    units_per_day AS (
      SELECT
        d."investmentId", d."assetId", d.currency, d.date,
        COALESCE(SUM(
          ROUND((t.units * COALESCE(
            EXP((SELECT SUM(LN(s.ratio::double precision))
                 FROM "InvestmentStockSplits" s
                 WHERE s."investmentId" = t."investmentId"
                   AND s.date > t.date)),
            1
          ))::numeric, 6)
        ), 0)::double precision AS units
      FROM days d
      LEFT JOIN "InvestmentTransactions" t
        ON t."investmentId" = d."investmentId"
       AND t."assetId" = d."assetId"
       AND t.date <= d.date
      GROUP BY d."investmentId", d."assetId", d.currency, d.date
    ),
    -- Latest price ≤ d.date per investment. The (investmentId, date)
    -- unique index serves the ORDER BY DESC LIMIT 1 lookup directly.
    price_per_day AS (
      SELECT u.*,
             (SELECT p."priceAdjusted"
              FROM "InvestmentPrices" p
              WHERE p."investmentId" = u."investmentId"
                AND p.date <= u.date
              ORDER BY p.date DESC
              LIMIT 1) AS price_adj
      FROM units_per_day u
    )
  SELECT
    "investmentId", "assetId", date, units,
    CASE
      WHEN units = 0 THEN 0::bigint
      ELSE ROUND(units * price_adj)::bigint
    END AS "value",
    currency
  FROM price_per_day
  WHERE units = 0 OR price_adj IS NOT NULL;
END;
$function$;

CREATE TRIGGER "InvestmentPrices_refreshValuePoints_del_trg"
AFTER DELETE ON public."InvestmentPrices" REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
EXECUTE FUNCTION "InvestmentValuePoints_refreshFromTrigger_fn" ();

CREATE TRIGGER "InvestmentPrices_refreshValuePoints_ins_trg"
AFTER INSERT ON public."InvestmentPrices" REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION "InvestmentValuePoints_refreshFromTrigger_fn" ();

CREATE TRIGGER "InvestmentPrices_refreshValuePoints_upd_trg"
AFTER
UPDATE ON public."InvestmentPrices" REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION "InvestmentValuePoints_refreshFromTrigger_fn" ();

CREATE TRIGGER "InvestmentStockSplits_refreshValuePoints_del_trg"
AFTER DELETE ON public."InvestmentStockSplits" REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
EXECUTE FUNCTION "InvestmentValuePoints_refreshFromTrigger_fn" ();

CREATE TRIGGER "InvestmentStockSplits_refreshValuePoints_ins_trg"
AFTER INSERT ON public."InvestmentStockSplits" REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION "InvestmentValuePoints_refreshFromTrigger_fn" ();

CREATE TRIGGER "InvestmentStockSplits_refreshValuePoints_upd_trg"
AFTER
UPDATE ON public."InvestmentStockSplits" REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION "InvestmentValuePoints_refreshFromTrigger_fn" ();

CREATE TRIGGER "InvestmentTransactions_refreshValuePoints_del_trg"
AFTER DELETE ON public."InvestmentTransactions" REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
EXECUTE FUNCTION "InvestmentValuePoints_refreshFromTrigger_fn" ();

CREATE TRIGGER "InvestmentTransactions_refreshValuePoints_ins_trg"
AFTER INSERT ON public."InvestmentTransactions" REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION "InvestmentValuePoints_refreshFromTrigger_fn" ();

CREATE TRIGGER "InvestmentTransactions_refreshValuePoints_upd_trg"
AFTER
UPDATE ON public."InvestmentTransactions" REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION "InvestmentValuePoints_refreshFromTrigger_fn" ();

-- Backfill: refresh the summary for every existing investment now that the
-- table and triggers exist. From this point on the triggers keep it fresh.
SELECT "InvestmentValuePoints_refresh_fn" (ARRAY(SELECT id FROM "Investments"));

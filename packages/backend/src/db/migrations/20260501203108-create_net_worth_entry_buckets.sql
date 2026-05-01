CREATE TYPE "public"."netWorthHistoryBucket" AS enum(
  'CASH',
  'STOCK',
  'OPTION',
  'PENSION',
  'PROPERTY',
  'VEHICLE',
  'MISC',
  'LIABILITY'
);

CREATE UNLOGGED TABLE "public"."NetWorthEntryBuckets" (
  "entryId" uuid NOT NULL,
  "bucket" "netWorthHistoryBucket" NOT NULL,
  "amountHomeMinor" bigint NOT NULL,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "NetWorthEntryBuckets_pk" ON public."NetWorthEntryBuckets" USING btree ("entryId", bucket);

ALTER TABLE "public"."NetWorthEntryBuckets"
ADD CONSTRAINT "NetWorthEntryBuckets_pk" PRIMARY KEY USING index "NetWorthEntryBuckets_pk";

ALTER TABLE "public"."NetWorthEntryBuckets"
ADD CONSTRAINT "NetWorthEntryBuckets_entryId_NetWorthEntries_id_fk" FOREIGN KEY ("entryId") REFERENCES "NetWorthEntries" (id) ON DELETE CASCADE NOT valid;

ALTER TABLE "public"."NetWorthEntryBuckets" validate CONSTRAINT "NetWorthEntryBuckets_entryId_NetWorthEntries_id_fk";

SET
  check_function_bodies = off;

CREATE OR REPLACE FUNCTION public."Currency_scale" (p_code "CurrencyCode") RETURNS integer LANGUAGE sql IMMUTABLE AS $function$
  SELECT CASE p_code::text
    WHEN 'AED' THEN 2
    WHEN 'ARS' THEN 2
    WHEN 'AUD' THEN 2
    WHEN 'BDT' THEN 2
    WHEN 'BHD' THEN 3
    WHEN 'BRL' THEN 2
    WHEN 'CAD' THEN 2
    WHEN 'CHF' THEN 2
    WHEN 'CLP' THEN 0
    WHEN 'CNY' THEN 2
    WHEN 'COP' THEN 2
    WHEN 'CZK' THEN 2
    WHEN 'DKK' THEN 2
    WHEN 'EGP' THEN 2
    WHEN 'EUR' THEN 2
    WHEN 'GBP' THEN 2
    WHEN 'GHS' THEN 2
    WHEN 'HKD' THEN 2
    WHEN 'HUF' THEN 2
    WHEN 'ILS' THEN 2
    WHEN 'INR' THEN 2
    WHEN 'ISK' THEN 0
    WHEN 'JOD' THEN 3
    WHEN 'JPY' THEN 0
    WHEN 'KES' THEN 2
    WHEN 'KRW' THEN 0
    WHEN 'KWD' THEN 3
    WHEN 'LKR' THEN 2
    WHEN 'MAD' THEN 2
    WHEN 'MXN' THEN 2
    WHEN 'MYR' THEN 2
    WHEN 'NGN' THEN 2
    WHEN 'NOK' THEN 2
    WHEN 'NZD' THEN 2
    WHEN 'OMR' THEN 3
    WHEN 'PEN' THEN 2
    WHEN 'PHP' THEN 2
    WHEN 'PKR' THEN 2
    WHEN 'PLN' THEN 2
    WHEN 'QAR' THEN 2
    WHEN 'RON' THEN 2
    WHEN 'RSD' THEN 2
    WHEN 'RUB' THEN 2
    WHEN 'SAR' THEN 2
    WHEN 'SCR' THEN 2
    WHEN 'SEK' THEN 2
    WHEN 'SGD' THEN 2
    WHEN 'THB' THEN 2
    WHEN 'TND' THEN 3
    WHEN 'TRY' THEN 2
    WHEN 'TWD' THEN 2
    WHEN 'UAH' THEN 2
    WHEN 'USD' THEN 2
    WHEN 'UYU' THEN 2
    WHEN 'VES' THEN 2
    WHEN 'VND' THEN 0
    WHEN 'ZAR' THEN 2
  END;
$function$;

CREATE OR REPLACE FUNCTION public."NetWorthEntryBuckets_refreshFromTrigger_fn" () RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  affected uuid[] := ARRAY[]::uuid[];
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN NULL;
  END IF;

  IF TG_TABLE_NAME = 'NetWorthValues' THEN
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
      affected := affected || ARRAY(SELECT DISTINCT "entryId" FROM new_rows);
    END IF;
    IF TG_OP IN ('DELETE', 'UPDATE') THEN
      affected := affected || ARRAY(SELECT DISTINCT "entryId" FROM old_rows);
    END IF;
  ELSIF TG_TABLE_NAME = 'NetWorthValueAmounts' THEN
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
      affected := affected || ARRAY(
        SELECT DISTINCT v."entryId"
          FROM new_rows nr
          INNER JOIN "NetWorthValues" v ON v.id = nr."valueId"
      );
    END IF;
    IF TG_OP IN ('DELETE', 'UPDATE') THEN
      affected := affected || ARRAY(
        SELECT DISTINCT v."entryId"
          FROM old_rows o
          INNER JOIN "NetWorthValues" v ON v.id = o."valueId"
      );
    END IF;
  ELSIF TG_TABLE_NAME = 'NetWorthCurrencyRates' THEN
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
      affected := affected || ARRAY(SELECT DISTINCT "entryId" FROM new_rows);
    END IF;
    IF TG_OP IN ('DELETE', 'UPDATE') THEN
      affected := affected || ARRAY(SELECT DISTINCT "entryId" FROM old_rows);
    END IF;
  ELSIF TG_TABLE_NAME = 'NetWorthCategoryAssets' THEN
    -- Only re-bucket when type actually changed; other column edits
    -- (name, growthRate, accessibleFrom) don't affect the totals.
    affected := affected || ARRAY(
      SELECT DISTINCT v."entryId"
        FROM new_rows nr
        INNER JOIN old_rows o ON o.id = nr.id
        INNER JOIN "NetWorthValues" v ON v."categoryAssetId" = nr.id
       WHERE nr.type IS DISTINCT FROM o.type
    );
  ELSIF TG_TABLE_NAME = 'NetWorthCategoryLiabilities' THEN
    -- Only re-bucket when skip actually changed; other column edits
    -- (name, interestRate, billedFromAccountId) don't affect the totals.
    affected := affected || ARRAY(
      SELECT DISTINCT v."entryId"
        FROM new_rows nr
        INNER JOIN old_rows o ON o.id = nr.id
        INNER JOIN "NetWorthValues" v ON v."categoryLiabilityId" = nr.id
       WHERE nr.skip IS DISTINCT FROM o.skip
    );
  END IF;

  IF cardinality(affected) = 0 THEN
    RETURN NULL;
  END IF;

  PERFORM "NetWorthEntryBuckets_refresh_fn"(ARRAY(SELECT DISTINCT unnest(affected)));
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public."NetWorthEntryBuckets_refresh_fn" (p_entry_ids UUID[]) RETURNS void LANGUAGE plpgsql AS $function$
BEGIN
  IF cardinality(p_entry_ids) = 0 THEN
    RETURN;
  END IF;

  DELETE FROM "NetWorthEntryBuckets" WHERE "entryId" = ANY(p_entry_ids);

  INSERT INTO "NetWorthEntryBuckets" ("entryId", bucket, "amountHomeMinor")
  WITH converted AS (
    SELECT
      v."entryId",
      CASE
        WHEN v."categoryLiabilityId" IS NOT NULL THEN 'LIABILITY'::"netWorthHistoryBucket"
        WHEN v."categoryOptionId"    IS NOT NULL THEN 'OPTION'::"netWorthHistoryBucket"
        ELSE ca.type::text::"netWorthHistoryBucket"
      END AS bucket,
      cl.skip AS liability_skip,
      ROUND(
        (a.amount::numeric / power(10, "Currency_scale"(a.currency))::numeric)
        * COALESCE(
            CASE WHEN a.currency = 'GBP'::"CurrencyCode" THEN 1::numeric END,
            (SELECT r.rate
               FROM "NetWorthCurrencyRates" r
              WHERE r."entryId" = v."entryId"
                AND r.base = 'GBP'::"CurrencyCode"
                AND r.currency = a.currency),
            (SELECT (1::numeric / r.rate)
               FROM "NetWorthCurrencyRates" r
              WHERE r."entryId" = v."entryId"
                AND r.currency = 'GBP'::"CurrencyCode"
                AND r.base = a.currency)
          )
        * power(10, "Currency_scale"('GBP'::"CurrencyCode"))::numeric
      )::bigint AS home_minor,
      v."categoryLiabilityId" IS NOT NULL AS is_liability
    FROM "NetWorthValues" v
    INNER JOIN "NetWorthValueAmounts" a ON a."valueId" = v.id
    LEFT JOIN "NetWorthCategoryAssets" ca ON ca.id = v."categoryAssetId"
    LEFT JOIN "NetWorthCategoryLiabilities" cl ON cl.id = v."categoryLiabilityId"
    WHERE v."entryId" = ANY(p_entry_ids)
  )
  SELECT
    "entryId",
    bucket,
    SUM(CASE WHEN is_liability THEN ABS(home_minor) ELSE home_minor END)::bigint AS "amountHomeMinor"
  FROM converted
  WHERE NOT (is_liability AND liability_skip)
    AND home_minor IS NOT NULL
  GROUP BY "entryId", bucket
  HAVING SUM(CASE WHEN is_liability THEN ABS(home_minor) ELSE home_minor END) <> 0;
END;
$function$;

CREATE TRIGGER "NetWorthCategoryAssets_refreshBuckets_upd_trg"
AFTER
UPDATE ON public."NetWorthCategoryAssets" REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION "NetWorthEntryBuckets_refreshFromTrigger_fn" ();

CREATE TRIGGER "NetWorthCategoryLiabilities_refreshBuckets_upd_trg"
AFTER
UPDATE ON public."NetWorthCategoryLiabilities" REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION "NetWorthEntryBuckets_refreshFromTrigger_fn" ();

CREATE TRIGGER "NetWorthCurrencyRates_refreshBuckets_del_trg"
AFTER DELETE ON public."NetWorthCurrencyRates" REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
EXECUTE FUNCTION "NetWorthEntryBuckets_refreshFromTrigger_fn" ();

CREATE TRIGGER "NetWorthCurrencyRates_refreshBuckets_ins_trg"
AFTER INSERT ON public."NetWorthCurrencyRates" REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION "NetWorthEntryBuckets_refreshFromTrigger_fn" ();

CREATE TRIGGER "NetWorthCurrencyRates_refreshBuckets_upd_trg"
AFTER
UPDATE ON public."NetWorthCurrencyRates" REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION "NetWorthEntryBuckets_refreshFromTrigger_fn" ();

CREATE TRIGGER "NetWorthValueAmounts_refreshBuckets_del_trg"
AFTER DELETE ON public."NetWorthValueAmounts" REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
EXECUTE FUNCTION "NetWorthEntryBuckets_refreshFromTrigger_fn" ();

CREATE TRIGGER "NetWorthValueAmounts_refreshBuckets_ins_trg"
AFTER INSERT ON public."NetWorthValueAmounts" REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION "NetWorthEntryBuckets_refreshFromTrigger_fn" ();

CREATE TRIGGER "NetWorthValueAmounts_refreshBuckets_upd_trg"
AFTER
UPDATE ON public."NetWorthValueAmounts" REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION "NetWorthEntryBuckets_refreshFromTrigger_fn" ();

CREATE TRIGGER "NetWorthValues_refreshBuckets_del_trg"
AFTER DELETE ON public."NetWorthValues" REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
EXECUTE FUNCTION "NetWorthEntryBuckets_refreshFromTrigger_fn" ();

CREATE TRIGGER "NetWorthValues_refreshBuckets_ins_trg"
AFTER INSERT ON public."NetWorthValues" REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION "NetWorthEntryBuckets_refreshFromTrigger_fn" ();

CREATE TRIGGER "NetWorthValues_refreshBuckets_upd_trg"
AFTER
UPDATE ON public."NetWorthValues" REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION "NetWorthEntryBuckets_refreshFromTrigger_fn" ();

-- Backfill: refresh the summary for every existing entry now that the
-- table and triggers exist. From this point on the triggers keep it fresh.
SELECT "NetWorthEntryBuckets_refresh_fn" (ARRAY(SELECT id FROM "NetWorthEntries"));

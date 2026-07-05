SET
  check_function_bodies = off;

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
    -- Re-bucket when skip or type changed; type decides whether the balance
    -- folds into CASH (CREDIT_CARD) or lands in LIABILITY. Other column edits
    -- (name, interestRate, billedFromAccountId) don't affect the totals.
    affected := affected || ARRAY(
      SELECT DISTINCT v."entryId"
        FROM new_rows nr
        INNER JOIN old_rows o ON o.id = nr.id
        INNER JOIN "NetWorthValues" v ON v."categoryLiabilityId" = nr.id
       WHERE nr.skip IS DISTINCT FROM o.skip
          OR nr.type IS DISTINCT FROM o.type
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
        WHEN cl.type = 'CREDIT_CARD' THEN 'CASH'::"netWorthHistoryBucket"
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
      v."categoryLiabilityId" IS NOT NULL AS is_liability,
      COALESCE(cl.type = 'CREDIT_CARD', false) AS is_credit_card
    FROM "NetWorthValues" v
    INNER JOIN "NetWorthValueAmounts" a ON a."valueId" = v.id
    LEFT JOIN "NetWorthCategoryAssets" ca ON ca.id = v."categoryAssetId"
    LEFT JOIN "NetWorthCategoryLiabilities" cl ON cl.id = v."categoryLiabilityId"
    WHERE v."entryId" = ANY(p_entry_ids)
  )
  SELECT
    "entryId",
    bucket,
    SUM(CASE WHEN is_credit_card THEN -ABS(home_minor) WHEN is_liability THEN ABS(home_minor) ELSE home_minor END)::bigint AS "amountHomeMinor"
  FROM converted
  WHERE NOT (is_liability AND liability_skip)
    AND home_minor IS NOT NULL
  GROUP BY "entryId", bucket
  HAVING SUM(CASE WHEN is_credit_card THEN -ABS(home_minor) WHEN is_liability THEN ABS(home_minor) ELSE home_minor END) <> 0;
END;
$function$;

-- Rebuild every cached bucket now that credit cards fold into CASH rather
-- than LIABILITY. Existing rows were aggregated under the old rule; the
-- triggers only keep future edits fresh, so recompute the back catalogue.
SELECT "NetWorthEntryBuckets_refresh_fn" (ARRAY(SELECT id FROM "NetWorthEntries"));

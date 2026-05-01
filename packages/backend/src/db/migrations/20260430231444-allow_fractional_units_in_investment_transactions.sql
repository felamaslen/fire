DROP VIEW if EXISTS "public"."InvestmentPortfolioDailyBreakdown";

ALTER TABLE "public"."InvestmentTransactions"
ALTER COLUMN "units"
SET DATA TYPE double precision USING "units"::double precision;

CREATE OR REPLACE VIEW "public"."InvestmentPortfolioDailyBreakdown" AS
WITH
  "priceRange" AS (
    SELECT
      min("InvestmentPrices".date) AS "startDate",
      max("InvestmentPrices".date) AS "endDate"
    FROM
      "InvestmentPrices"
  ),
  days AS (
    SELECT
      (
        generate_series(
          ("priceRange"."startDate")::timestamp with time zone,
          ("priceRange"."endDate")::timestamp with time zone,
          '1 day'::interval
        )
      )::date AS date
    FROM
      "priceRange"
    WHERE
      ("priceRange"."startDate" IS NOT NULL)
  ),
  holdings AS (
    SELECT DISTINCT
      "InvestmentTransactions"."assetId",
      "InvestmentTransactions"."investmentId"
    FROM
      "InvestmentTransactions"
  ),
  "unitsByDay" AS (
    SELECT
      h."assetId",
      h."investmentId",
      d.date,
      COALESCE(
        (
          SELECT
            sum(t.units) AS sum
          FROM
            "InvestmentTransactions" t
          WHERE
            (
              (t."assetId" = h."assetId")
              AND (t."investmentId" = h."investmentId")
              AND (t.date <= d.date)
            )
        ),
        (0)::double precision
      ) AS units
    FROM
      (
        holdings h
        CROSS JOIN days d
      )
  ),
  "priceByDay" AS (
    SELECT
      h."investmentId",
      d.date,
      (
        SELECT
          p_1.price
        FROM
          "InvestmentPrices" p_1
        WHERE
          (
            (p_1."investmentId" = h."investmentId")
            AND (p_1.date <= d.date)
          )
        ORDER BY
          p_1.date DESC
        LIMIT
          1
      ) AS price
    FROM
      (
        (
          SELECT DISTINCT
            holdings."investmentId"
          FROM
            holdings
        ) h
        CROSS JOIN days d
      )
  )
SELECT
  i.currency,
  u."assetId",
  u.date,
  sum((u.units * p.price)) AS amount
FROM
  (
    (
      "unitsByDay" u
      JOIN "Investments" i ON ((i.id = u."investmentId"))
    )
    JOIN "priceByDay" p ON (
      (
        (p."investmentId" = u."investmentId")
        AND (p.date = u.date)
      )
    )
  )
WHERE
  (
    (p.price IS NOT NULL)
    AND (u.units <> (0)::double precision)
  )
GROUP BY
  i.currency,
  u."assetId",
  u.date;

CREATE VIEW "public"."InvestmentPortfolioDailyBreakdown" AS (
    WITH
      "priceRange" AS (
        SELECT MIN(date) AS "startDate", MAX(date) AS "endDate"
        FROM "InvestmentPrices"
      ),
      days AS (
        SELECT generate_series("startDate", "endDate", '1 day'::interval)::date AS date
        FROM "priceRange"
        WHERE "startDate" IS NOT NULL
      ),
      holdings AS (
        SELECT DISTINCT "assetId", "investmentId"
        FROM "InvestmentTransactions"
      ),
      "unitsByDay" AS (
        SELECT
          h."assetId",
          h."investmentId",
          d.date,
          COALESCE(
            (SELECT SUM(t.units)
             FROM "InvestmentTransactions" t
             WHERE t."assetId" = h."assetId"
               AND t."investmentId" = h."investmentId"
               AND t.date <= d.date),
            0
          ) AS units
        FROM holdings h
        CROSS JOIN days d
      ),
      "priceByDay" AS (
        SELECT
          h."investmentId",
          d.date,
          (SELECT p.price
           FROM "InvestmentPrices" p
           WHERE p."investmentId" = h."investmentId" AND p.date <= d.date
           ORDER BY p.date DESC
           LIMIT 1) AS price
        FROM (SELECT DISTINCT "investmentId" FROM holdings) h
        CROSS JOIN days d
      )
    SELECT
      i.currency,
      u."assetId",
      u.date,
      SUM(u.units * p.price) AS amount
    FROM "unitsByDay" u
    JOIN "Investments" i ON i.id = u."investmentId"
    JOIN "priceByDay" p ON p."investmentId" = u."investmentId" AND p.date = u.date
    WHERE p.price IS NOT NULL AND u.units <> 0
    GROUP BY i.currency, u."assetId", u.date
  );
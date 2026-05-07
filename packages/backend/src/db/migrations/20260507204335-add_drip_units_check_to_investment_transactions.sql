ALTER TABLE "public"."InvestmentTransactions"
ADD CONSTRAINT "InvestmentTransactions_drip_units_ck" CHECK (
  (
    (NOT drip)
    OR (units > (0)::double precision)
  )
) NOT valid;

ALTER TABLE "public"."InvestmentTransactions" validate CONSTRAINT "InvestmentTransactions_drip_units_ck";

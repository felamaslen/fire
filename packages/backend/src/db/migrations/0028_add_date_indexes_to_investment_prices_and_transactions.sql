CREATE INDEX "InvestmentPrices_date" ON "InvestmentPrices" USING btree ("date");--> statement-breakpoint
CREATE INDEX "InvestmentTransactions_date" ON "InvestmentTransactions" USING btree ("date");
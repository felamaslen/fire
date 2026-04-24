import { SpanStatusCode, trace } from "@opentelemetry/api";
import { schedule, type ScheduledTask } from "node-cron";

import { db } from "@/db";
import { InvestmentPrices, Investments } from "@/db/schema/investments";
import { log } from "@/log";

import { fetchQuote } from "./yahoo";

const tracer = trace.getTracer("quote-cron");

function isBusinessDay(d: Date): boolean {
  const day = d.getUTCDay();
  return day >= 1 && day <= 5;
}

/** Fetch fresh quotes for every stock investment and persist them to `InvestmentPrices`. Skips fund-only investments (no ticker) and skips non-business days. */
export async function refreshAllStockQuotes(
  now: Date = new Date(),
): Promise<void> {
  return tracer.startActiveSpan("refreshAllStockQuotes", async (span) => {
    try {
      if (!isBusinessDay(now)) {
        span.setAttribute("quote_cron.skipped_reason", "non_business_day");
        return;
      }
      const rows = await db
        .select({
          id: Investments.id,
          stockCode: Investments.stockCode,
          currency: Investments.currency,
        })
        .from(Investments);
      const today = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
      );
      let fetched = 0;
      let persisted = 0;
      let skippedNoTicker = 0;
      let skippedNoQuote = 0;
      let skippedCurrencyMismatch = 0;
      for (const inv of rows) {
        if (!inv.stockCode) {
          skippedNoTicker++;
          continue;
        }
        const quote = await fetchQuote(inv.stockCode);
        fetched++;
        if (!quote) {
          skippedNoQuote++;
          continue;
        }
        if (quote.currency !== inv.currency) {
          skippedCurrencyMismatch++;
          log.warn(
            `quote currency ${quote.currency} for ${inv.stockCode} does not match investment currency ${inv.currency}; skipping persist`,
          );
          continue;
        }
        await db
          .insert(InvestmentPrices)
          .values({
            investmentId: inv.id,
            date: today,
            price: quote.priceMinorUnits,
            currency: inv.currency,
          })
          .onConflictDoUpdate({
            target: [InvestmentPrices.investmentId, InvestmentPrices.date],
            set: { price: quote.priceMinorUnits },
          });
        persisted++;
      }
      span.setAttributes({
        "quote_cron.investments": rows.length,
        "quote_cron.fetched": fetched,
        "quote_cron.persisted": persisted,
        "quote_cron.skipped_no_ticker": skippedNoTicker,
        "quote_cron.skipped_no_quote": skippedNoQuote,
        "quote_cron.skipped_currency_mismatch": skippedCurrencyMismatch,
      });
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      span.end();
    }
  });
}

let scheduled: ScheduledTask | null = null;

/** Schedule the daily quote-refresh job. Runs at 18:00 UTC on Monday–Friday. Idempotent: calling twice keeps only the most recent schedule. */
export function scheduleQuoteRefresh(): void {
  if (scheduled) scheduled.stop();
  scheduled = schedule("0 18 * * 1-5", () => {
    refreshAllStockQuotes().catch((err) => {
      log.error("quote refresh failed", { err });
    });
  });
}

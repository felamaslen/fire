import { context as otelContext } from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";
import { eq } from "drizzle-orm";

import { runWithSession } from "@/auth/session-als";
import { db, runWithDb } from "@/db";
import { defaultDb } from "@/db/client";
import { getDemoDb } from "@/db/demo-db";
import { PlanningMonths } from "@/db/schema/planning";
import { router } from "@/router";

import { createContext } from "./graphql/context";
import { Money } from "./graphql/money";
import {
  loadPlanningAccountInfos,
  loadPlanningYearData,
  monthEndSnapshotFor,
  monthTransactionsFor,
  valueStartFor,
} from "./graphql/planning/balance";
import { monthsInFYYear } from "./graphql/planning/months";

const MONTH_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** `"Apr 2026"`-style label for a UTC-anchored month date — matches the vertical month label in the planning grid. */
function monthLabel(date: Date): string {
  return `${MONTH_SHORT[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** Amount as a plain 2dp decimal string. Every planning value is in the reporting currency, so the sign is all that distinguishes inflows from outflows. */
function amountCell(money: Money): string {
  return money.amount.toFixed(2);
}

/** Closing balance for `(assetId, monthDate)` — mirrors `PlanningMonthAccount.valueEnd`: an in-month recorded snapshot wins, otherwise `valueStart` plus the month's transactions. */
function valueEndFor(
  data: Awaited<ReturnType<typeof loadPlanningYearData>>,
  assetId: string,
  monthDate: Date,
): Money {
  const snapshot = monthEndSnapshotFor(data, assetId, monthDate);
  if (snapshot) return snapshot;
  const start = valueStartFor(data, assetId, monthDate);
  const delta = monthTransactionsFor(data, assetId, monthDate).reduce(
    (sum, tx) => sum + Math.round(tx.amount.amount * 100),
    0,
  );
  return Money.fromMinorDenomination(
    Math.round(start.amount * 100) + delta,
    start.currency,
  );
}

/** Escape one CSV field: quote it when it contains a comma, quote, or newline; double any embedded quotes. */
function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function toCsv(rows: string[][]): string {
  return rows.map((row) => row.map(csvField).join(",")).join("\r\n");
}

/** Build the verbatim wide CSV for one planning year, mirroring the on-screen grid: one month per block, each account spanning a `(description, amount)` column pair. Within a month the accounts share rows — an opening-balance row, then one row per transaction slot (each account's nth transaction side by side, blank once an account runs out), then a closing-balance row. Reuses the same balance helpers as the grid resolvers so the numbers match the view exactly. */
async function buildYearCsv(yearNumber: number): Promise<string> {
  const [monthRows, accounts] = await Promise.all([
    db.select().from(PlanningMonths).where(eq(PlanningMonths.year, yearNumber)),
    loadPlanningAccountInfos(),
  ]);
  const data = await loadPlanningYearData(yearNumber, accounts);
  const monthDates =
    monthRows.length > 0
      ? monthRows.map((r) => r.date).sort((a, b) => a.getTime() - b.getTime())
      : monthsInFYYear(yearNumber);

  // Header: each account name heads its own (description, amount) column pair —
  // the name sits over the description column, the amount column is left blank.
  const header = ["Month"];
  for (const a of accounts) header.push(a.alias ?? a.assetName, "");
  const rows: string[][] = [header];

  for (const date of monthDates) {
    const label = monthLabel(date);
    const cells = accounts.map((a) => ({
      opening: valueStartFor(data, a.assetId, date),
      transactions: monthTransactionsFor(data, a.assetId, date),
      closing: valueEndFor(data, a.assetId, date),
    }));

    const opening = [label];
    for (const c of cells)
      opening.push("Opening balance", amountCell(c.opening));
    rows.push(opening);

    const maxTransactions = Math.max(
      0,
      ...cells.map((c) => c.transactions.length),
    );
    for (let slot = 0; slot < maxTransactions; slot++) {
      const row = [label];
      for (const c of cells) {
        const tx = c.transactions[slot];
        if (tx) row.push(tx.name, amountCell(tx.amount));
        else row.push("", "");
      }
      rows.push(row);
    }

    const closing = [label];
    for (const c of cells)
      closing.push("Closing balance", amountCell(c.closing));
    rows.push(closing);
  }

  return toCsv(rows);
}

// HMR guard: Fastify rejects plugin registration after boot, so under Vite
// re-evaluations this module must be a no-op — the route only registers on
// first load (matches `uploads.ts` / `spa.ts`).
declare global {
  var __planningExportRouted: boolean | undefined;
}

if (!globalThis.__planningExportRouted) {
  globalThis.__planningExportRouted = true;

  // Verbatim CSV export of the planning grid for a single financial year.
  // A plain HTTP route (not GraphQL) so the browser can download it as a file;
  // auth + db scoping mirror the `/graphql` handler in `graphql/server.ts`.
  router.get<{ Params: { year: string } }>(
    "/planning/:year/export.csv",
    async (request, reply) => {
      const yearNumber = Number(request.params.year);
      if (!Number.isInteger(yearNumber)) return reply.code(400).send();

      const ctx = createContext({ request });
      if (ctx.session.kind === "anon") return reply.code(401).send();

      const scopedDb =
        ctx.session.kind === "demo"
          ? getDemoDb(ctx.session.database)
          : defaultDb;

      const handle = async () => {
        const csv = await runWithSession(ctx.session, () =>
          runWithDb(scopedDb, () => buildYearCsv(yearNumber)),
        );
        reply.header("content-type", "text/csv; charset=utf-8");
        reply.header(
          "content-disposition",
          `attachment; filename="planning-${yearNumber}.csv"`,
        );
        return reply.send(csv);
      };

      // Demo sessions read from a dedicated schema and must not emit traces —
      // same treatment as their GraphQL requests.
      if (ctx.session.kind === "demo") {
        return otelContext.with(suppressTracing(otelContext.active()), handle);
      }
      return handle();
    },
  );
}

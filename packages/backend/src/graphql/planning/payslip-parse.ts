import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";

import { GoogleGenAI, Type } from "@google/genai";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { eq, ilike, or, sql } from "drizzle-orm";
import { GraphQLError } from "graphql";
import type { ID } from "grats";
import { LRUCache } from "lru-cache";

import { db } from "@/db";
import type { CurrencyCode } from "@/db/schema/currency";
import {
  NetWorthCategoryAssets,
  NetWorthCategoryLiabilities,
} from "@/db/schema/net-worth";
import { PlanningAccounts } from "@/db/schema/planning";
import { env } from "@/env";
import { log } from "@/log";

import type { Context } from "../context";
import type { Date as CalendarDate } from "../date";
import { Money } from "../money";
import { NetWorthCategoryLiability } from "../net-worth/categories";
import type { Upload } from "../upload";
import { PlanningAccount } from "./index";

/** One extracted deduction line from a payslip PDF (tax, NIC, student loan, pension, ...). @gqlType */
export class PayslipParseAdjustment {
  constructor(
    /** Human-readable label exactly as it appears on the payslip (e.g. `Income tax`, `NIC`, `Student loan plan 2`). @gqlField */
    public readonly name: string,
    /** Signed amount — negative for deductions (the common case), positive for e.g. refunds. Currency matches the payslip. @gqlField */
    public readonly amount: Money,
    /** Liability we believe this deduction services, matched by line name against existing liability categories. Only populated when we're confident (e.g. a "Student loan" line on the payslip and a `Student Loan` liability in the net-worth config). Null for everything else — the user wires it up on review. @gqlField */
    public readonly liability: NetWorthCategoryLiability | null,
  ) {}
}

/** The result of pushing a payslip PDF through Gemini — every field is the model's best guess and is intended to pre-populate the regular add-payslip form for the user to review before saving. @gqlType */
export class PayslipParseResult {
  constructor(
    /** Gross pay. @gqlField */
    public readonly gross: Money,
    /** Pay date. @gqlField */
    public readonly date: CalendarDate,
    /** Suggested display name for the payslip, already formatted as `Salary (<first name>)`. The user can override on review. @gqlField */
    public readonly suggestedName: string,
    /** Employee first name extracted from the PDF, if any — surfaced mostly so the UI can explain why an account was (or wasn't) matched. @gqlField */
    public readonly employeeFirstName: string | null,
    /** Planning account we believe this payslip lands in, matched on the extracted first name against planning-account / underlying-asset names. Null when no reasonable match was found — the UI falls back to asking the user. @gqlField */
    public readonly suggestedAccount: PlanningAccount | null,
    /** Every non-gross deduction line from the payslip. @gqlField */
    public readonly adjustments: PayslipParseAdjustment[],
  ) {}
}

type GeminiResult = {
  gross: { amount: number; currency: string };
  date: string;
  employeeFirstName: string | null;
  adjustments: Array<{
    name: string;
    amount: { amount: number; currency: string };
  }>;
};

/** Cache a given PDF's Gemini extraction for 1 hour so the UI can re-open the review dialog (or re-drop the same file) without re-hitting the model. Keyed by the file's SHA-256. */
const parseCache = new LRUCache<string, GeminiResult>({
  max: 50,
  ttl: 60 * 60 * 1000,
});

/** @internal Test helper — drops the in-memory LRU so each test starts from an empty cache. Not part of the public API; never call from production code. */
export function _resetPayslipParseCacheForTests(): void {
  parseCache.clear();
}

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  required: ["gross", "date", "adjustments"],
  properties: {
    gross: {
      type: Type.OBJECT,
      required: ["amount", "currency"],
      properties: {
        amount: { type: Type.NUMBER },
        currency: { type: Type.STRING, description: "ISO-4217 3-letter code." },
      },
    },
    date: {
      type: Type.STRING,
      description: "Pay date, ISO-8601 YYYY-MM-DD.",
    },
    employeeFirstName: { type: Type.STRING, nullable: true },
    adjustments: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        required: ["name", "amount"],
        properties: {
          name: { type: Type.STRING },
          amount: {
            type: Type.OBJECT,
            required: ["amount", "currency"],
            properties: {
              amount: {
                type: Type.NUMBER,
                description:
                  "Signed. Negative for deductions (the common case), positive for refunds / gross-ups.",
              },
              currency: { type: Type.STRING },
            },
          },
        },
      },
    },
  },
} as const;

const PROMPT = `You are extracting data from a UK-style payslip.
Return a single JSON object with these fields:
- gross: { amount, currency } — the total gross pay for this period (before any deductions).
- date: YYYY-MM-DD — the pay date (the date the employee is paid), not the pay-period start/end.
- employeeFirstName: the employee's given/first name (or null if it's not on the document).
- adjustments: every individual deduction or post-gross adjustment line. Amounts are signed — deductions are negative. Do not include the gross line itself. If the payslip has a dedicated "Deductions" section (or equivalent heading — "Taxes & Deductions", "Statutory Deductions", etc.), read every line from that section and nothing else; ignore running totals like "Totals", "Total Deductions", "Net Pay", or summary / year-to-date columns.
Pension-specific rules:
- A pension line labelled "ERS" (or "Employer") is the employer's contribution — DO NOT include it in adjustments. It isn't deducted from the employee's gross.
- A pension line labelled "AE" (auto-enrolment) or any variant containing "auto-enrolment" is the employee's AE contribution — rename it to "Pension" in the output.
- Any other pension line (e.g. a salary-sacrifice scheme) passes through with its original label.
Ignore year-to-date figures. If a deduction is explicitly zero for this period, skip it.`;

/**
 * Extract gross, pay date, and deductions from a payslip PDF using Gemini Flash, and suggest which planning account it belongs to based on the employee's first name. Does not create a payslip record — the UI shows the returned values in the regular add-payslip form for the user to review / adjust before submitting.
 *
 * Gated to `real` sessions: demo sessions would otherwise burn Gemini tokens on synthetic data with no upside.
 *
 * @gqlMutationField
 */
export async function payslipParse(
  file: Upload,
  ctx: Context,
): Promise<PayslipParseResult> {
  if (ctx.session.kind !== "real") {
    throw new GraphQLError("Payslip parsing is disabled in demo mode.", {
      extensions: { code: "FORBIDDEN" },
    });
  }
  if (!env.GEMINI_API_KEY) {
    throw new Error(
      "Payslip parsing is disabled — set GEMINI_API_KEY on the server.",
    );
  }

  const resolved = await file;
  const chunks: Buffer[] = [];
  for await (const chunk of resolved.createReadStream()) {
    chunks.push(chunk as Buffer);
  }
  const buffer = Buffer.concat(chunks);
  const sha = createHash("sha256").update(buffer).digest("hex");

  let parsed = parseCache.get(sha);
  if (!parsed) {
    parsed = await callGemini(buffer);
    log.info("Parsed payslip", { parsed });
    parsed.adjustments = collapseDuplicateAdjustments(parsed.adjustments);
    parseCache.set(sha, parsed);
  }

  const firstName = parsed.employeeFirstName?.trim() || null;
  const suggestedAccountId = firstName
    ? await matchAccountByName(firstName)
    : null;
  const suggestedName = `Salary (${firstName ?? "unknown"})`;

  // Only hit the DB for liability matching if at least one adjustment looks
  // like a student-loan line — keeps the happy path (no SL deductions) cheap.
  const hasStudentLoan = parsed.adjustments.some((a) =>
    /student\s+loan/i.test(a.name),
  );
  const studentLoanLiabilityId = hasStudentLoan
    ? await matchStudentLoanLiability()
    : null;

  return new PayslipParseResult(
    toMoney(parsed.gross),
    new Date(`${parsed.date}T00:00:00Z`),
    suggestedName,
    firstName,
    suggestedAccountId == null
      ? null
      : PlanningAccount.fromId(suggestedAccountId),
    parsed.adjustments.map(
      (a) =>
        new PayslipParseAdjustment(
          a.name,
          toMoney(a.amount),
          /student\s+loan/i.test(a.name) && studentLoanLiabilityId
            ? NetWorthCategoryLiability.fromId(studentLoanLiabilityId)
            : null,
        ),
    ),
  );
}

/** Merge adjustment lines that share a label (case-insensitive, whitespace-trimmed) by summing their amounts. Gemini sometimes emits two `Pension` lines — one for each scheme on the payslip (e.g. employee + AVC) — which we want to surface as a single combined deduction. Amounts are summed even when signs differ; currencies must match the first occurrence or the row is dropped on currency drift (shouldn't happen, but defensive). Preserves the original order of first occurrence. */
function collapseDuplicateAdjustments(
  adjustments: GeminiResult["adjustments"],
): GeminiResult["adjustments"] {
  const byKey = new Map<string, GeminiResult["adjustments"][number]>();
  const order: string[] = [];
  for (const adj of adjustments) {
    const key = adj.name.trim().toLowerCase();
    const existing = byKey.get(key);
    if (existing) {
      if (existing.amount.currency !== adj.amount.currency) continue;
      existing.amount.amount += adj.amount.amount;
    } else {
      byKey.set(key, { ...adj, amount: { ...adj.amount } });
      order.push(key);
    }
  }
  return order.map((k) => byKey.get(k)!);
}

/** Convert Gemini's `{ amount, currency }` (major units, e.g. pounds) into a `Money` in minor units. Non-GBP currencies still pass through — the backend stores whatever currency Gemini returned. */
function toMoney(m: { amount: number; currency: string }): Money {
  return Money.fromMinorDenomination(
    Math.round(m.amount * 100),
    m.currency as CurrencyCode,
  );
}

/** Retry 503 / UNAVAILABLE up to this many attempts total (initial + retries). Google's Gemini serving pool routinely sheds load with 503s; a short bounded retry clears most of them without meaningfully hurting p95 latency. */
const MAX_ATTEMPTS = 4;

/** Backoff schedule in ms between attempts `n` and `n+1`. Purposely short — users are watching a spinner. */
const BACKOFF_MS = [500, 1500, 3000];

const tracer = trace.getTracer("fire-backend");

async function callGemini(pdf: Buffer): Promise<GeminiResult> {
  assert(env.GEMINI_API_KEY);
  const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  // Outer span scopes the whole `callGemini` lifecycle so the overall p50 /
  // p95 / retry count is queryable. Each individual `generateContent` call
  // gets its own child span below (one per attempt) so a 503-retry-then-200
  // shows up as three distinct children with their own statuses.
  return tracer.startActiveSpan(
    "gemini.payslipParse",
    {
      attributes: {
        "gen_ai.system": "gemini",
        "gen_ai.request.model": env.GEMINI_MODEL,
        "gemini.pdf.bytes": pdf.length,
      },
    },
    async (outer) => {
      let lastError: unknown = null;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        try {
          const res = await tracer.startActiveSpan(
            "gemini.generateContent",
            {
              attributes: {
                "gen_ai.system": "gemini",
                "gen_ai.request.model": env.GEMINI_MODEL,
                "gemini.attempt": attempt + 1,
              },
            },
            async (span) => {
              try {
                const r = await ai.models.generateContent({
                  model: env.GEMINI_MODEL,
                  contents: [
                    {
                      role: "user",
                      parts: [
                        {
                          inlineData: {
                            data: pdf.toString("base64"),
                            mimeType: "application/pdf",
                          },
                        },
                        { text: PROMPT },
                      ],
                    },
                  ],
                  config: {
                    responseMimeType: "application/json",
                    responseSchema: RESPONSE_SCHEMA,
                  },
                });
                // `usageMetadata` is where Gemini reports prompt + response
                // token counts, if exposed by the model. Surfacing them lets
                // Jaeger slice by input size and estimate cost per call.
                const usage = r.usageMetadata;
                if (usage?.promptTokenCount != null) {
                  span.setAttribute(
                    "gen_ai.usage.input_tokens",
                    usage.promptTokenCount,
                  );
                }
                if (usage?.candidatesTokenCount != null) {
                  span.setAttribute(
                    "gen_ai.usage.output_tokens",
                    usage.candidatesTokenCount,
                  );
                }
                return r;
              } catch (err) {
                span.recordException(err as Error);
                span.setStatus({
                  code: SpanStatusCode.ERROR,
                  message: err instanceof Error ? err.message : String(err),
                });
                throw err;
              } finally {
                span.end();
              }
            },
          );
          const text = res.text;
          assert(text, "Gemini returned no text body");
          outer.setAttribute("gemini.attempts", attempt + 1);
          outer.end();
          return JSON.parse(text) as GeminiResult;
        } catch (cause) {
          lastError = cause;
          const message =
            cause instanceof Error ? cause.message : String(cause);
          // Quota exhaustion: no point retrying, surface immediately.
          if (/\b429\b|quota|RESOURCE_EXHAUSTED/i.test(message)) {
            outer.setStatus({
              code: SpanStatusCode.ERROR,
              message: "quota_exhausted",
            });
            outer.setAttribute("gemini.attempts", attempt + 1);
            outer.end();
            throw new GraphQLError(
              "Gemini quota exhausted — try again later.",
              { extensions: { code: "GEMINI_QUOTA_EXHAUSTED" } },
            );
          }
          // 503 UNAVAILABLE: Google's model pool is overloaded. Back off and
          // retry — this is by far the most common transient failure on
          // both free and paid tiers.
          if (
            /\b503\b|UNAVAILABLE|overloaded/i.test(message) &&
            attempt < MAX_ATTEMPTS - 1
          ) {
            await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]));
            continue;
          }
          // Anything else (or 503 that kept failing past MAX_ATTEMPTS) → give up.
          break;
        }
      }
      const message =
        lastError instanceof Error ? lastError.message : String(lastError);
      outer.setAttribute("gemini.attempts", MAX_ATTEMPTS);
      outer.setStatus({ code: SpanStatusCode.ERROR, message });
      outer.end();
      if (/\b503\b|UNAVAILABLE|overloaded/i.test(message)) {
        throw new GraphQLError(
          `Gemini (${env.GEMINI_MODEL}) is currently overloaded — try again in a minute.`,
          { extensions: { code: "GEMINI_UNAVAILABLE" } },
        );
      }
      throw new GraphQLError(`Gemini call failed: ${message}`, {
        originalError: lastError as Error,
      });
    },
  );
}

/** Find a `NetWorthCategoryLiability` whose name looks like a student-loan row (`ilike '%student%loan%'`, so "Student Loan", "Student Loan Plan 2", etc. all match). Returns the first match, or null. */
async function matchStudentLoanLiability(): Promise<ID | null> {
  const [row] = await db
    .select({ id: NetWorthCategoryLiabilities.id })
    .from(NetWorthCategoryLiabilities)
    .where(ilike(NetWorthCategoryLiabilities.name, "%student%loan%"))
    .limit(1);
  return (row?.id as ID | undefined) ?? null;
}

/** Find a `PlanningAccount` whose display name or underlying asset name contains `firstName` (case-insensitive word-boundary match). Returns the first match, or null if nothing plausible. */
async function matchAccountByName(firstName: string): Promise<ID | null> {
  // `~*` is Postgres's case-insensitive POSIX regex operator, and `\y`
  // anchors at a word boundary — so "<person>" matches "<person> (F)" or "<person>'s
  // current" but not "<person>scic".
  const pattern = `\\y${escapePosixRegex(firstName)}\\y`;
  const [row] = await db
    .select({ accountId: PlanningAccounts.accountId })
    .from(PlanningAccounts)
    .innerJoin(
      NetWorthCategoryAssets,
      eq(PlanningAccounts.accountId, NetWorthCategoryAssets.id),
    )
    .where(
      or(
        sql`${PlanningAccounts.alias} ~* ${pattern}`,
        sql`${NetWorthCategoryAssets.name} ~* ${pattern}`,
      ),
    )
    .limit(1);
  return (row?.accountId as ID | undefined) ?? null;
}

function escapePosixRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

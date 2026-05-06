import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";

import { GoogleGenAI, Type } from "@google/genai";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Float, ID } from "grats";
import { LRUCache } from "lru-cache";
import { z } from "zod";

import { CURRENCIES } from "@/config";
import { db } from "@/db";
import { Investments, InvestmentTransactions } from "@/db/schema/investments";
import { NetWorthCategoryAssets } from "@/db/schema/net-worth";
import { env } from "@/env";
import { log } from "@/log";

import type { Context } from "../context";
import type { Date as CalendarDate } from "../date";
import { Money } from "../money";
import { NetWorthCategoryAsset } from "../net-worth/categories";
import type { Upload } from "../upload";
import { Investment } from "./index";

/** The result of pushing a broker contract note PDF through Gemini — every field is the model's best guess and is intended to pre-populate the regular add-transaction form for the user to review before saving. @gqlType */
export class ContractNoteImportResult {
  constructor(
    /** Investment we believe this contract note refers to, matched against the supplied candidate list by ticker / fund name. `null` when nothing matched (the UI then asks the user to pick). When the resolver was called with an explicit `investmentId`, this is always populated with that investment. @gqlField */
    public readonly investment: Investment | null,
    /** Wrapper (a `STOCK` or `PENSION` net-worth asset) we believe the trade books into, matched against asset names. `null` when no plausible match was found. @gqlField */
    public readonly asset: NetWorthCategoryAsset | null,
    /** Calendar date the trade was executed. @gqlField */
    public readonly date: CalendarDate,
    /** Signed number of units traded. Positive = buy / DRIP, negative = sell. @gqlField */
    public readonly units: Float,
    /** Unit price at execution, in the investment's currency. For UK stocks quoted in pence, this is normalised back into pounds (e.g. a 152p tick becomes `{ amount: 1.52, currency: "GBP" }`). @gqlField */
    public readonly price: Money,
    /** Sum of all tax lines on the contract note (PTM levy, stamp duty, etc.), in the investment's currency. `null` when the note doesn't show any taxes. @gqlField */
    public readonly taxes: Money | null,
    /** Sum of all non-tax fee lines on the contract note (broker commission, FX fee, etc.), in the investment's currency. `null` when the note doesn't show any fees. @gqlField */
    public readonly fees: Money | null,
    /** True when the consideration looks small enough relative to the recent DRIP / contribution history that this is most likely a dividend reinvestment rather than a cash buy. @gqlField */
    public readonly drip: boolean,
  ) {}
}

const PriceShape = z.object({
  amount: z.number(),
  /** Either an ISO-4217 code like `GBP`, `USD`, `EUR`, …, or the pence pseudo-codes `GBp` / `GBX` for UK stocks quoted in pence. */
  currency: z.string(),
});

const MoneyShape = z.object({
  amount: z.number(),
  currency: z.string(),
});

const DateShape = z.string().transform((s, ctx) => {
  const trimmed = s.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const dmy = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(trimmed);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  ctx.addIssue({
    code: "custom",
    message: `Expected date in YYYY-MM-DD or DD/MM/YYYY format, got "${s}"`,
  });
  return z.NEVER;
});

const GeminiResultSchema = z
  .object({
    direction: z.enum(["BUY", "SELL"]),
    units: z.number(),
    price: PriceShape,
    taxes: MoneyShape.nullish().transform((v) => v ?? null),
    fees: MoneyShape.nullish().transform((v) => v ?? null),
    date: DateShape,
    investmentId: z
      .string()
      .nullish()
      .transform((v) => (v && v.trim() !== "" ? v : null)),
    assetId: z
      .string()
      .nullish()
      .transform((v) => (v && v.trim() !== "" ? v : null)),
  })
  .loose();

type GeminiResult = z.infer<typeof GeminiResultSchema>;

/** Cache a given PDF's Gemini extraction for 1 hour so the UI can re-open the review dialog (or re-drop the same file) without re-hitting the model. Keyed by the file's SHA-256 plus the optional `investmentId` — passing an investment changes the prompt, so the cache slot must too. */
const parseCache = new LRUCache<string, GeminiResult>({
  max: 50,
  ttl: 60 * 60 * 1000,
});

/** @internal Test helper — drops the in-memory LRU so each test starts from an empty cache. Not part of the public API; never call from production code. */
export function _resetContractNoteImportCacheForTests(): void {
  parseCache.clear();
}

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  required: ["direction", "units", "price", "date"],
  properties: {
    direction: {
      type: Type.STRING,
      enum: ["BUY", "SELL"],
      description:
        "Whether this contract note records a purchase or a sale of units.",
    },
    units: {
      type: Type.NUMBER,
      description:
        "Absolute number of units traded. Always positive — direction is encoded separately.",
    },
    price: {
      type: Type.OBJECT,
      required: ["amount", "currency"],
      properties: {
        amount: { type: Type.NUMBER },
        currency: {
          type: Type.STRING,
          description:
            "ISO-4217 code (GBP, USD, EUR, …) for prices quoted in major units, or 'GBp' / 'GBX' for UK stocks quoted in pence. Use whichever the contract note actually shows.",
        },
      },
    },
    taxes: {
      type: Type.OBJECT,
      nullable: true,
      required: ["amount", "currency"],
      properties: {
        amount: {
          type: Type.NUMBER,
          description:
            "Sum of all tax lines (PTM levy, stamp duty, withholding, etc.). Major units of `currency`. Omit / null when the note shows no taxes.",
        },
        currency: { type: Type.STRING },
      },
    },
    fees: {
      type: Type.OBJECT,
      nullable: true,
      required: ["amount", "currency"],
      properties: {
        amount: {
          type: Type.NUMBER,
          description:
            "Sum of all non-tax fee lines (broker commission, FX charges, etc.). Major units of `currency`. Omit / null when the note shows no fees.",
        },
        currency: { type: Type.STRING },
      },
    },
    date: {
      type: Type.STRING,
      description: "Trade date, ISO-8601 YYYY-MM-DD.",
    },
    investmentId: {
      type: Type.STRING,
      nullable: true,
      description:
        "ID picked from the supplied `investments` list whose ticker or name best matches this contract note. Null when no candidate is a clear match.",
    },
    assetId: {
      type: Type.STRING,
      nullable: true,
      description:
        "ID picked from the supplied `wrappers` list (a STOCK / PENSION net-worth asset) whose name best matches the account / wrapper this trade booked into. Null when no candidate is a clear match.",
    },
  },
} as const;

function buildPrompt(opts: {
  investments: Array<{ id: string; name: string; ticker: string | null }>;
  wrappers: Array<{ id: string; name: string; type: string }>;
  forcedInvestmentId: string | null;
}): string {
  const investmentsBlock = opts.forcedInvestmentId
    ? `The investment for this contract note is fixed: investmentId = ${opts.forcedInvestmentId}. Always return this id verbatim in the \`investmentId\` field.`
    : `Match the contract note's instrument (by ticker, ISIN, SEDOL, or fund name) to one entry in this list and return its \`id\` as \`investmentId\`. Return null if nothing is a clear match — DO NOT invent ids.\nCandidates (id — name — ticker):\n${
        opts.investments.length === 0
          ? "(none)"
          : opts.investments
              .map(
                (i) =>
                  `- ${i.id} — ${i.name}${i.ticker ? ` — ${i.ticker}` : ""}`,
              )
              .join("\n")
      }`;
  const wrappersBlock = `Match the wrapper / account the trade booked into (e.g. "ISA", "SIPP", "GIA", "Trading 212") to one entry in this list and return its \`id\` as \`assetId\`. Return null if nothing is a clear match.\nCandidates (id — name — type):\n${
    opts.wrappers.length === 0
      ? "(none)"
      : opts.wrappers.map((w) => `- ${w.id} — ${w.name} — ${w.type}`).join("\n")
  }`;
  return [
    "You are extracting data from a broker contract note PDF (a UK-style trade confirmation).",
    "Return a single JSON object with these fields:",
    "- direction: BUY or SELL.",
    "- units: absolute number of units traded.",
    "- price: { amount, currency } — unit price as printed on the note. For UK stocks the currency is usually `GBp` (pence); accept that and pass it through verbatim.",
    "- taxes: { amount, currency } — sum of all tax lines (PTM levy, stamp duty, withholding tax, …) in major units. Null when the note shows no taxes.",
    "- fees: { amount, currency } — sum of all non-tax fee lines (broker commission, FX fee, …) in major units. Null when the note shows no fees.",
    "- date: YYYY-MM-DD — the trade / deal date (not the settlement date).",
    "- investmentId: see below.",
    "- assetId: see below.",
    "",
    investmentsBlock,
    "",
    wrappersBlock,
  ].join("\n");
}

/**
 * Extract direction, units, price, taxes, fees, date, investment, and wrapper from a broker contract note PDF using Gemini Flash. Does not create a transaction record — the UI shows the returned values for the user to review / adjust before submitting.
 *
 * Pass `investmentId` when the caller already knows which investment this note is for (e.g. the dialog was opened from an investment's editor); the resolver then skips the candidate-match step and locks the investment to that id.
 *
 * The `drip` flag is not asked of the model — it's inferred from the consideration relative to recent reinvestment / contribution history: a small consideration relative to the EWMA of the last 20 DRIPs (or, if there are none, the last 20 non-DRIP contributions) is treated as a dividend reinvestment.
 *
 * Gated to `real` sessions: demo sessions would otherwise burn Gemini tokens on synthetic data with no upside.
 *
 * @gqlMutationField
 */
export async function investmentContractNoteImport(
  ctx: Context,
  file: Upload,
  /** When set, the resolver assumes the contract note is for this investment and skips the LLM-side candidate matching. Useful when the dialog is opened from an investment's editor — the investment is already known and the user only needs to review the trade fields. */
  investmentId?: ID | null,
): Promise<ContractNoteImportResult> {
  if (ctx.session.kind !== "real") {
    throw Object.assign(
      new Error("Contract-note parsing is disabled in demo mode."),
      { extensions: { code: "FORBIDDEN" } },
    );
  }
  if (!env.GEMINI_API_KEY) {
    throw new Error(
      "Contract-note parsing is disabled — set GEMINI_API_KEY on the server.",
    );
  }

  const resolved = await file;
  const chunks: Buffer[] = [];
  for await (const chunk of resolved.createReadStream()) {
    chunks.push(chunk as Buffer);
  }
  const buffer = Buffer.concat(chunks);
  const sha = createHash("sha256").update(buffer).digest("hex");
  const cacheKey = `${sha}:${investmentId ?? ""}`;

  const investmentRows = await db.select().from(Investments);
  const wrapperRows = await db
    .select()
    .from(NetWorthCategoryAssets)
    .where(inArray(NetWorthCategoryAssets.type, ["STOCK", "PENSION"]));

  const investmentsForPrompt = investmentRows.map((r) => ({
    id: r.id,
    name: r.name,
    ticker: r.stockCode,
  }));
  const wrappersForPrompt = wrapperRows.map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type,
  }));

  let parsed = parseCache.get(cacheKey);
  if (!parsed) {
    parsed = await callGemini(buffer, {
      investments: investmentsForPrompt,
      wrappers: wrappersForPrompt,
      forcedInvestmentId: investmentId ?? null,
    });
    log.info("Parsed contract note", { parsed });
    parseCache.set(cacheKey, parsed);
  }

  const resolvedInvestmentId = investmentId ?? parsed.investmentId;
  const matchedInvestment = resolvedInvestmentId
    ? investmentRows.find((r) => r.id === resolvedInvestmentId)
    : undefined;
  const investment = matchedInvestment
    ? Investment.load(matchedInvestment)
    : null;

  const matchedWrapper = parsed.assetId
    ? wrapperRows.find((r) => r.id === parsed!.assetId)
    : undefined;
  const asset = matchedWrapper
    ? NetWorthCategoryAsset.load(matchedWrapper)
    : null;

  const investmentCurrency = matchedInvestment?.currency ?? null;
  const priceMajor = normalisePriceToMajor(parsed.price, investmentCurrency);
  const signedUnits =
    parsed.direction === "SELL" ? -parsed.units : parsed.units;

  // Consideration in major units of the investment's currency. Used by the
  // DRIP heuristic — only computable when we actually matched an investment.
  const considerationMajor = Math.abs(signedUnits) * priceMajor.amount;
  const drip =
    matchedInvestment && parsed.direction === "BUY"
      ? await inferDrip({
          investmentId: matchedInvestment.id,
          considerationMajor,
          currency: matchedInvestment.currency,
        })
      : false;

  return new ContractNoteImportResult(
    investment,
    asset,
    new Date(`${parsed.date}T00:00:00Z`),
    signedUnits as Float,
    Money.fromMinorDenomination(
      Math.round(priceMajor.amount * 10 ** scaleOf(priceMajor.currency)),
      priceMajor.currency,
    ),
    parsed.taxes
      ? Money.fromMinorDenomination(
          Math.round(
            parsed.taxes.amount * 10 ** scaleOf(parsed.taxes.currency),
          ),
          parsed.taxes.currency,
        )
      : null,
    parsed.fees
      ? Money.fromMinorDenomination(
          Math.round(parsed.fees.amount * 10 ** scaleOf(parsed.fees.currency)),
          parsed.fees.currency,
        )
      : null,
    drip,
  );
}

/** Convert a Gemini-reported price into the matched investment's currency in major units. Handles the UK-pence pseudo-codes (`GBp` / `GBX` → divide by 100, restamp as `GBP`); otherwise passes through. When we don't know the investment's currency yet (no match), trusts what Gemini said. */
function normalisePriceToMajor(
  price: { amount: number; currency: string },
  investmentCurrency: string | null,
): { amount: number; currency: string } {
  const c = price.currency.trim();
  if (
    c === "GBp" ||
    c === "GBX" ||
    c === "GBX " ||
    c.toLowerCase() === "gbp pence"
  ) {
    return { amount: price.amount / 100, currency: "GBP" };
  }
  if (investmentCurrency && c.toUpperCase() !== investmentCurrency) {
    // Currency mismatch — surface what Gemini said anyway, the user can fix
    // it on review. The Money constructor will throw if it isn't a known
    // ISO-4217 code, which is fine: we want bad data to surface loudly.
    return { amount: price.amount, currency: c.toUpperCase() };
  }
  return { amount: price.amount, currency: c.toUpperCase() };
}

function scaleOf(currency: string): number {
  const c = currency.toUpperCase();
  const meta = (CURRENCIES as Record<string, { scale: number } | undefined>)[c];
  return meta?.scale ?? 2;
}

/** Decide whether a buy-side contract note should be flagged as a dividend reinvestment.
 *
 * Reads the last 20 DRIPs for this investment; if any exist, the trade is a DRIP when
 * `0 < consideration < 3 * EWMA(considerations)`. With no DRIP history, falls back to the
 * last 20 non-DRIP contributions — the trade is a DRIP when `0 < consideration < 0.1 * EWMA`.
 * Returns false when there's no history at all (a freshly-set-up investment).
 */
async function inferDrip(opts: {
  investmentId: string;
  considerationMajor: number;
  currency: string;
}): Promise<boolean> {
  if (opts.considerationMajor <= 0) return false;

  const dripRows = await db
    .select({
      units: InvestmentTransactions.units,
      price: InvestmentTransactions.price,
    })
    .from(InvestmentTransactions)
    .where(
      and(
        eq(InvestmentTransactions.investmentId, opts.investmentId),
        eq(InvestmentTransactions.drip, true),
      ),
    )
    .orderBy(desc(InvestmentTransactions.date), desc(InvestmentTransactions.id))
    .limit(20);

  const scale = scaleOf(opts.currency);
  // `units * price` is in (units × minor-denomination); divide by 10^scale
  // to get back into major units, matching the consideration we're comparing.
  const dripConsiderations = dripRows.map(
    (r) => (Math.abs(r.units) * r.price) / 10 ** scale,
  );

  if (dripConsiderations.length > 0) {
    const ewma = computeEwma(dripConsiderations);
    return opts.considerationMajor < 3 * ewma;
  }

  const contribRows = await db
    .select({
      units: InvestmentTransactions.units,
      price: InvestmentTransactions.price,
    })
    .from(InvestmentTransactions)
    .where(
      and(
        eq(InvestmentTransactions.investmentId, opts.investmentId),
        eq(InvestmentTransactions.drip, false),
      ),
    )
    .orderBy(desc(InvestmentTransactions.date), desc(InvestmentTransactions.id))
    .limit(20);
  const contribs = contribRows
    .filter((r) => r.units > 0)
    .map((r) => (Math.abs(r.units) * r.price) / 10 ** scale);
  if (contribs.length === 0) return false;
  const ewma = computeEwma(contribs);
  return opts.considerationMajor < 0.1 * ewma;
}

/** Exponentially-weighted moving average. Inputs are in newest-first order (matches the `desc(date)` query above). The smoothing factor `α = 2/(N+1)` is the conventional choice for an N-period EWMA. */
function computeEwma(values: number[]): number {
  assert(values.length > 0);
  const alpha = 2 / (values.length + 1);
  // Walk the input oldest-first so the most recent observations carry the
  // largest weight in the running average.
  const oldestFirst = [...values].reverse();
  let ewma = oldestFirst[0];
  for (let i = 1; i < oldestFirst.length; i++) {
    ewma = alpha * oldestFirst[i] + (1 - alpha) * ewma;
  }
  return ewma;
}

const MAX_ATTEMPTS = 4;
const BACKOFF_MS = [500, 1500, 3000];

const tracer = trace.getTracer("fire-backend");

async function callGemini(
  pdf: Buffer,
  opts: {
    investments: Array<{ id: string; name: string; ticker: string | null }>;
    wrappers: Array<{ id: string; name: string; type: string }>;
    forcedInvestmentId: string | null;
  },
): Promise<GeminiResult> {
  assert(env.GEMINI_API_KEY);
  const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  const prompt = buildPrompt(opts);
  return tracer.startActiveSpan(
    "gemini.investmentContractNoteImport",
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
                        { text: prompt },
                      ],
                    },
                  ],
                  config: {
                    responseMimeType: "application/json",
                    responseSchema: RESPONSE_SCHEMA,
                  },
                });
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
          return GeminiResultSchema.parse(JSON.parse(text));
        } catch (cause) {
          lastError = cause;
          const message =
            cause instanceof Error ? cause.message : String(cause);
          if (/\b429\b|quota|RESOURCE_EXHAUSTED/i.test(message)) {
            outer.setStatus({
              code: SpanStatusCode.ERROR,
              message: "quota_exhausted",
            });
            outer.setAttribute("gemini.attempts", attempt + 1);
            outer.end();
            throw Object.assign(
              new Error("Gemini quota exhausted — try again later."),
              { extensions: { code: "GEMINI_QUOTA_EXHAUSTED" } },
            );
          }
          if (
            /\b503\b|UNAVAILABLE|overloaded/i.test(message) &&
            attempt < MAX_ATTEMPTS - 1
          ) {
            await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]));
            continue;
          }
          break;
        }
      }
      const message =
        lastError instanceof Error ? lastError.message : String(lastError);
      outer.setAttribute("gemini.attempts", MAX_ATTEMPTS);
      outer.setStatus({ code: SpanStatusCode.ERROR, message });
      outer.end();
      if (/\b503\b|UNAVAILABLE|overloaded/i.test(message)) {
        throw Object.assign(
          new Error(
            `Gemini (${env.GEMINI_MODEL}) is currently overloaded — try again in a minute.`,
          ),
          { extensions: { code: "GEMINI_UNAVAILABLE" } },
        );
      }
      throw new Error(`Gemini call failed: ${message}`);
    },
  );
}

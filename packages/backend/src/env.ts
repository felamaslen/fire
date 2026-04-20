import { z } from "zod";

/** Shape of every environment variable the server reads at runtime. Validation fails fast at import time so a mistyped env doesn't silently fall through to an `undefined`. */
const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  /** Postgres connection string. */
  DATABASE_URL: z.string().min(1),
  /** Local uploads-bucket directory. Created on demand by `src/uploads.ts`. */
  UPLOADS_DIR: z.string().min(1),
  /** Port the fastify server listens on when started as an entry point (not used in tests). */
  PORT: z.coerce.number().int().positive().default(4000),
  /** Turns the OpenTelemetry SDK on / off. Defaults to off outside of `development` so tests and prod don't silently depend on a running collector. */
  OTEL_ENABLED: z.stringbool().default(process.env.NODE_ENV === "development"),
  /** Base URL of the OTLP/HTTP collector (no trailing path — `/v1/traces` is appended per signal). Matches the Jaeger all-in-one service defined in `docker-compose.yml`. */
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default("http://localhost:4318"),
  /** Google AI Studio API key used by `payslipParse` to read a payslip PDF with Gemini Flash. Leave unset to disable the feature. Use an AI Studio key bound to a project that does not have billing enabled so requests past the free-tier quota hard-fail with HTTP 429 instead of accruing cost. */
  GEMINI_API_KEY: z.string().min(1).optional(),
  /** Which Gemini model to call from `payslipParse`. Defaults to `gemini-2.5-flash-lite` because it's significantly cheaper and — crucially — sits in a less congested serving pool than flagship Flash, which frequently returns 503 UNAVAILABLE on free + paid tiers alike. Override if you need the bigger model for a harder PDF. */
  GEMINI_MODEL: z.string().min(1).default("gemini-2.5-flash-lite"),
  /** Directory containing a built `packages/web` SPA (the `dist/` output from `vite build`). When set, the server serves those static assets and falls back to `index.html` for non-API GETs so client-side routing works. Leave unset in dev where the web package is served by its own Vite dev server. */
  WEB_DIST_DIR: z.string().min(1).optional(),
  /** Filesystem path where the Yahoo live-quote LRU is persisted. Writes are debounced, and reads happen once at boot. Defaults to `.yahoo-cache.json` in the process cwd, which is fine for dev (lives in the repo, survives HMR); in prod, point this at a file inside a mounted volume so the warm cache survives container restarts. Disabled entirely in tests. */
  YAHOO_CACHE_PATH: z.string().min(1).optional(),
  /** 4-digit PIN that gates real-data access. Integer in `[1000, 9999]`. Compared against the value submitted to the `login` mutation; a correct PIN returns a 30-day auth token. */
  AUTH_PIN: z.coerce.number().int().min(1000).max(9999),
  /** HMAC secret used to sign auth tokens. Must be at least 32 characters. Rotating invalidates every outstanding token (real and demo). */
  AUTH_SECRET: z.string().min(32),
});

export const env = schema.parse(process.env);

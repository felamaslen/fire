import { z } from "zod";

/** Shape of every environment variable the server reads at runtime. Validation fails fast at import time so a mistyped env doesn't silently fall through to an `undefined`. */
const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  /** Postgres connection string. */
  DATABASE_URL: z.string().min(1),
  /** Maximum number of Postgres connections held open by the pool. Lower this when many test workers run concurrently against a single Postgres instance to avoid exhausting `max_connections`. The default is sized for the single-server dev / prod case where each request fans out into many parallel resolver SQLs and queueing on a small pool dominates wall time before any actual SQL contention does. */
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(25),
  /** Seconds an idle Postgres connection stays in the pool before it's closed. `0` keeps connections forever. */
  DATABASE_POOL_IDLE_TIMEOUT: z.coerce.number().int().nonnegative().default(20),
  /** Local uploads-bucket directory. Created on demand by `src/uploads.ts`. */
  UPLOADS_DIR: z.string().min(1),
  /** Port the fastify server listens on when started as an entry point (not used in tests). */
  PORT: z.coerce.number().int().positive().default(4000),
  /** Public absolute URL the backend is reachable at (no trailing slash). Prepended to signed file links so the SPA — served from a different origin in local dev (`http://localhost:4001`) — can resolve them. In dev set this to `http://localhost:4000`; in prod set it to the public origin of the API (often the same host as the SPA when sharing a single domain, in which case relative links would also work). */
  API_URL: z.string().url().default("http://localhost:4000"),
  /** Turns the OpenTelemetry SDK on / off. Defaults to off outside of `development` so tests and prod don't silently depend on a running collector. */
  OTEL_ENABLED: z.stringbool().default(process.env.NODE_ENV === "development"),
  /** Base URL of the OTLP/HTTP collector (no trailing path — `/v1/traces` and `/v1/logs` are appended per signal). Matches the collector service defined in `docker-compose.yml`. Signal-specific overrides below win when set. */
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default("http://localhost:4318"),
  /** Full URL to the OTLP/HTTP traces endpoint (including `/v1/traces`). Overrides `OTEL_EXPORTER_OTLP_ENDPOINT` for traces when set. */
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: z.string().optional(),
  /** Full URL to the OTLP/HTTP logs endpoint (including `/v1/logs`). Overrides `OTEL_EXPORTER_OTLP_ENDPOINT` for logs when set. */
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: z.string().optional(),
  /** Comma-separated `key=value` headers attached to every OTLP request (e.g. an auth token for a hosted collector like Grafana Cloud). Applied to both signals unless a signal-specific variant is set. */
  OTEL_EXPORTER_OTLP_HEADERS: z.string().optional(),
  /** Comma-separated `key=value` headers attached to OTLP traces requests only. Overrides `OTEL_EXPORTER_OTLP_HEADERS` for traces when set. */
  OTEL_EXPORTER_OTLP_TRACES_HEADERS: z.string().optional(),
  /** Comma-separated `key=value` headers attached to OTLP logs requests only. Overrides `OTEL_EXPORTER_OTLP_HEADERS` for logs when set. */
  OTEL_EXPORTER_OTLP_LOGS_HEADERS: z.string().optional(),
  /** Google AI Studio API key used by `payslipParse` to read a payslip PDF with Gemini Flash. Leave unset to disable the feature. Use an AI Studio key bound to a project that does not have billing enabled so requests past the free-tier quota hard-fail with HTTP 429 instead of accruing cost. */
  GEMINI_API_KEY: z.string().min(1).optional(),
  /** Which Gemini model to call from `payslipParse`. Defaults to `gemini-2.5-flash-lite` because it's significantly cheaper and — crucially — sits in a less congested serving pool than flagship Flash, which frequently returns 503 UNAVAILABLE on free + paid tiers alike. Override if you need the bigger model for a harder PDF. */
  GEMINI_MODEL: z.string().min(1).default("gemini-2.5-flash-lite"),
  /** Directory containing a built `packages/web` SPA (the `dist/` output from `vite build`). When set, the server serves those static assets and falls back to `index.html` for non-API GETs so client-side routing works. Leave unset in dev where the web package is served by its own Vite dev server. */
  WEB_DIST_DIR: z.string().min(1).optional(),
  /** 4-digit PIN that gates real-data access. Integer in `[1000, 9999]`. Compared against the value submitted to the `login` mutation; a correct PIN returns a 30-day auth token. */
  AUTH_PIN: z.coerce.number().int().min(1000).max(9999),
  /** HMAC secret used to sign auth tokens. Must be at least 32 characters. Rotating invalidates every outstanding token (real and demo). */
  AUTH_SECRET: z.string().min(32),
  /** App ID for openexchangerates.org used by the `currencyExchangeRates` query to fetch live FX rates. Leave unset to disable the feature — the query will then error and clients fall back to whatever rates the user has saved. */
  OPENEXCHANGERATES_APP_ID: z.string().min(1).optional(),
});

// Strip empty-string values so compose's `${VAR:-}` pass-through (which forwards
// an empty string when the host var is unset) falls through to zod's `.default()`
// or `.optional()` instead of being accepted as a real value.
const rawEnv = Object.fromEntries(
  Object.entries(process.env).filter(([, v]) => v !== ""),
);

export const env = schema.parse(rawEnv);

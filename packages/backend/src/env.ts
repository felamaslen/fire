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
});

export const env = schema.parse(process.env);

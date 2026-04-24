// Preloaded via `NODE_OPTIONS="--import=./otel.mjs"` from `package.json` so the
// OpenTelemetry SDK starts before the app — and therefore before `http` or
// `fastify` — is loaded. Do not import this from application code.
//
// Plain ESM (not TypeScript) so Node's native `--import` loader can evaluate
// it without a transpiler; reads configuration directly from `process.env`
// rather than `src/env.ts` for the same reason.

import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

// Headers: comma-separated `key=value` pairs, per the OTel spec.
function parseHeaders(raw) {
  if (!raw) return undefined;
  const out = {};
  for (const pair of raw.split(",")) {
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

if (process.env.OTEL_ENABLED === "true" || process.env.OTEL_ENABLED === "1") {
  // `||` not `??`: compose's `${VAR:-}` default forwards an empty string for
  // unset host vars, and we want those to fall through to the defaults.
  const base =
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318";
  const tracesEndpoint =
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || `${base}/v1/traces`;
  const logsEndpoint =
    process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT || `${base}/v1/logs`;

  // Signal-specific header envs override the generic `OTEL_EXPORTER_OTLP_HEADERS`.
  const commonHeaders = parseHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS);
  const traceHeaders =
    parseHeaders(process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS) ??
    commonHeaders;
  const logHeaders =
    parseHeaders(process.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS) ?? commonHeaders;

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: "fire-backend",
    }),
    traceExporter: new OTLPTraceExporter({
      url: tracesEndpoint,
      headers: traceHeaders,
    }),
    logRecordProcessors: [
      new BatchLogRecordProcessor(
        new OTLPLogExporter({ url: logsEndpoint, headers: logHeaders }),
      ),
    ],
    // `@fastify/otel` is registered as a Fastify plugin in `src/router.ts` and
    // produces the request-lifecycle spans; `HttpInstrumentation` adds the
    // outer server span plus outbound http client spans (e.g. yahoo-finance).
    instrumentations: [new HttpInstrumentation()],
  });

  sdk.start();

  for (const signal of ["SIGINT", "SIGTERM", "SIGUSR2"]) {
    process.once(signal, () => {
      void sdk.shutdown();
    });
  }
}

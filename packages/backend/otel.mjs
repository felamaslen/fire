// Preloaded via `NODE_OPTIONS="--import=./otel.mjs"` from `package.json` so the
// OpenTelemetry SDK starts before the app — and therefore before `http` or
// `fastify` — is loaded. Do not import this from application code.
//
// Plain ESM (not TypeScript) so Node's native `--import` loader can evaluate
// it without a transpiler; reads configuration directly from `process.env`
// rather than `src/env.ts` for the same reason.

import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

if (process.env.OTEL_ENABLED === "true" || process.env.OTEL_ENABLED === "1") {
  const endpoint =
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318";

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: "fire-backend",
    }),
    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
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

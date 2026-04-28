import FastifyOtelInstrumentation from "@fastify/otel";
import { type Span, trace } from "@opentelemetry/api";
import Fastify, { type FastifyRequest } from "fastify";

import { env } from "./env";
import { fastifyLogger } from "./log";

export const router = Fastify({
  loggerInstance: env.NODE_ENV === "test" ? undefined : fastifyLogger,
});

/** Symbol-keyed pointer to fastify-otel's top-level `request` span — the trace root for an inbound request, captured in our own `onRequest` hook (which runs immediately after fastify-otel's, while its `request` span is still the active span). Used by `createContext` to expose the span to the GraphQL `traceNamePlugin`, which renames it to the operation name so traces show up as `query Foo` instead of `request`. */
export const kFastifyRequestSpan = Symbol("fire/fastify-otel-request-span");
declare module "fastify" {
  interface FastifyRequest {
    [kFastifyRequestSpan]?: Span;
  }
}

if (env.OTEL_ENABLED) {
  const otel = new FastifyOtelInstrumentation({
    registerOnInitialization: false,
  });
  // Must not be awaited: `await` on a Fastify instance (which is what
  // `register()` returns) resolves via `.ready()`, sealing the app and
  // causing subsequent route registrations (like `/graphql`) to silently
  // drop, producing a 404.
  void router.register(otel.plugin());

  router.addHook("onRequest", (request: FastifyRequest, _reply, done) => {
    const span = trace.getActiveSpan();
    if (span) request[kFastifyRequestSpan] = span;
    done();
  });
}

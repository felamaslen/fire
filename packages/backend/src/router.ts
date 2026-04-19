import FastifyOtelInstrumentation from "@fastify/otel";
import Fastify from "fastify";

import { env } from "./env";
import { fastifyLogger } from "./log";

export const router = Fastify({
  loggerInstance: env.NODE_ENV === "test" ? undefined : fastifyLogger,
});

if (env.OTEL_ENABLED) {
  const otel = new FastifyOtelInstrumentation({
    registerOnInitialization: false,
  });
  // Must not be awaited: `await` on a Fastify instance (which is what
  // `register()` returns) resolves via `.ready()`, sealing the app and
  // causing subsequent route registrations (like `/graphql`) to silently
  // drop, producing a 404.
  void router.register(otel.plugin());
}

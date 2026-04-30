import { ApolloServer } from "@apollo/server";
import { fastifyApolloHandler } from "@as-integrations/fastify";
import { context as otelContext } from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { execute, GraphQLError, subscribe, validate } from "graphql";
import { createHandler as createSseHandler } from "graphql-sse";

import { runWithSession } from "@/auth/session-als";
import { runWithDb } from "@/db";
import { defaultDb } from "@/db/client";
import { getDemoDb } from "@/db/demo-db";
import { log } from "@/log";
import { router } from "@/router";

import { getSchema } from "../__generated__/schema";
import { authPlugin, collectNoAuthFields } from "./auth-plugin";
import { constraintPlugin } from "./constraint";
import { type Context, createContext } from "./context";
import { dateScalar } from "./date";
import { dateTimeScalar } from "./date-time";
import { wrapResolversWithSpans } from "./field-spans";
import { initInvalidations } from "./invalidations";
import { applySemanticNonNull } from "./semantic-non-null";
import { traceNamePlugin } from "./trace-name-plugin";
import { uploadScalar } from "./upload";

/** Serializer/parser wiring for each custom scalar in the generated schema. Passed to `getSchema({ scalars })` so grats can hook them up. Exported so tests can build the same schema without duplicating the list. */
export const scalars = {
  Date: dateScalar,
  DateTime: dateTimeScalar,
  Upload: uploadScalar,
};

// Apollo state persists across Vite HMR via globalThis. Only the Fastify route
// registration is one-shot (Fastify rejects plugin registration after boot);
// the Apollo server itself is rebuilt on every module evaluation so schema /
// resolver changes take effect without a process restart.
declare global {
  var __apolloState: { current: ApolloServer<Context> | null } | undefined;
  var __sseState:
    | { current: ReturnType<typeof createSseHandler> | null }
    | undefined;

  var __apolloRouted: boolean | undefined;
}

const builtSchema = wrapResolversWithSpans(
  applySemanticNonNull(getSchema({ scalars })),
);
const builtNoAuthFields = collectNoAuthFields(builtSchema);
initInvalidations(builtSchema);

async function buildApollo(): Promise<ApolloServer<Context>> {
  const schema = builtSchema;
  const noAuthFields = builtNoAuthFields;
  const apollo = new ApolloServer<Context>({
    schema,
    includeStacktraceInErrorResponses: false,
    // `fastifyApolloDrainPlugin` would close the shared Fastify router when
    // Apollo stops — during HMR we stop the previous Apollo on every reload,
    // which would then take the whole Fastify server down with it (503s on
    // every subsequent request). Shutdown is handled in `index.ts` by closing
    // the router directly, so draining from Apollo is not needed.
    plugins: [
      traceNamePlugin<Context>({
        getRequestSpan: (ctx) => ctx.requestSpan,
      }),
      constraintPlugin(schema),
      authPlugin(schema, noAuthFields),
    ],
    formatError(formatted, rawError) {
      const original =
        rawError instanceof GraphQLError ? rawError.originalError : undefined;
      const err = (original ?? rawError) as Error | unknown;
      log.error("GraphQL error", {
        message: formatted.message,
        path: formatted.path,
        err:
          err instanceof Error
            ? {
                name: err.name,
                message: err.message,
                stack: err.stack,
                // Drizzle wraps the underlying pg error as `cause`; surface it so
                // constraint violations don't stay hidden behind "Failed query: …".
                cause:
                  err.cause instanceof Error
                    ? {
                        name: err.cause.name,
                        message: err.cause.message,
                        stack: err.cause.stack,
                      }
                    : err.cause,
              }
            : err,
      });
      const { extensions, ...rest } = formatted;
      const safeExtensions = extensions
        ? Object.fromEntries(
            Object.entries(extensions).filter(([k]) => k !== "stacktrace"),
          )
        : undefined;
      return { ...rest, ...(safeExtensions && { extensions: safeExtensions }) };
    },
  });
  await apollo.start();
  return apollo;
}

globalThis.__apolloState ??= { current: null };
const prev = globalThis.__apolloState.current;
globalThis.__apolloState.current = await buildApollo();
if (prev) await prev.stop();

// Standalone `graphql-sse` handler for the `/graphql/stream` route. Apollo
// doesn't speak subscriptions; we share the same executable schema and run it
// over SSE. We use the framework-agnostic `createHandler` (not the Node-http
// variant) because Fastify's body parser has already drained the request
// stream by the time we get here — the http variant would hang waiting for
// bytes that were consumed upstream. The `demoProgress` subscription is
// `@noAuth`, so no per-request auth scoping is needed here.
globalThis.__sseState ??= { current: null };
// Pass our graphql module's `validate` / `execute` / `subscribe` explicitly so
// graphql-sse uses the same `graphql` instance that built the schema.
// Otherwise the ESM copy of graphql that graphql-sse imports internally does
// an `instanceof` check against a schema built from the CJS copy and throws
// "Cannot use GraphQLSchema from another module or realm".
globalThis.__sseState.current = createSseHandler({
  schema: builtSchema,
  validate,
  execute,
  subscribe,
  // The route handler builds a `Context` per request and stuffs it into the
  // SSE request's `.context` field — pluck it out here so resolvers receive
  // the right `Context` (with the request's session) as `contextValue`.
  context: (req) => req.context as unknown as Record<PropertyKey, unknown>,
});

if (!globalThis.__apolloRouted) {
  globalThis.__apolloRouted = true;
  const state = globalThis.__apolloState;
  const dispatch: FastifyPluginAsync = async (app) => {
    app.route({
      method: ["GET", "POST"],
      url: "/graphql",
      async handler(request, reply) {
        const current = state.current;
        if (!current) throw new Error("Apollo server not initialised");
        const ctx = createContext({ request });
        // Demo sessions route their queries to a dedicated Postgres schema and
        // must not emit OTel traces (keeps the real trace stream clean). Real
        // + anon sessions use the default db and traces flow normally.
        const scopedDb =
          ctx.session.kind === "demo"
            ? getDemoDb(ctx.session.database)
            : defaultDb;
        const handle = () => {
          const apolloHandler = fastifyApolloHandler(current, {
            context: async () => ctx,
          }) as (req: FastifyRequest, rep: FastifyReply) => Promise<unknown>;
          return runWithSession(ctx.session, () =>
            runWithDb(scopedDb, () => apolloHandler(request, reply)),
          );
        };
        if (ctx.session.kind === "demo") {
          return otelContext.with(
            suppressTracing(otelContext.active()),
            handle,
          );
        }
        return handle();
      },
    });

    app.route({
      method: ["GET", "POST"],
      url: "/graphql/stream",
      async handler(request, reply) {
        const sse = globalThis.__sseState?.current;
        if (!sse) throw new Error("SSE handler not initialised");
        reply.hijack();
        const raw = reply.raw;
        const headerMap = new Map<string, string>();
        for (const [k, v] of Object.entries(request.headers)) {
          if (Array.isArray(v)) headerMap.set(k, v.join(", "));
          else if (v != null) headerMap.set(k, v);
        }
        const ctx = createContext({ request });
        const scopedDb =
          ctx.session.kind === "demo"
            ? getDemoDb(ctx.session.database)
            : defaultDb;
        const [body, init] = await otelContext.with(
          suppressTracing(otelContext.active()),
          () =>
            sse({
              method: request.method,
              url: request.url,
              headers: { get: (key) => headerMap.get(key.toLowerCase()) },
              body: request.body as Record<string, unknown> | null,
              raw: request.raw,
              context: ctx,
            }),
        );
        raw.writeHead(init.status, init.statusText, init.headers);
        raw.flushHeaders();
        if (body == null) {
          raw.end();
          return;
        }
        if (typeof body === "string") {
          raw.end(body);
          return;
        }
        // Disable Nagle so each SSE event hits the wire immediately rather
        // than sitting in the TCP buffer for up to 200ms.
        raw.socket?.setNoDelay(true);
        request.raw.on("close", () => {
          void body.return?.(undefined);
        });
        try {
          await runWithSession(ctx.session, () =>
            runWithDb(scopedDb, async () => {
              for await (const chunk of body) {
                if (raw.writableEnded) break;
                raw.write(chunk);
              }
            }),
          );
        } finally {
          if (!raw.writableEnded) raw.end();
        }
      },
    });
  };
  await router.register(dispatch);
}

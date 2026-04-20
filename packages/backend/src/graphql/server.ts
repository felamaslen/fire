import { ApolloServer } from "@apollo/server";
import { fastifyApolloHandler } from "@as-integrations/fastify";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { GraphQLError } from "graphql";

import { runWithSession } from "@/auth/session-als";
import { runWithDb } from "@/db";
import { defaultDb } from "@/db/client";
import { log } from "@/log";
import { router } from "@/router";

import { getSchema } from "../__generated__/schema";
import { authPlugin, collectNoAuthFields } from "./auth-plugin";
import { constraintPlugin } from "./constraint";
import { type Context, createContext } from "./context";
import { dateScalar } from "./date";
import { dateTimeScalar } from "./date-time";
import { applySemanticNonNull } from "./semantic-non-null";
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

  var __apolloRouted: boolean | undefined;
}

async function buildApollo(): Promise<ApolloServer<Context>> {
  const schema = applySemanticNonNull(getSchema({ scalars }));
  const noAuthFields = collectNoAuthFields(schema);
  const apollo = new ApolloServer<Context>({
    schema,
    includeStacktraceInErrorResponses: false,
    // `fastifyApolloDrainPlugin` would close the shared Fastify router when
    // Apollo stops — during HMR we stop the previous Apollo on every reload,
    // which would then take the whole Fastify server down with it (503s on
    // every subsequent request). Shutdown is handled in `index.ts` by closing
    // the router directly, so draining from Apollo is not needed.
    plugins: [constraintPlugin(schema), authPlugin(schema, noAuthFields)],
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
        const apolloHandler = fastifyApolloHandler(current, {
          context: async () => ctx,
        }) as (req: FastifyRequest, rep: FastifyReply) => Promise<unknown>;
        // Stash the session in an ALS and wrap the handler in `runWithDb` so
        // non-resolver code (future demo-session machinery, cache helpers,
        // background fetches) can branch on the session or reach the active
        // db without every call site threading `ctx` through.
        return runWithSession(ctx.session, () =>
          runWithDb(defaultDb, () => apolloHandler(request, reply)),
        );
      },
    });
  };
  await router.register(dispatch);
}

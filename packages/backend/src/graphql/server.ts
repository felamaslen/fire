import { ApolloServer } from "@apollo/server";
import { fastifyApolloHandler } from "@as-integrations/fastify";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { GraphQLError } from "graphql";

import { log } from "@/log";
import { router } from "@/router";

import { getSchema } from "../__generated__/schema";
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
  const apollo = new ApolloServer<Context>({
    schema,
    includeStacktraceInErrorResponses: false,
    // `fastifyApolloDrainPlugin` would close the shared Fastify router when
    // Apollo stops — during HMR we stop the previous Apollo on every reload,
    // which would then take the whole Fastify server down with it (503s on
    // every subsequent request). Shutdown is handled in `index.ts` by closing
    // the router directly, so draining from Apollo is not needed.
    plugins: [constraintPlugin(schema)],
    formatError(formatted, rawError) {
      const original =
        rawError instanceof GraphQLError ? rawError.originalError : undefined;
      log.error("GraphQL error", {
        message: formatted.message,
        path: formatted.path,
        err: original ?? rawError,
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
        // `fastifyApolloHandler` returns a handler typed against its own
        // narrow `RouteInterface`; widen back to the generic Fastify handler
        // shape so our route's request/reply types flow through.
        const apolloHandler = fastifyApolloHandler(current, {
          context: createContext,
        }) as unknown as (
          req: FastifyRequest,
          rep: FastifyReply,
        ) => Promise<unknown>;
        return apolloHandler(request, reply);
      },
    });
  };
  await router.register(dispatch);
}

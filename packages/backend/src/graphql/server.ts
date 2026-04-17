import { ApolloServer } from "@apollo/server";
import fastifyApollo, {
  fastifyApolloDrainPlugin,
} from "@as-integrations/fastify";

import { router } from "@/router";

import { getSchema } from "../__generated__/schema";
import { constraintPlugin } from "./constraint";
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

// Fastify can only accept plugins before boot; when Vite re-evaluates this
// module on HMR, skip re-registration (process restart needed for schema
// changes — the running server keeps serving with the prior schema).
const g = globalThis as { __apolloRegistered?: boolean };
if (!g.__apolloRegistered) {
  g.__apolloRegistered = true;

  const schema = applySemanticNonNull(getSchema({ scalars }));

  const apollo = new ApolloServer({
    schema,
    plugins: [fastifyApolloDrainPlugin(router), constraintPlugin(schema)],
  });

  await apollo.start();
  await router.register(fastifyApollo(apollo));
}

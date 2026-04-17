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

const schema = applySemanticNonNull(getSchema({ scalars }));

const apollo = new ApolloServer({
  schema,
  plugins: [fastifyApolloDrainPlugin(router), constraintPlugin(schema)],
});

await apollo.start();
await router.register(fastifyApollo(apollo));

import { ApolloServer } from "@apollo/server";
import fastifyApollo, {
  fastifyApolloDrainPlugin,
} from "@as-integrations/fastify";
import Fastify from "fastify";

import { getSchema } from "./__generated__/schema";
import { dateScalar } from "./graphql/date";
import { dateTimeScalar } from "./graphql/date-time";
import { applySemanticNonNull } from "./graphql/semantic-non-null";

export const fastify = Fastify({ logger: process.env.NODE_ENV !== "test" });

/** Serializer/parser wiring for each custom scalar in the generated schema. Passed to `getSchema({ scalars })` so grats can hook them up. Exported so tests can build the same schema without duplicating the list. */
export const scalars = {
  Date: dateScalar,
  DateTime: dateTimeScalar,
};

const apollo = new ApolloServer({
  schema: applySemanticNonNull(getSchema({ scalars })),
  plugins: [fastifyApolloDrainPlugin(fastify)],
});

await apollo.start();
await fastify.register(fastifyApollo(apollo));

if (process.env.NODE_ENV !== "test") {
  const port = Number(process.env.PORT ?? 4000);
  await fastify.listen({ port, host: "0.0.0.0" });
}

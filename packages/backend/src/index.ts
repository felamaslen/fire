import { ApolloServer } from "@apollo/server";
import fastifyApollo, {
  fastifyApolloDrainPlugin,
} from "@as-integrations/fastify";
import Fastify from "fastify";

import { getSchema } from "./__generated__/schema";
import { dateScalar } from "./graphql/date";
import { dateTimeScalar } from "./graphql/date-time";

export const fastify = Fastify({ logger: process.env.NODE_ENV !== "test" });

const apollo = new ApolloServer({
  schema: getSchema({
    scalars: { Date: dateScalar, DateTime: dateTimeScalar },
  }),
  plugins: [fastifyApolloDrainPlugin(fastify)],
});

await apollo.start();
await fastify.register(fastifyApollo(apollo));

if (process.env.NODE_ENV !== "test") {
  const port = Number(process.env.PORT ?? 4000);
  await fastify.listen({ port, host: "0.0.0.0" });
}

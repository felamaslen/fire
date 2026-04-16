import { ApolloServer } from "@apollo/server";
import fastifyApollo, {
  fastifyApolloDrainPlugin,
} from "@as-integrations/fastify";
import Fastify from "fastify";

import { getSchema } from "./__generated__/schema";
import { dateTimeScalar } from "./graphql/date-time";

const fastify = Fastify({ logger: true });

const apollo = new ApolloServer({
  schema: getSchema({ scalars: { DateTime: dateTimeScalar } }),
  plugins: [fastifyApolloDrainPlugin(fastify)],
});

await apollo.start();
await fastify.register(fastifyApollo(apollo));

const port = Number(process.env.PORT ?? 4000);
await fastify.listen({ port, host: "0.0.0.0" });

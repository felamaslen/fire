import Fastify from "fastify";

import { env } from "./env";
import { fastifyLogger } from "./log";

export const router = Fastify({
  loggerInstance: env.NODE_ENV === "test" ? undefined : fastifyLogger,
});

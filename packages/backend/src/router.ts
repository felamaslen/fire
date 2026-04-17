import Fastify from "fastify";

import { env } from "./env";

export const router = Fastify({ logger: env.NODE_ENV !== "test" });

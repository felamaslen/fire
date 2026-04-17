import Fastify from "fastify";

export const router = Fastify({ logger: process.env.NODE_ENV !== "test" });

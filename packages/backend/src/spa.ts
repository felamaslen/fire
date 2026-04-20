import path from "node:path";

import fastifyStatic from "@fastify/static";

import { env } from "./env";
import { router } from "./router";

/** API paths that must 404 as-is instead of falling through to the SPA shell. Kept in sync with the routes registered elsewhere under `src/**`. */
const API_PREFIXES = ["/graphql", "/files/", "/schema.graphql"];

if (env.WEB_DIST_DIR) {
  const root = path.resolve(env.WEB_DIST_DIR);

  await router.register(fastifyStatic, {
    root,
    wildcard: false,
    index: ["index.html"],
  });

  router.setNotFoundHandler((req, reply) => {
    if (
      req.method !== "GET" ||
      API_PREFIXES.some((p) => req.url === p || req.url.startsWith(p))
    ) {
      return reply.code(404).send();
    }
    return reply.sendFile("index.html");
  });
}

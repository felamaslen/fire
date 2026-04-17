import { createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { router } from "@/router";

const schemaPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../__generated__/schema.graphql",
);

router.get("/schema.graphql", async (_req, reply) => {
  reply.header("content-type", "text/plain; charset=utf-8");
  reply.header("content-disposition", 'attachment; filename="schema.graphql"');
  return reply.send(createReadStream(schemaPath));
});

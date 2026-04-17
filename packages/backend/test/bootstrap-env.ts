import path from "node:path";

// Must load before any import that triggers `@/env` parsing — namespaces the
// uploads bucket per vitest worker so parallel runs don't stomp on each other.
const workerId =
  process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? "1";
const base = process.env.UPLOADS_DIR ?? "./.uploads-test";
process.env.UPLOADS_DIR = path.join(base, `worker-${workerId}`);

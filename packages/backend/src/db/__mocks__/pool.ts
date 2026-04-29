import pgImport, { type PoolClient } from "pg";

const PgImpl = pgImport.native ?? pgImport;

function testDbName(): string {
  const workerId =
    process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? "1";
  return `fire_test_${workerId}`;
}

/** Per-worker pool: each vitest worker holds its own pool against its own per-worker database. `max` is small on purpose — Postgres' default `max_connections` is 100, and many concurrent workers × 10 each blows past that. `idleTimeoutMillis` lets sockets close between tests so the kernel doesn't hold ports open. */
export const pool = new PgImpl.Pool({
  connectionString: `postgres://fire:fire@localhost:5433/${testDbName()}`,
  max: 5,
  idleTimeoutMillis: 5_000,
});

/** Clients currently borrowed from the pool, keyed to the stack trace of the call that borrowed them. Iterated in `afterEach` so a leak surfaces *how many* connections were never returned, *what query* (if any) is still in flight, and *where* the leaking code path acquired the client. */
const inFlight = new Map<PoolClient, { acquiredAt: string }>();

pool.on("acquire", (client) => {
  // Capture the stack at acquire time. We slice off the first few frames
  // (this listener + pg internals) so the user-visible top frame points at
  // the application code that triggered the borrow.
  const acquiredAt = new Error().stack ?? "";
  inFlight.set(client, { acquiredAt });
});
pool.on("release", (_err, client) => {
  inFlight.delete(client);
});

// Fail loudly between tests if a query or transaction wasn't awaited /
// committed / rolled back — leaks would otherwise carry data into the next
// test and corrupt it. Lives here (next to the counter it observes) rather
// than in `test/setup.ts` so the test-only concern stays out of prod code.
afterEach(() => {
  if (inFlight.size === 0) return;
  const leaks = [...inFlight.entries()].map(([client, info], i) => {
    // `_activeQuery` is pg's internal handle to the query currently executing
    // on the client. It's `null` when the client is sitting idle inside a
    // transaction (the most common leak shape: BEGIN issued, no COMMIT /
    // ROLLBACK), in which case the acquire stack is the only useful clue.
    const activeQuery = (
      client as unknown as { _activeQuery?: { text?: string } | null }
    )._activeQuery;
    const queryLine = activeQuery?.text
      ? `    in-flight query: ${activeQuery.text.replace(/\s+/g, " ").trim().slice(0, 200)}`
      : `    (idle — connection acquired but no query running; likely an open transaction)`;
    const stackLines = info.acquiredAt
      .split("\n")
      .slice(2, 6)
      .map((l) => `    ${l.trim()}`)
      .join("\n");
    return `  Client #${i + 1}:\n${queryLine}\n    acquired at:\n${stackLines}`;
  });
  const count = inFlight.size;
  // Reset so a single leak doesn't cascade-fail every subsequent test.
  inFlight.clear();
  throw new Error(
    `Test leaked ${count} Postgres connection${count === 1 ? "" : "s"} — a query or transaction wasn't awaited / committed / rolled back.\n${leaks.join("\n\n")}`,
  );
});

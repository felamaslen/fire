import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

/**
 * Build a fresh MSW server with lifecycle hooks already wired to the caller's test file. Use in the same file as `describe`/`it` so that `beforeAll`/`afterEach`/`afterAll` register against it. Tests register handlers with `server.use(...)`.
 */
export function useMswServer(): ReturnType<typeof setupServer> {
  const server = setupServer();
  beforeAll(() => server.listen({ onUnhandledRequest: "warn" }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());
  return server;
}

export { http, HttpResponse };

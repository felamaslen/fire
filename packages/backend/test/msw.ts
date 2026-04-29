import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

/** Single process-wide MSW server. Started in `test/setup.ts` with `onUnhandledRequest: "error"` so any outbound HTTP a test doesn't explicitly mock fails loudly instead of hitting the real network (and, in the case of fire-and-forget background fetches, leaking a DB connection past the test). */
export const mswServer = setupServer();

/** Register handler-cleanup for the calling test file. Tests still register handlers with `server.use(...)`; lifecycle (`listen` / `close`) is owned by `test/setup.ts` so there's exactly one interceptor for the whole process. */
export function useMswServer(): typeof mswServer {
  afterEach(() => mswServer.resetHandlers());
  return mswServer;
}

export { http, HttpResponse };

import { timingSafeEqual } from "node:crypto";

import { GraphQLError } from "graphql";
import type { Int } from "grats";

import { signToken } from "@/auth/token";
import { env } from "@/env";

import type { Context } from "./context";

/**
 * Result of a successful `login` / shape of `me` for a valid token. The client just needs to know "am I logged in?" — `token` doubles as both credential and success signal.
 *
 * @gqlType
 */
export type AuthResult = {
  /** Signed token. Real tokens live 30 days. Store in `localStorage` and attach as `Authorization: Bearer <token>`. @gqlField */
  token: string;
};

/**
 * Return the current session's auth info, or `null` if the request is anonymous. Used by the web app on boot to decide whether to send the user to the login screen or straight to the dashboard.
 *
 * @gqlQueryField
 * @gqlAnnotate noAuth
 */
export function me(ctx: Context): AuthResult | null {
  if (ctx.session.kind === "anon") return null;
  return { token: signToken({ kind: "real" }) };
}

/**
 * Exchange the 4-digit PIN (from the `AUTH_PIN` env var) for a 30-day real-session token. Rejects with `Invalid PIN` on mismatch; the comparison is constant-time.
 *
 * @gqlMutationField
 * @gqlAnnotate noAuth
 */
export function login(pin: Int): AuthResult {
  if (!constantTimeEqualInt(pin, env.AUTH_PIN)) {
    throw new GraphQLError("Invalid PIN", {
      extensions: { code: "UNAUTHENTICATED" },
    });
  }
  return { token: signToken({ kind: "real" }) };
}

/**
 * Invalidate the current session. Real sessions are stateless — tokens are stateless; the client just discards it. The server-side no-op keeps the mutation shape consistent so future session kinds can do real work here.
 *
 * @gqlMutationField
 * @gqlAnnotate noAuth
 */
export function logout(): boolean {
  return true;
}

function constantTimeEqualInt(a: number, b: number): boolean {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

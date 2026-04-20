import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { env } from "@/env";

/** 30 days — matches the spec for real-user token lifetime. */
export const REAL_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

/** 6 hours — matches the demo schema TTL so a token can never outlive its data. */
export const DEMO_TOKEN_TTL_SECONDS = 6 * 60 * 60;

/** Runtime schema for an unsigned token payload (the bit the caller supplies). */
export const tokenPayloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("real") }),
  z.object({
    kind: z.literal("demo"),
    /** Postgres database holding this session's data, e.g. `demo_ab12cd34…`. */
    database: z.string().regex(/^demo_[A-Za-z0-9_]+$/u),
    /** Which seed flavour the demo was initialised from. Mirrors the `DemoFlavour` GraphQL enum. */
    flavour: z.string().min(1),
  }),
]);
export type TokenPayload = z.infer<typeof tokenPayloadSchema>;

/** Runtime schema for a fully-signed token payload (includes JWT-style `iat` / `exp`). */
export const signedPayloadSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("real"),
    iat: z.number().int().nonnegative(),
    exp: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("demo"),
    database: z.string().regex(/^demo_[A-Za-z0-9_]+$/u),
    flavour: z.string().min(1),
    iat: z.number().int().nonnegative(),
    exp: z.number().int().nonnegative(),
  }),
]);
export type SignedPayload = z.infer<typeof signedPayloadSchema>;

/** Sign a payload into a compact `base64url(header).base64url(body).base64url(sig)` token. Not a full JWT library — HS256 only, no `alg: none`, no external dependency. */
export function signToken(
  payload: TokenPayload,
  opts: { now?: Date } = {},
): string {
  const nowSec = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  const ttl =
    payload.kind === "real" ? REAL_TOKEN_TTL_SECONDS : DEMO_TOKEN_TTL_SECONDS;
  const signed: SignedPayload = { ...payload, iat: nowSec, exp: nowSec + ttl };
  const header = b64urlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64urlEncode(JSON.stringify(signed));
  const sig = hmacSign(`${header}.${body}`);
  return `${header}.${body}.${sig}`;
}

/** Parse and verify a token. Returns the payload on success, `null` on any failure (bad shape, bad signature, expired). Does not throw — callers treat every failure as "not logged in". */
export function verifyToken(
  token: string,
  opts: { now?: Date } = {},
): SignedPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expected = hmacSign(`${header}.${body}`);
  if (!safeEqual(sig, expected)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(b64urlDecode(body).toString("utf8"));
  } catch {
    return null;
  }
  const parsed = signedPayloadSchema.safeParse(raw);
  if (!parsed.success) return null;
  const nowSec = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  if (parsed.data.exp <= nowSec) return null;
  return parsed.data;
}

function hmacSign(data: string): string {
  return b64urlEncodeBuffer(
    createHmac("sha256", env.AUTH_SECRET).update(data).digest(),
  );
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function b64urlEncode(s: string): string {
  return b64urlEncodeBuffer(Buffer.from(s, "utf8"));
}

function b64urlEncodeBuffer(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/=+$/u, "")
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_");
}

function b64urlDecode(s: string): Buffer {
  const padded = s.replace(/-/gu, "+").replace(/_/gu, "/");
  const pad =
    padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  return Buffer.from(padded + pad, "base64");
}

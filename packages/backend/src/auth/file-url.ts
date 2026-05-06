import { createHmac, timingSafeEqual } from "node:crypto";

import { env } from "@/env";
import type { Session } from "@/graphql/context";

/** Short — these URLs live only long enough for the browser to load the iframe / image. 1 hour keeps an already-rendered page working across a refresh without handing out a durable credential. */
const DOWNLOAD_TTL_SECONDS = 60 * 60;

/** Turn a storage key into an absolute `<API_URL>/files/<key>?sig=…&exp=…` URL the `/files/*` handler will accept. The sig covers `key + exp` so the key can't be swapped. The host comes from `env.API_URL` (e.g. `http://localhost:4000` in dev) so SPA-served links resolve back to the API origin even when the two sit on different hosts. */
export function signFileUrl(key: string, now: Date = new Date()): string {
  const exp = Math.floor(now.getTime() / 1000) + DOWNLOAD_TTL_SECONDS;
  const sig = hmac(`${key}.${exp}`);
  const encoded = key.split("/").map(encodeURIComponent).join("/");
  return `${env.API_URL.replace(/\/$/, "")}/files/${encoded}?exp=${exp}&sig=${sig}`;
}

/** Verify that `sig` was produced from `key + exp` via our secret, and that `exp` hasn't passed yet. Returns `false` on any mismatch — callers treat it as "404". */
export function verifyFileSig(
  key: string,
  exp: string | undefined,
  sig: string | undefined,
  now: Date = new Date(),
): boolean {
  if (!exp || !sig) return false;
  const expNum = Number(exp);
  if (!Number.isFinite(expNum)) return false;
  if (expNum * 1000 <= now.getTime()) return false;
  const expected = hmac(`${key}.${expNum}`);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Return the on-disk path prefix `storeUpload` should write under for this session. Real uploads stay at the bucket root (no prefix) — existing files were stored that way, so leaving the convention preserves their URLs. Demo uploads are written under `demo/<schema>/` so they're isolated per session and can be wiped in a single `rm -rf` on logout / sweep.
 */
export function scopePrefixForSession(session: Session): string | null {
  if (session.kind === "real") return "";
  if (session.kind === "demo") return `demo/${session.database}/`;
  return null;
}

/** Is this session allowed to resolve `key`? The real (PIN-gated) user owns every non-demo file, plus can see into any demo scope (single-tenant admin). A demo session may only read keys under its own `demo/<database>/` prefix — never a real file, never another demo session's files. */
export function sessionMayReadKey(session: Session, key: string): boolean {
  if (session.kind === "anon") return false;
  if (session.kind === "real") return true;
  if (session.kind === "demo") {
    return key.startsWith(`demo/${session.database}/`);
  }
  return false;
}

function hmac(data: string): string {
  return createHmac("sha256", env.AUTH_SECRET)
    .update(data)
    .digest("base64")
    .replace(/=+$/u, "")
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_");
}

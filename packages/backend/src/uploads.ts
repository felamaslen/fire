import { strict as assert } from "node:assert";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import type { FileUpload } from "graphql-upload/processRequest.mjs";
import processRequest from "graphql-upload/processRequest.mjs";
import { v7 as uuidv7 } from "uuid";

import { scopePrefixForSession, verifyFileSig } from "./auth/file-url";
import { env } from "./env";
import type { Session } from "./graphql/context";
import { router } from "./router";

// TODO: swap for a cloud object store (GCS / S3) behind the same `storeUpload` / `readStoredFile` interface.

/** Directory used as the local "bucket"; created at boot. */
async function ensureBucket(): Promise<string> {
  const dir = path.resolve(env.UPLOADS_DIR);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  return dir;
}
await ensureBucket();

/** Persist an already-resolved graphql-upload `FileUpload` to the local bucket and return the storage key. Real uploads land at the bucket root (unscoped — matches the historical layout so existing files don't move); demo uploads are namespaced under `demo/<schema>/` so they're isolated per session and cleanable in one `rm -rf` on logout. Anonymous sessions cannot upload. */
export async function storeUpload(
  upload: FileUpload,
  session: Session,
): Promise<string> {
  const scope = scopePrefixForSession(session);
  assert(scope != null, "Cannot store uploads for anonymous session");
  const { createReadStream, filename } = upload;
  const dir = await ensureBucket();
  const safeFilename = filename.replace(/[^\w.-]/g, "_") || "file";
  const key = `${scope}${uuidv7()}-${safeFilename}`;
  const dest = path.join(dir, key);
  await mkdir(path.dirname(dest), { recursive: true });
  await pipeline(createReadStream(), createWriteStream(dest));
  return key;
}

/** Absolute path for a stored key. Resolves strictly inside the bucket — throws on `..` traversal. */
async function resolveStoredPath(key: string): Promise<string> {
  const dir = await ensureBucket();
  const resolved = path.resolve(dir, key);
  assert(
    resolved.startsWith(dir + path.sep),
    `Upload key "${key}" escapes the bucket directory.`,
  );
  return resolved;
}

/** Wipe every file a demo session produced. Called from `dropDemoSession` so a demo user's payslips don't outlive their schema. */
export async function removeSessionUploads(schema: string): Promise<void> {
  if (!/^demo_[A-Za-z0-9_]+$/u.test(schema)) return;
  const dir = await ensureBucket();
  const target = path.join(dir, "demo", schema);
  await rm(target, { recursive: true, force: true });
}

// HMR guard: Fastify rejects plugin registration after boot, so under Vite
// re-evaluations (triggered e.g. by editing any file that imports this one)
// the module must be a no-op. The route + parser only register on first load.
declare global {
  var __uploadsRouted: boolean | undefined;
}

if (!globalThis.__uploadsRouted) {
  globalThis.__uploadsRouted = true;

  // Let graphql-upload's processRequest own the request body for multipart uploads. Fastify's default JSON/body parsing would otherwise consume the stream.
  router.addContentTypeParser("multipart/form-data", (_req, _payload, done) => {
    done(null);
  });

  router.addHook("preValidation", async (req, reply) => {
    const contentType = req.headers["content-type"] ?? "";
    if (!contentType.startsWith("multipart/form-data")) return;
    req.body = await processRequest(req.raw, reply.raw);
  });

  // Files are served with a short-lived HMAC-signed query param (`sig` + `exp`)
  // so a URL pasted into an <iframe> / <img> works without a bearer header. The
  // signature is issued by `signFileUrl` on the GraphQL response path, which
  // also enforces session-scope access — so this handler's job is limited to
  // verifying the signature and refusing anything else.
  router.get<{
    Params: { "*": string };
    Querystring: { exp?: string; sig?: string };
  }>("/files/*", async (req, reply) => {
    try {
      const key = req.params["*"];
      if (!key) return reply.code(404).send();
      if (!verifyFileSig(key, req.query.exp, req.query.sig)) {
        return reply.code(404).send();
      }
      const absolute = await resolveStoredPath(key);
      if (!existsSync(absolute)) return reply.code(404).send();
      reply.header(
        "content-disposition",
        `inline; filename="${path.basename(absolute)}"`,
      );
      return reply.send(createReadStream(absolute));
    } catch {
      return reply.code(404).send();
    }
  });
}

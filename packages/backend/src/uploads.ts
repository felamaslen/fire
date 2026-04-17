import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import type { FileUpload } from "graphql-upload/processRequest.mjs";
import processRequest from "graphql-upload/processRequest.mjs";

import { router } from "./router";

// TODO: swap for a cloud object store (GCS / S3) behind the same `storeUpload` / `readStoredFile` interface.

/** Directory used as the local "bucket". Must be set via `UPLOADS_DIR`; created on demand at boot. */
function bucketDir(): string {
  const dir = process.env.UPLOADS_DIR;
  assert(
    dir,
    "UPLOADS_DIR env var must be set (path to the local uploads bucket).",
  );
  return path.resolve(dir);
}

async function ensureBucket(): Promise<string> {
  const dir = bucketDir();
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  return dir;
}

/** Persist an already-resolved graphql-upload `FileUpload` to the local bucket and return the stored key. Mutations that accept `file: Upload` should `await file` first and pass the result in. */
export async function storeUpload(upload: FileUpload): Promise<string> {
  const { createReadStream, filename } = upload;
  const dir = await ensureBucket();
  const safeFilename = filename.replace(/[^\w.-]/g, "_") || "file";
  const key = `${randomUUID()}-${safeFilename}`;
  const dest = path.join(dir, key);
  await pipeline(createReadStream(), createWriteStream(dest));
  return key;
}

/** Absolute path for a stored key. Resolves strictly inside the bucket — throws on `..` traversal. */
function resolveStoredPath(key: string): string {
  const dir = bucketDir();
  const resolved = path.resolve(dir, key);
  assert(
    resolved.startsWith(dir + path.sep),
    `Upload key "${key}" escapes the bucket directory.`,
  );
  return resolved;
}

// Let graphql-upload's processRequest own the request body for multipart uploads. Fastify's default JSON/body parsing would otherwise consume the stream.
router.addContentTypeParser("multipart/form-data", (_req, _payload, done) => {
  done(null);
});

router.addHook("preValidation", async (req, reply) => {
  const contentType = req.headers["content-type"] ?? "";
  if (!contentType.startsWith("multipart/form-data")) return;
  req.body = await processRequest(req.raw, reply.raw);
});

// TODO: swap for a GCS / S3 signed-URL endpoint once we move off the local bucket.
router.get<{ Params: { key: string } }>("/files/:key", (req, reply) => {
  try {
    const absolute = resolveStoredPath(req.params.key);
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

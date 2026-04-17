import { readFile } from "node:fs/promises";
import path from "node:path";

const MIME_BY_EXT: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".txt": "text/plain",
};

/**
 * Sentinel used inside `runGql` variables to mark a multipart file upload. The path is resolved to bytes + filename + mimetype at send time; `runGql` detects any `TestUpload` in the variables tree and switches to a graphql-multipart-request-spec request.
 */
export class TestUpload {
  constructor(public readonly filePath: string) {}

  get filename(): string {
    return path.basename(this.filePath);
  }

  get mimetype(): string {
    const ext = path.extname(this.filePath).toLowerCase();
    return MIME_BY_EXT[ext] ?? "application/octet-stream";
  }

  async read(): Promise<Buffer> {
    return readFile(this.filePath);
  }
}

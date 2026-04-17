import type { ID } from "grats";
import { z } from "zod";

const cursorSchema = z.object({
  /** Sort-key value (e.g. `createdAt` ISO, `start` ISO). */
  c: z.string(),
  /** Row id, used as a deterministic tie-break when two rows share `c`. */
  i: z.string(),
});

export type Cursor = z.infer<typeof cursorSchema>;

export function encodeCursor(c: string, i: string): ID {
  return Buffer.from(JSON.stringify({ c, i }), "utf8").toString(
    "base64url",
  ) as ID;
}

export function decodeCursor(raw: string): Cursor {
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    return cursorSchema.parse(JSON.parse(json));
  } catch {
    throw new Error("invalid cursor");
  }
}

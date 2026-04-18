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

/** Pagination state for a cursor-paginated connection. @gqlType */
export type PageInfo = {
  /** @gqlField */
  hasNextPage: boolean;
  /** @gqlField */
  hasPreviousPage: boolean;
  /** @gqlField */
  startCursor: ID | null;
  /** @gqlField */
  endCursor: ID | null;
};

/** A single entry inside a `Connection`. Carries its own `cursor` so clients can resume pagination from any row. @gqlType */
export type Edge<T> = {
  /** @gqlField */
  cursor: ID;
  /** @gqlField */
  node: T;
};

/** A cursor-paginated list. Concrete materialisations (e.g. `Connection<NetWorthEntry>` → `NetWorthEntryConnection`) are emitted per node type. @gqlType */
export type Connection<T> = {
  /** @gqlField */
  edges: Edge<T>[];
  /** @gqlField */
  pageInfo: PageInfo;
};

/** Build a `Connection` from an already-sliced page plus the cursor/hasMore state the caller worked out. */
export function buildConnection<T>(
  nodes: T[],
  cursorFor: (node: T) => ID,
  flags: { hasNextPage: boolean; hasPreviousPage: boolean },
): Connection<T> {
  const edges: Edge<T>[] = nodes.map((node) => ({
    cursor: cursorFor(node),
    node,
  }));
  return {
    edges,
    pageInfo: {
      hasNextPage: flags.hasNextPage,
      hasPreviousPage: flags.hasPreviousPage,
      startCursor: edges.length > 0 ? edges[0].cursor : null,
      endCursor: edges.length > 0 ? edges[edges.length - 1].cursor : null,
    },
  };
}

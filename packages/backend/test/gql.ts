import "@/index";

import { randomBytes } from "node:crypto";

import {
  initGraphQLTada,
  type ResultOf,
  type TadaDocumentNode,
  type VariablesOf,
} from "gql.tada";
import { print } from "graphql";

import type { introspection } from "@/__generated__/graphql-env";
import { router } from "@/router";

export const graphql = initGraphQLTada<{
  introspection: introspection;
  scalars: {
    Date: string;
    DateTime: string;
    ID: string;
    Upload: unknown;
  };
}>();

export async function runGql<Q extends TadaDocumentNode<any, any>>(
  doc: Q,
  variables: VariablesOf<Q>,
): Promise<ResultOf<Q>> {
  const res = await router.inject({
    method: "POST",
    url: "/graphql",
    payload: { query: print(doc), variables },
  });
  const body = JSON.parse(res.body) as {
    data?: ResultOf<Q>;
    errors?: Array<{ message: string }>;
  };
  if (body.errors?.length) {
    throw new Error(
      `GraphQL errors: ${body.errors.map((e) => e.message).join("; ")}`,
    );
  }
  if (body.data == null) throw new Error("No data returned");
  return body.data;
}

/** A file attachment for `runGqlUpload`. `path` is a dot-separated path into `variables` (e.g. `"file"` or `"input.attachment"`). */
export type UploadAttachment = {
  path: string;
  filename: string;
  mimetype: string;
  content: Buffer | string;
};

/**
 * Execute a GraphQL operation with attached files via multipart/form-data, per the graphql-multipart-request-spec. Variables referenced by an attachment must be `null` in `variables` — the `path` field maps each file onto its variable slot.
 */
export async function runGqlUpload<Q extends TadaDocumentNode<any, any>>(
  doc: Q,
  variables: VariablesOf<Q>,
  attachments: readonly UploadAttachment[],
): Promise<ResultOf<Q>> {
  const boundary = `----Boundary${randomBytes(8).toString("hex")}`;
  const parts: Buffer[] = [];
  const write = (s: string) => parts.push(Buffer.from(s));

  write(`--${boundary}\r\n`);
  write(`Content-Disposition: form-data; name="operations"\r\n\r\n`);
  write(JSON.stringify({ query: print(doc), variables }));
  write("\r\n");

  const map = Object.fromEntries(
    attachments.map((a, i) => [String(i), [`variables.${a.path}`]]),
  );
  write(`--${boundary}\r\n`);
  write(`Content-Disposition: form-data; name="map"\r\n\r\n`);
  write(JSON.stringify(map));
  write("\r\n");

  for (const [i, a] of attachments.entries()) {
    write(`--${boundary}\r\n`);
    write(
      `Content-Disposition: form-data; name="${i}"; filename="${a.filename}"\r\n`,
    );
    write(`Content-Type: ${a.mimetype}\r\n\r\n`);
    parts.push(
      typeof a.content === "string" ? Buffer.from(a.content) : a.content,
    );
    write("\r\n");
  }
  write(`--${boundary}--\r\n`);

  const body = Buffer.concat(parts);
  const res = await router.inject({
    method: "POST",
    url: "/graphql",
    payload: body,
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(body.length),
      // Apollo's CSRF-prevention requires an opt-in header for multipart requests.
      "apollo-require-preflight": "true",
    },
  });
  const parsed = JSON.parse(res.body) as {
    data?: ResultOf<Q>;
    errors?: Array<{ message: string }>;
  };
  if (parsed.errors?.length) {
    throw new Error(
      `GraphQL errors: ${parsed.errors.map((e) => e.message).join("; ")}`,
    );
  }
  if (parsed.data == null) throw new Error("No data returned");
  return parsed.data;
}

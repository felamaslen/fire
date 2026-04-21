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
import { signToken } from "@/auth/token";
import { router } from "@/router";

import { TestUpload } from "./upload";

// Real-session token signed once per worker with the test `AUTH_SECRET`. The
// auth plugin gates every non-`@noAuth` root field, so without this every
// `runGql` would fail with `UNAUTHENTICATED`.
const AUTH_HEADER = `Bearer ${signToken({ kind: "real" })}`;

export const graphql = initGraphQLTada<{
  introspection: introspection;
  scalars: {
    Date: string;
    DateTime: string;
    ID: string;
    Upload: unknown;
  };
}>();

type GqlBody<Q extends TadaDocumentNode<any, any>> = {
  data?: ResultOf<Q>;
  errors?: Array<{ message: string }>;
};

/**
 * Execute a GraphQL operation against the injected server. If any variable (or nested variable) is a `TestUpload`, switches automatically to a graphql-multipart-request-spec POST with the file attached.
 */
export async function runGql<Q extends TadaDocumentNode<any, any>>(
  doc: Q,
  variables: VariablesOf<Q>,
): Promise<ResultOf<Q>> {
  const uploads = collectUploads(variables);
  if (uploads.length === 0) {
    return runJsonOperation(doc, variables);
  }
  return runMultipartOperation(doc, variables, uploads);
}

async function runJsonOperation<Q extends TadaDocumentNode<any, any>>(
  doc: Q,
  variables: VariablesOf<Q>,
): Promise<ResultOf<Q>> {
  const res = await router.inject({
    method: "POST",
    url: "/graphql",
    payload: { query: print(doc), variables },
    headers: { authorization: AUTH_HEADER },
  });
  return unwrap<Q>(JSON.parse(res.body));
}

async function runMultipartOperation<Q extends TadaDocumentNode<any, any>>(
  doc: Q,
  variables: VariablesOf<Q>,
  uploads: Array<{ path: string; upload: TestUpload }>,
): Promise<ResultOf<Q>> {
  // Replace TestUpload sentinels in variables with null per the spec.
  const opVars = replaceUploadsWithNull(variables, uploads);
  const boundary = `----Boundary${randomBytes(8).toString("hex")}`;
  const parts: Buffer[] = [];
  const write = (s: string) => parts.push(Buffer.from(s));

  write(`--${boundary}\r\n`);
  write(`Content-Disposition: form-data; name="operations"\r\n\r\n`);
  write(JSON.stringify({ query: print(doc), variables: opVars }));
  write("\r\n");

  const map = Object.fromEntries(
    uploads.map((u, i) => [String(i), [`variables.${u.path}`]]),
  );
  write(`--${boundary}\r\n`);
  write(`Content-Disposition: form-data; name="map"\r\n\r\n`);
  write(JSON.stringify(map));
  write("\r\n");

  for (const [i, u] of uploads.entries()) {
    const content = await u.upload.read();
    write(`--${boundary}\r\n`);
    write(
      `Content-Disposition: form-data; name="${i}"; filename="${u.upload.filename}"\r\n`,
    );
    write(`Content-Type: ${u.upload.mimetype}\r\n\r\n`);
    parts.push(content);
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
      authorization: AUTH_HEADER,
    },
  });
  return unwrap<Q>(JSON.parse(res.body));
}

function unwrap<Q extends TadaDocumentNode<any, any>>(
  body: GqlBody<Q>,
): ResultOf<Q> {
  if (body.errors?.length) {
    throw new Error(
      `GraphQL errors: ${body.errors.map((e) => e.message).join("; ")}`,
    );
  }
  if (body.data == null) throw new Error("No data returned");
  return body.data;
}

function collectUploads(
  value: unknown,
  path: string[] = [],
): Array<{ path: string; upload: TestUpload }> {
  if (value instanceof TestUpload) {
    return [{ path: path.join("."), upload: value }];
  }
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => collectUploads(v, path.concat(String(i))));
  }
  if (value != null && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) =>
      collectUploads(v, path.concat(k)),
    );
  }
  return [];
}

function replaceUploadsWithNull<T>(
  value: T,
  uploads: Array<{ path: string; upload: TestUpload }>,
): T {
  if (uploads.length === 0) return value;
  // Deep-clone swapping TestUpload instances for null.
  const swap = (v: unknown): unknown => {
    if (v instanceof TestUpload) return null;
    if (Array.isArray(v)) return v.map(swap);
    if (v != null && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([k, val]) => [
          k,
          swap(val),
        ]),
      );
    }
    return v;
  };
  return swap(value) as T;
}

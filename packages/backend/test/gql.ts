import {
  initGraphQLTada,
  type ResultOf,
  type TadaDocumentNode,
  type VariablesOf,
} from "gql.tada";
import { print } from "graphql";

import type { introspection } from "@/__generated__/graphql-env";
import { fastify } from "@/index";

export const graphql = initGraphQLTada<{
  introspection: introspection;
  scalars: { Date: string; DateTime: string; ID: string };
}>();

export async function runGql<Q extends TadaDocumentNode<any, any>>(
  doc: Q,
  variables: VariablesOf<Q>,
): Promise<ResultOf<Q>> {
  const res = await fastify.inject({
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

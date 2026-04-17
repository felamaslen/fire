import { initGraphQLTada } from "gql.tada";

import type { introspection } from "./__generated__/graphql-env";

export {
  type FragmentOf,
  readFragment,
  type ResultOf,
  type VariablesOf,
} from "gql.tada";

export const graphql = initGraphQLTada<{
  introspection: introspection;
  scalars: {
    Date: string;
    DateTime: string;
    ID: string;
    Upload: unknown;
  };
}>();

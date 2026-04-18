import { ApolloClient, InMemoryCache } from "@apollo/client";
import UploadHttpLink from "apollo-upload-client/UploadHttpLink.mjs";

import { possibleTypes } from "./__generated__/possible-types";

export function createApolloClient() {
  return new ApolloClient({
    link: new UploadHttpLink({
      uri: import.meta.env.VITE_GRAPHQL_URL ?? "http://localhost:4000/graphql",
      headers: { "apollo-require-preflight": "true" },
    }),
    cache: new InMemoryCache({ possibleTypes }),
  });
}

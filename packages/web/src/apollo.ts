import { ApolloClient, InMemoryCache } from "@apollo/client";
import UploadHttpLink from "apollo-upload-client/UploadHttpLink.mjs";

import { possibleTypes } from "./__generated__/possible-types";

export function createApolloClient() {
  return new ApolloClient({
    link: new UploadHttpLink({
      uri: import.meta.env.VITE_GRAPHQL_URL ?? "http://localhost:4000/graphql",
      headers: { "apollo-require-preflight": "true" },
    }),
    cache: new InMemoryCache({
      possibleTypes,
      typePolicies: {
        // Computed value objects with no server-side identity — embed them in
        // their parent entity instead of trying to normalise.
        InvestmentPosition: { keyFields: false, merge: true },
        InvestmentStock: { keyFields: false, merge: true },
        InvestmentFund: { keyFields: false, merge: true },
      },
    }),
  });
}

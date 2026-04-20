import {
  ApolloClient,
  ApolloLink,
  CombinedGraphQLErrors,
  InMemoryCache,
} from "@apollo/client";
import { SetContextLink } from "@apollo/client/link/context";
import { ErrorLink } from "@apollo/client/link/error";
import UploadHttpLink from "apollo-upload-client/UploadHttpLink.mjs";

import { possibleTypes } from "./__generated__/possible-types";
import { clearToken, getToken } from "./auth/token";

export function createApolloClient() {
  let clientRef: ApolloClient | null = null;
  const authLink = new SetContextLink((prevContext) => {
    const token = getToken();
    const headers = (prevContext.headers ?? {}) as Record<string, string>;
    return {
      headers: {
        ...headers,
        "apollo-require-preflight": "true",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    };
  });

  // Any `UNAUTHENTICATED` GraphQL error (expired / tampered / missing token on
  // a gated field) drops the stored token, clears the Apollo cache, and
  // bounces the user to /login. The login route itself calls `login` /
  // `demoLogin` which are `@noAuth`, so they never trip this. Cache is
  // cleared before the hard redirect so nothing the previous session
  // normalised hangs around if the redirect is intercepted / delayed.
  const errorLink = new ErrorLink(({ error }) => {
    if (!CombinedGraphQLErrors.is(error)) return;
    const unauthenticated = error.errors.some(
      (e) => e.extensions?.code === "UNAUTHENTICATED",
    );
    if (unauthenticated) {
      clearToken();
      void clientRef?.clearStore();
      if (window.location.pathname !== "/login") {
        window.location.assign("/login");
      }
    }
  });

  const httpLink = new UploadHttpLink({
    uri: import.meta.env.VITE_GRAPHQL_URL ?? "http://localhost:4000/graphql",
  });

  const client = new ApolloClient({
    link: ApolloLink.from([errorLink, authLink, httpLink]),
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
  clientRef = client;
  return client;
}

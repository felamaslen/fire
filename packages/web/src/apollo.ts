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
  // a gated field) drops the stored token and bounces the user to /login.
  // We deliberately do NOT call `client.clearStore()` here: clearStore
  // aborts every in-flight observable, and if more than one query is in
  // the air when the error arrives (e.g. `netWorthHistory` failing at the
  // same time the login page is loading `demos`) the unrelated query gets
  // cancelled and its component never re-renders — meaning the login
  // page's demo chooser comes up empty until a manual refresh. The hard
  // `window.location.assign` below is a full reload, which discards the
  // cache anyway; for the no-redirect branch (already on `/login`) there's
  // nothing to clear because any cached data belongs to the still-valid
  // anon session.
  const errorLink = new ErrorLink(({ error }) => {
    if (!CombinedGraphQLErrors.is(error)) return;
    const unauthenticated = error.errors.some(
      (e) => e.extensions?.code === "UNAUTHENTICATED",
    );
    if (unauthenticated) {
      clearToken();
      if (window.location.pathname !== "/login") {
        window.location.assign("/login");
      }
    }
  });

  const httpLink = new UploadHttpLink({
    uri: import.meta.env.VITE_GRAPHQL_URL ?? "http://localhost:4000/graphql",
  });

  return new ApolloClient({
    link: ApolloLink.from([errorLink, authLink, httpLink]),
    cache: new InMemoryCache({
      possibleTypes,
      typePolicies: {
        // Computed value objects with no server-side identity — embed them in
        // their parent entity instead of trying to normalise.
        AuthResult: { keyFields: false, merge: true },
        InvestmentPosition: { keyFields: false, merge: true },
        InvestmentStock: { keyFields: false, merge: true },
        InvestmentFund: { keyFields: false, merge: true },
      },
    }),
  });
}

import {
  ApolloClient,
  ApolloLink,
  CombinedGraphQLErrors,
  InMemoryCache,
  Observable,
} from "@apollo/client";
import { SetContextLink } from "@apollo/client/link/context";
import { ErrorLink } from "@apollo/client/link/error";
import { getMainDefinition } from "@apollo/client/utilities";
import UploadHttpLink from "apollo-upload-client/UploadHttpLink.mjs";
import { Kind, type OperationDefinitionNode, print } from "graphql";
import { createClient as createSseClient } from "graphql-sse";

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

  const httpUri =
    import.meta.env.VITE_GRAPHQL_URL ?? "http://localhost:4000/graphql";
  const httpLink = new UploadHttpLink({ uri: httpUri });

  // Subscriptions travel over SSE on a parallel route. `graphql-sse` opens a
  // fresh EventSource per subscription (distinct-connection mode) — matches
  // our one-shot `demoProgress` usage and keeps things stateless.
  const sseClient = createSseClient({
    url: `${httpUri}/stream`,
    headers: () => {
      const token = getToken();
      const h: Record<string, string> = {};
      if (token) h.authorization = `Bearer ${token}`;
      return h;
    },
  });
  const sseLink = new ApolloLink(
    (operation) =>
      new Observable((observer) => {
        return sseClient.subscribe(
          {
            operationName: operation.operationName,
            query: print(operation.query),
            variables: operation.variables as Record<string, unknown>,
          },
          {
            next: (data) =>
              observer.next(data as Parameters<typeof observer.next>[0]),
            error: (err) => observer.error(err),
            complete: () => observer.complete(),
          },
        );
      }),
  );

  const isSubscription = (op: { query: { kind: string } }) => {
    const def = getMainDefinition(
      op.query as unknown as Parameters<typeof getMainDefinition>[0],
    );
    return (
      def.kind === Kind.OPERATION_DEFINITION &&
      (def as OperationDefinitionNode).operation === "subscription"
    );
  };

  return new ApolloClient({
    link: ApolloLink.from([
      errorLink,
      authLink,
      ApolloLink.split(isSubscription, sseLink, httpLink),
    ]),
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

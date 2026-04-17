import { ApolloClient, HttpLink, InMemoryCache } from "@apollo/client";

export function createApolloClient() {
  return new ApolloClient({
    link: new HttpLink({
      uri: import.meta.env.VITE_GRAPHQL_URL ?? "http://localhost:4000/graphql",
    }),
    cache: new InMemoryCache(),
  });
}

import { useApolloClient, useSubscription } from "@apollo/client/react";
import { useEffect } from "react";

import { graphql } from "@/graphql";

const InvalidationsDocument = graphql(`
  subscription Invalidations {
    invalidations {
      typename
      id
    }
  }
`);

/**
 * App-root listener for the server's `invalidations` subscription. Each event evicts the matching entity (or every entity of a given `typename` when `id` is null) from the Apollo normalised cache; active queries selecting those entries automatically refetch via Apollo's broadcast. Replaces the per-mutation `refetchQueries` plumbing with a single resolver-driven channel.
 */
export function InvalidationsListener() {
  const client = useApolloClient();
  const { data, error } = useSubscription(InvalidationsDocument);

  useEffect(() => {
    if (error) {
      console.error("invalidations subscription error", error);
    }
  }, [error]);

  useEffect(() => {
    const event = data?.invalidations;
    if (!event) return;
    const cache = client.cache;
    const { typename, id } = event;
    if (id != null) {
      cache.evict({ id: cache.identify({ __typename: typename, id }) });
    } else {
      const entries = cache.extract() as Record<string, unknown>;
      for (const key of Object.keys(entries)) {
        if (key.startsWith(`${typename}:`)) cache.evict({ id: key });
      }
    }
    cache.gc();
  }, [data, client]);

  return null;
}

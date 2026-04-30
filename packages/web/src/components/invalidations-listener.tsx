import { useApolloClient, useSubscription } from "@apollo/client/react";
import { useEffect } from "react";

import { graphql } from "@/graphql";

const InvalidationsDocument = graphql(`
  subscription Invalidations {
    invalidations {
      rootFields
    }
  }
`);

/**
 * App-root listener for the server's `invalidations` subscription. Each event names the `Query` field(s) whose result has gone stale. We evict those fields on a *temporary optimistic cache layer* (`optimistic: true`); Apollo observes which active queries' results that layer affected, refetches them, then discards the layer — so the main cache is never modified and `useSuspenseQuery` doesn't re-suspend on a missing field. The typename → field map is computed on the server from the schema, so the client never carries a copy.
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
    console.log(
      "invalidate",
      [...client.getObservableQueries().values()].map((v) => v.query),
    );
    void client
      .refetchQueries({
        optimistic: true,
        updateCache(cache) {
          // Evict shadow cache to inform refetchQueries whether it needs to refetch each active query
          for (const fieldName of event.rootFields) {
            cache.evict({ id: "ROOT_QUERY", fieldName });
          }
        },
      })
      .finally(() => {
        // Evict actual cache for queries which are not currently mounted but have cache
        for (const fieldName of event.rootFields) {
          client.cache.evict({ id: "ROOT_QUERY", fieldName });
        }
      });
  }, [data, client]);

  return null;
}

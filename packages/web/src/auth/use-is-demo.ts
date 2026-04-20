import { useQuery } from "@apollo/client/react";

import { MeDocument } from "./documents";

/** `true` when the current session is a demo. Reads from Apollo's cache (populated by the `AuthGate` query at app boot), so usage is a cheap cache lookup — no extra network request. */
export function useIsDemo(): boolean {
  const { data } = useQuery(MeDocument, { fetchPolicy: "cache-first" });
  return data?.me?.isDemo ?? false;
}

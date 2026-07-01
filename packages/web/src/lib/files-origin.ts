/** Origin of the backend that serves files and other non-GraphQL endpoints (CSV export, uploaded PDFs), derived from the configured GraphQL URL. */
export const filesOrigin = new URL(
  import.meta.env.VITE_GRAPHQL_URL ?? "http://localhost:4000/graphql",
  window.location.origin,
).origin;

/** Resolve a possibly-relative file URL returned by the API to an absolute URL on the files origin. */
export function resolveFileUrl(fileUrl: string): string {
  return /^https?:\/\//.test(fileUrl) ? fileUrl : `${filesOrigin}${fileUrl}`;
}

/** An object representing a test response from the GraphQL server @gqlType */
export type Pong = {
  /** Set whenever the GraphQL server is working properly @gqlField */
  pong: string;
};

/**
 * Call this to check that the GraphQL server is working properly
 *
 * @gqlQueryField
 * @gqlAnnotate semanticNonNull
 */
export function ping(): Pong | null {
  return { pong: "pong" };
}

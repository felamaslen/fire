/**
 * Placeholder payload for mutations that have nothing meaningful to return (e.g. delete).
 * Clients should select `_` (or nothing) and discard the result.
 * @gqlType
 */
export type Void = {
  /**
   * Exists only because GraphQL forbids empty object types. Always null — ignore it.
   * @gqlField
   */
  _?: boolean | null;
};

export const VOID: Void = {};

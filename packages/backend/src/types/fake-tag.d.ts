declare module "fake-tag" {
  /** Identity template tag — returns the interpolated string unchanged. Used to mark template literals (e.g. SDL, SQL) for editor syntax highlighting without pulling in a real parser. */
  const gql: (strings: TemplateStringsArray, ...values: unknown[]) => string;
  export default gql;
}

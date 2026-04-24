export const isNonNullish = <T>(
  t: T | null | undefined,
): t is Exclude<T, null | undefined> => t != null;

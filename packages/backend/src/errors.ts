/** Thrown from an otherwise-unreachable `default` case in an exhaustive switch, forcing a TS compile error if a new discriminant is ever added. */
export class UnreachableCaseError extends Error {
  constructor(value: never) {
    super(`Unreachable case: ${value}`);
  }
}

/** Useful when processing results of data loaders, which are typed as `T | Error` */
export function assertNotError<T>(
  t: T | Error,
): asserts t is Exclude<T, Error> {
  assert(!(t instanceof Error), (t as Error).message);
}

/** Useful for asserting an entire result set from a data loader contains no errors */
export function assertNoErrors<T>(
  t: (T | Error)[],
): asserts t is Exclude<T, Error>[] {
  for (const s of t) assertNotError(s);
}

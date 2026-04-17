/** Thrown from an otherwise-unreachable `default` case in an exhaustive switch, forcing a TS compile error if a new discriminant is ever added. */
export class UnreachableCaseError extends Error {
  constructor(value: never) {
    super(`Unreachable case: ${value}`);
  }
}

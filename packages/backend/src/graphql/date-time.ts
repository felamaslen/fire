import { strict as assert } from "node:assert";

import type { GqlScalar } from "grats";

/** ISO-8601 date-time. Serialises as an ISO-8601 string over the wire. @gqlScalar */
export type DateTime = Date;

export const dateTimeScalar: GqlScalar<DateTime> = {
  serialize(value): string {
    assert(value instanceof Date, "DateTime must be a Date");
    return value.toISOString();
  },
  parseValue(value): DateTime {
    assert(typeof value === "string", "DateTime must be a string");
    return new Date(value);
  },
  parseLiteral(ast): DateTime {
    assert(
      ast.kind === "StringValue",
      "DateTime must be a StringValue literal",
    );
    return new Date(ast.value);
  },
};

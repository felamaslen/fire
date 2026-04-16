import { strict as assert } from "node:assert";

import type { GqlScalar } from "grats";

/** ISO-8601 calendar date (YYYY-MM-DD). No time-of-day component. @gqlScalar */
export type Date = globalThis.Date;

export const dateScalar: GqlScalar<Date> = {
  serialize(value): string {
    assert(value instanceof globalThis.Date, "Date must be a Date");
    return value.toISOString().slice(0, 10);
  },
  parseValue(value): Date {
    assert(
      typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value),
      "Date must be a YYYY-MM-DD string",
    );
    return new globalThis.Date(`${value}T00:00:00Z`);
  },
  parseLiteral(ast): Date {
    assert(ast.kind === "StringValue", "Date must be a StringValue literal");
    assert(
      /^\d{4}-\d{2}-\d{2}$/.test(ast.value),
      "Date must be a YYYY-MM-DD string",
    );
    return new globalThis.Date(`${ast.value}T00:00:00Z`);
  },
};

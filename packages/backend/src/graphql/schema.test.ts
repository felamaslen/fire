import { isNonNullType } from "graphql";

import { getSchema } from "@/__generated__/schema";
import { scalars } from "@/index";

const schema = getSchema({ scalars });

it("every Query root field returns a nullable type", () => {
  const query = schema.getQueryType();
  expect(query).toBeDefined();
  const violations: string[] = [];
  for (const [name, field] of Object.entries(query!.getFields())) {
    if (name.startsWith("__")) continue;
    if (isNonNullType(field.type)) {
      violations.push(`Query.${name}: ${field.type.toString()}`);
    }
  }
  expect(violations).toEqual([]);
});

it("every Mutation root field returns a non-null type", () => {
  const mutation = schema.getMutationType();
  if (!mutation) return;
  const violations: string[] = [];
  for (const [name, field] of Object.entries(mutation.getFields())) {
    if (!isNonNullType(field.type)) {
      violations.push(`Mutation.${name}: ${field.type.toString()}`);
    }
  }
  expect(violations).toEqual([]);
});

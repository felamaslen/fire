import { ApolloServer } from "@apollo/server";
import { makeExecutableSchema } from "@graphql-tools/schema";
import gql from "fake-tag";
import {
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
} from "graphql";

import { constraintPlugin } from "./constraint";

const typeDefs = gql`
  directive @constraint(
    pattern: String
    min: Int
    max: Int
  ) on ARGUMENT_DEFINITION | INPUT_FIELD_DEFINITION

  input ContactInput {
    email: String! @constraint(pattern: "^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+$")
    tags: [String!] @constraint(pattern: "^#[a-z]+$")
    age: Int @constraint(min: 0, max: 150)
  }

  type Query {
    hello(name: String! @constraint(pattern: "^[A-Za-z]+$")): String!
    greet(greeting: String @constraint(pattern: "^hello")): String!
    register(contact: ContactInput!): String!
    untouched(n: Int): Int
    paginate(limit: Int! @constraint(min: 5, max: 20)): Int!
  }
`;

const resolvers = {
  Query: {
    hello: (_: unknown, args: { name: string }) => `hi ${args.name}`,
    greet: (_: unknown, args: { greeting?: string }) =>
      args.greeting ?? "(none)",
    register: (_: unknown, args: { contact: { email: string } }) =>
      `registered ${args.contact.email}`,
    untouched: (_: unknown, args: { n?: number }) => args.n ?? 0,
    paginate: (_: unknown, args: { limit: number }) => args.limit,
  },
};

const schema = makeExecutableSchema({ typeDefs, resolvers });
const server = new ApolloServer({
  schema,
  plugins: [constraintPlugin(schema)],
});

async function run(
  query: string,
  variables?: Record<string, unknown>,
): Promise<{
  data?: unknown;
  errors?: ReadonlyArray<{
    message: string;
    extensions?: Record<string, unknown>;
  }>;
}> {
  const res = await server.executeOperation({ query, variables });
  if (res.body.kind !== "single") throw new Error("expected single response");
  return res.body.singleResult;
}

beforeAll(async () => {
  await server.start();
});

afterAll(async () => {
  await server.stop();
});

it("passes through a value matching the pattern (inline literal)", async () => {
  const result = await run(`{ hello(name: "Alice") }`);
  expect(result.errors).toBeUndefined();
  expect(result.data).toEqual({ hello: "hi Alice" });
});

it("passes through a value matching the pattern (variable)", async () => {
  const result = await run(`query ($n: String!) { hello(name: $n) }`, {
    n: "Bob",
  });
  expect(result.errors).toBeUndefined();
  expect(result.data).toEqual({ hello: "hi Bob" });
});

it("rejects a non-matching literal with BAD_USER_INPUT", async () => {
  const result = await run(`{ hello(name: "bad-1") }`);
  expect(result.data).toBeUndefined();
  expect(result.errors?.[0].message).toMatchInlineSnapshot(
    `"Argument "name" on field "hello" does not match pattern /^[A-Za-z]+$/"`,
  );
  expect(result.errors?.[0].extensions?.code).toBe("BAD_USER_INPUT");
});

it("rejects a non-matching value passed via variable", async () => {
  const result = await run(`query ($n: String!) { hello(name: $n) }`, {
    n: "bad-1",
  });
  expect(result.errors?.[0].message).toMatchInlineSnapshot(
    `"Argument "name" on field "hello" does not match pattern /^[A-Za-z]+$/"`,
  );
  expect(result.errors?.[0].extensions?.code).toBe("BAD_USER_INPUT");
});

it("skips validation when the argument is omitted (nullable)", async () => {
  const result = await run(`{ greet }`);
  expect(result.errors).toBeUndefined();
  expect(result.data).toEqual({ greet: "(none)" });
});

it("rejects a non-matching value on a nullable arg when provided", async () => {
  const result = await run(`{ greet(greeting: "hi there") }`);
  expect(result.errors?.[0].message).toMatchInlineSnapshot(
    `"Argument "greeting" on field "greet" does not match pattern /^hello/"`,
  );
});

it("ignores arguments without the constraint directive", async () => {
  const result = await run(`{ untouched(n: 5) }`);
  expect(result.errors).toBeUndefined();
  expect(result.data).toEqual({ untouched: 5 });
});

it("rejects a non-matching input-object field", async () => {
  const result = await run(
    `{ register(contact: { email: "not-an-email", tags: [] }) }`,
  );
  expect(result.errors?.[0].message).toMatchInlineSnapshot(
    `"Input field "register.contact.email" does not match pattern /^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+$/"`,
  );
  expect(result.errors?.[0].extensions?.code).toBe("BAD_USER_INPUT");
});

it("rejects a non-matching entry inside a list-typed input field", async () => {
  const result = await run(
    `{ register(contact: { email: "a@b", tags: ["#ok", "bad tag"] }) }`,
  );
  expect(result.errors?.[0].message).toMatchInlineSnapshot(
    `"Input field "register.contact.tags.[1]" does not match pattern /^#[a-z]+$/"`,
  );
});

it("passes a well-formed input object", async () => {
  const result = await run(
    `{ register(contact: { email: "a@b", tags: ["#ok", "#fine"] }) }`,
  );
  expect(result.errors).toBeUndefined();
  expect(result.data).toEqual({ register: "registered a@b" });
});

describe("numeric bounds (min/max)", () => {
  it("rejects a scalar Int below the min", async () => {
    const result = await run(`{ paginate(limit: 2) }`);
    expect(result.errors?.[0].message).toMatchInlineSnapshot(
      `"Argument "limit" on field "paginate" is below minimum 5"`,
    );
    expect(result.errors?.[0].extensions?.code).toBe("BAD_USER_INPUT");
  });

  it("rejects a scalar Int above the max", async () => {
    const result = await run(`{ paginate(limit: 21) }`);
    expect(result.errors?.[0].message).toMatchInlineSnapshot(
      `"Argument "limit" on field "paginate" is above maximum 20"`,
    );
  });

  it("accepts values at the inclusive boundaries", async () => {
    const lo = await run(`{ paginate(limit: 5) }`);
    const hi = await run(`{ paginate(limit: 20) }`);
    expect(lo.errors).toBeUndefined();
    expect(hi.errors).toBeUndefined();
  });

  it("rejects an input-object field outside the bounds", async () => {
    const result = await run(
      `{ register(contact: { email: "a@b", age: 200 }) }`,
    );
    expect(result.errors?.[0].message).toMatchInlineSnapshot(
      `"Input field "register.contact.age" is above maximum 150"`,
    );
  });

  it("lets well-formed numeric input through", async () => {
    const result = await run(
      `{ register(contact: { email: "a@b", age: 42 }) }`,
    );
    expect(result.errors).toBeUndefined();
  });
});

/**
 * Schemas built programmatically (e.g. by grats) don't carry directive AST nodes;
 * they surface them via `extensions.grats.directives`. The plugin has to honour
 * both shapes, so we cover the extensions path with a hand-built schema.
 */
describe("extensions.grats.directives", () => {
  function extSchema(): GraphQLSchema {
    const ProductInput = new GraphQLInputObjectType({
      name: "ProductInput",
      fields: {
        sku: {
          type: new GraphQLNonNull(GraphQLString),
          extensions: {
            grats: {
              directives: [
                { name: "constraint", args: { pattern: "^[A-Z]{3}-\\d+$" } },
              ],
            },
          },
        },
      },
    });
    return new GraphQLSchema({
      query: new GraphQLObjectType({
        name: "Query",
        fields: {
          lookup: {
            type: new GraphQLNonNull(GraphQLString),
            args: {
              code: {
                type: new GraphQLNonNull(GraphQLString),
                extensions: {
                  grats: {
                    directives: [
                      { name: "constraint", args: { pattern: "^\\d{4}$" } },
                    ],
                  },
                },
              },
            },
            resolve: (_: unknown, args: { code: string }) => `ok:${args.code}`,
          },
          codes: {
            type: new GraphQLNonNull(GraphQLString),
            args: {
              codes: {
                type: new GraphQLList(new GraphQLNonNull(GraphQLString)),
                extensions: {
                  grats: {
                    directives: [
                      { name: "constraint", args: { pattern: "^\\d{4}$" } },
                    ],
                  },
                },
              },
            },
            resolve: () => "ok",
          },
          submit: {
            type: new GraphQLNonNull(GraphQLString),
            args: {
              product: { type: new GraphQLNonNull(ProductInput) },
            },
            resolve: () => "ok",
          },
          paginate: {
            type: new GraphQLNonNull(GraphQLInt),
            args: {
              limit: {
                type: new GraphQLNonNull(GraphQLInt),
                extensions: {
                  grats: {
                    directives: [
                      { name: "constraint", args: { min: 5, max: 20 } },
                    ],
                  },
                },
              },
            },
            resolve: (_: unknown, args: { limit: number }) => args.limit,
          },
        },
      }),
    });
  }

  async function runExt(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<{
    data?: unknown;
    errors?: ReadonlyArray<{
      message: string;
      extensions?: Record<string, unknown>;
    }>;
  }> {
    const schema = extSchema();
    const s = new ApolloServer({
      schema,
      plugins: [constraintPlugin(schema)],
    });
    await s.start();
    try {
      const res = await s.executeOperation({ query, variables });
      if (res.body.kind !== "single")
        throw new Error("expected single response");
      return res.body.singleResult;
    } finally {
      await s.stop();
    }
  }

  it("honours constraint on a scalar argument surfaced via grats extensions", async () => {
    const result = await runExt(`{ lookup(code: "12ab") }`);
    expect(result.errors?.[0].message).toMatchInlineSnapshot(
      `"Argument "code" on field "lookup" does not match pattern /^\\d{4}$/"`,
    );
    expect(result.errors?.[0].extensions?.code).toBe("BAD_USER_INPUT");
  });

  it("honours constraint on a list argument surfaced via grats extensions", async () => {
    const result = await runExt(`{ codes(codes: ["1234", "xyz"]) }`);
    expect(result.errors?.[0].message).toMatchInlineSnapshot(
      `"Argument "codes" on field "codes" at [1] does not match pattern /^\\d{4}$/"`,
    );
  });

  it("honours constraint on an input-object field surfaced via grats extensions", async () => {
    const result = await runExt(`{ submit(product: { sku: "abc" }) }`);
    expect(result.errors?.[0].message).toMatchInlineSnapshot(
      `"Input field "submit.product.sku" does not match pattern /^[A-Z]{3}-\\d+$/"`,
    );
  });

  it("lets well-formed values through the grats-extensions path", async () => {
    const result = await runExt(
      `{ lookup(code: "1234") codes(codes: ["1234", "5678"]) submit(product: { sku: "ABC-42" }) }`,
    );
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      lookup: "ok:1234",
      codes: "ok",
      submit: "ok",
    });
  });

  it("honours numeric min/max surfaced via grats extensions", async () => {
    const low = await runExt(`{ paginate(limit: 2) }`);
    expect(low.errors?.[0].message).toMatchInlineSnapshot(
      `"Argument "limit" on field "paginate" is below minimum 5"`,
    );
    const high = await runExt(`{ paginate(limit: 999) }`);
    expect(high.errors?.[0].message).toMatchInlineSnapshot(
      `"Argument "limit" on field "paginate" is above maximum 20"`,
    );
    const ok = await runExt(`{ paginate(limit: 10) }`);
    expect(ok.errors).toBeUndefined();
  });
});

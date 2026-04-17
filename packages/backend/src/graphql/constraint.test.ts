import { ApolloServer } from "@apollo/server";
import { makeExecutableSchema } from "@graphql-tools/schema";
import gql from "fake-tag";

import { constraintPlugin } from "./constraint";

const typeDefs = gql`
  directive @constraint(
    pattern: String!
  ) on ARGUMENT_DEFINITION | INPUT_FIELD_DEFINITION

  input ContactInput {
    email: String! @constraint(pattern: "^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+$")
    tags: [String!] @constraint(pattern: "^#[a-z]+$")
  }

  type Query {
    hello(name: String! @constraint(pattern: "^[A-Za-z]+$")): String!
    greet(greeting: String @constraint(pattern: "^hello")): String!
    register(contact: ContactInput!): String!
    untouched(n: Int): Int
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

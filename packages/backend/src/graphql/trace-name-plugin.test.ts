import { AsyncLocalStorage } from "node:async_hooks";

import { ApolloServer } from "@apollo/server";
import { fastifyApolloHandler } from "@as-integrations/fastify";
import { makeExecutableSchema } from "@graphql-tools/schema";
import {
  type Context as OtelContextValue,
  context as otelContext,
  type ContextManager,
  ROOT_CONTEXT,
  type Span,
  trace,
} from "@opentelemetry/api";
import { RPCType, setRPCMetadata } from "@opentelemetry/core";
import gql from "fake-tag";
import Fastify, { type FastifyPluginAsync } from "fastify";

import { traceNamePlugin } from "./trace-name-plugin";

// `@opentelemetry/api`'s `context.with` is a no-op until a `ContextManager` is
// registered (the SDK normally does this from `otel.mjs`, which we don't load
// in tests). A minimal `AsyncLocalStorage`-backed manager is enough to make
// the plugin observe the context we set up around `inject`.
class ALSContextManager implements ContextManager {
  private readonly als = new AsyncLocalStorage<OtelContextValue>();
  active(): OtelContextValue {
    return this.als.getStore() ?? ROOT_CONTEXT;
  }
  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    ctx: OtelContextValue,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    return this.als.run(ctx, () => Reflect.apply(fn, thisArg, args));
  }
  bind<T>(_ctx: OtelContextValue, target: T): T {
    return target;
  }
  enable(): this {
    return this;
  }
  disable(): this {
    this.als.disable();
    return this;
  }
}

const typeDefs = gql`
  type Query {
    hello: String!
    world: String!
  }
  type Mutation {
    poke: String!
  }
`;

const resolvers = {
  Query: { hello: () => "hi", world: () => "earth" },
  Mutation: { poke: () => "ok" },
};

const schema = makeExecutableSchema({ typeDefs, resolvers });
const apollo = new ApolloServer<object>({
  schema,
  plugins: [traceNamePlugin()],
});

const graphqlRoute: FastifyPluginAsync = async (app) => {
  app.route({
    method: ["GET", "POST"],
    url: "/graphql",
    handler: fastifyApolloHandler(apollo, { context: async () => ({}) }),
  });
};

const router = Fastify();

beforeAll(async () => {
  otelContext.setGlobalContextManager(new ALSContextManager());
  await apollo.start();
  await router.register(graphqlRoute);
  await router.ready();
});

afterAll(async () => {
  await router.close();
  await apollo.stop();
  otelContext.disable();
});

function fakeSpan(): Span & { updateName: ReturnType<typeof vi.fn> } {
  return {
    updateName: vi.fn().mockReturnThis(),
    setAttribute: vi.fn(),
    setAttributes: vi.fn(),
    addEvent: vi.fn(),
    addLink: vi.fn(),
    addLinks: vi.fn(),
    setStatus: vi.fn(),
    end: vi.fn(),
    isRecording: () => true,
    recordException: vi.fn(),
    spanContext: () => ({ traceId: "0", spanId: "0", traceFlags: 0 }),
  } as unknown as Span & { updateName: ReturnType<typeof vi.fn> };
}

async function runQuery(query: string): Promise<{
  active: ReturnType<typeof fakeSpan>;
  rpc: ReturnType<typeof fakeSpan>;
}> {
  const active = fakeSpan();
  const rpc = fakeSpan();
  const ctx = setRPCMetadata(trace.setSpan(ROOT_CONTEXT, active), {
    type: RPCType.HTTP,
    span: rpc,
  });
  await otelContext.with(ctx, async () => {
    const res = await router.inject({
      method: "POST",
      url: "/graphql",
      payload: { query },
      headers: { "content-type": "application/json" },
    });
    const body = JSON.parse(res.body) as {
      data?: unknown;
      errors?: Array<{ message: string }>;
    };
    if (body.errors) {
      throw new Error(`unexpected errors: ${JSON.stringify(body.errors)}`);
    }
  });
  return { active, rpc };
}

it("renames the active span and the http server span using the operation name", async () => {
  const { active, rpc } = await runQuery(`query NetWorthCategories { hello }`);
  expect(active.updateName).toHaveBeenCalledWith("query NetWorthCategories");
  expect(rpc.updateName).toHaveBeenCalledWith("query NetWorthCategories");
});

it("prefixes mutations with `mutation`", async () => {
  const { active, rpc } = await runQuery(`mutation PokeIt { poke }`);
  expect(active.updateName).toHaveBeenCalledWith("mutation PokeIt");
  expect(rpc.updateName).toHaveBeenCalledWith("mutation PokeIt");
});

it("falls back to the first selected field for anonymous operations", async () => {
  const { active, rpc } = await runQuery(`{ hello world }`);
  expect(active.updateName).toHaveBeenCalledWith("query hello");
  expect(rpc.updateName).toHaveBeenCalledWith("query hello");
});

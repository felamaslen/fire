import { makeExecutableSchema } from "@graphql-tools/schema";
import {
  type Span,
  type SpanOptions,
  type SpanStatus,
  SpanStatusCode,
  trace,
  type Tracer,
  type TracerProvider,
} from "@opentelemetry/api";
import gql from "fake-tag";
import { graphql } from "graphql";

import { wrapResolversWithSpans } from "./field-spans";

type RecordedSpan = {
  name: string;
  startTime: SpanOptions["startTime"];
  endedAt?: number;
  status?: SpanStatus;
  exceptions: Array<unknown>;
};

const recorded: RecordedSpan[] = [];

function makeRecordingSpan(
  name: string,
  options?: SpanOptions,
): Span & { entry: RecordedSpan } {
  const entry: RecordedSpan = {
    name,
    startTime: options?.startTime,
    exceptions: [],
  };
  recorded.push(entry);
  const span = {
    entry,
    end: vi.fn(() => {
      entry.endedAt = Date.now();
    }),
    setStatus: vi.fn((s: SpanStatus) => {
      entry.status = s;
      return span;
    }),
    recordException: vi.fn((err: unknown) => {
      entry.exceptions.push(err);
    }),
    setAttribute: vi.fn(() => span),
    setAttributes: vi.fn(() => span),
    addEvent: vi.fn(() => span),
    addLink: vi.fn(() => span),
    addLinks: vi.fn(() => span),
    isRecording: () => true,
    spanContext: () => ({ traceId: "0", spanId: "0", traceFlags: 0 }),
    updateName: vi.fn(() => span),
  } as unknown as Span & { entry: RecordedSpan };
  return span;
}

const tracer: Tracer = {
  startSpan: (name, options) => makeRecordingSpan(name, options),
  startActiveSpan: ((..._args: unknown[]) => {
    throw new Error("not used");
  }) as Tracer["startActiveSpan"],
};

const provider: TracerProvider = { getTracer: () => tracer };

beforeAll(() => {
  trace.setGlobalTracerProvider(provider);
});

afterAll(() => {
  trace.disable();
});

beforeEach(() => {
  recorded.length = 0;
});

function buildSchema(): ReturnType<typeof makeExecutableSchema> {
  const typeDefs = gql`
    type Query {
      asyncOk: String!
      asyncFail: String!
      syncValue: String!
      defaultField: String!
    }
  `;
  const resolvers = {
    Query: {
      asyncOk: async () => {
        await new Promise((r) => setTimeout(r, 1));
        return "ok";
      },
      asyncFail: async () => {
        await new Promise((r) => setTimeout(r, 1));
        throw new Error("boom");
      },
      syncValue: () => "sync",
      // `defaultField` has no explicit resolver — graphql-js falls back to the
      // default property accessor, which we should not wrap.
    },
  };
  const schema = makeExecutableSchema({ typeDefs, resolvers });
  return wrapResolversWithSpans(schema);
}

it("creates a span for an async resolver and ends it on success", async () => {
  const schema = buildSchema();
  const result = await graphql({ schema, source: `{ asyncOk }` });
  expect(result.errors).toBeUndefined();
  expect(result.data).toEqual({ asyncOk: "ok" });
  expect(recorded.map((s) => s.name)).toEqual(["Query.asyncOk"]);
  const [span] = recorded;
  expect(span.endedAt).toBeDefined();
  expect(span.status).toBeUndefined();
  expect(span.startTime).toBeInstanceOf(Date);
});

it("records the error and sets ERROR status when an async resolver throws", async () => {
  const schema = buildSchema();
  const result = await graphql({ schema, source: `{ asyncFail }` });
  expect(result.errors?.[0].message).toBe("boom");
  expect(recorded.map((s) => s.name)).toEqual(["Query.asyncFail"]);
  const [span] = recorded;
  expect(span.endedAt).toBeDefined();
  expect(span.status?.code).toBe(SpanStatusCode.ERROR);
  expect(span.status?.message).toBe("boom");
  expect(span.exceptions).toHaveLength(1);
  expect((span.exceptions[0] as Error).message).toBe("boom");
});

it("does not create a span for a synchronous resolver", async () => {
  const schema = buildSchema();
  const result = await graphql({ schema, source: `{ syncValue }` });
  expect(result.errors).toBeUndefined();
  expect(result.data).toEqual({ syncValue: "sync" });
  expect(recorded).toEqual([]);
});

it("does not wrap fields without a custom resolver", async () => {
  const schema = buildSchema();
  // `defaultField` has no resolver in the resolvers map → graphql-js uses the
  // default field resolver, which the wrapper leaves alone. Querying it on a
  // root with no `defaultField` property yields `null`, and crucially: no span.
  await graphql({ schema, source: `{ defaultField }` });
  expect(recorded).toEqual([]);
});

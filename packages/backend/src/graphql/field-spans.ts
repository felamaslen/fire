import {
  context as otelContext,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import type { GraphQLFieldResolver, GraphQLSchema } from "graphql";

const tracer = trace.getTracer("graphql-fields");

/**
 * Mutate `schema` so every top-level operation field (`Query.*`, `Mutation.*`, `Subscription.*`) with a custom resolver is wrapped in an OTel span — but only when the resolver actually returns a `Promise`. Synchronous resolvers add no useful timing information and would just clutter the trace, so we call the original first and skip span creation when the return value isn't thenable. Spans use the original return time as their start, so detection cost doesn't bleed into the recorded duration. Nested object-type resolvers are deliberately not wrapped: per-row field spans would dominate trace volume without giving more useful breakdowns than the per-operation span already provides.
 */
export function wrapResolversWithSpans(schema: GraphQLSchema): GraphQLSchema {
  const roots = [
    schema.getQueryType(),
    schema.getMutationType(),
    schema.getSubscriptionType(),
  ];
  for (const type of roots) {
    if (!type) continue;
    const typeName = type.name;
    for (const field of Object.values(type.getFields())) {
      const original = field.resolve;
      if (!original) continue;
      field.resolve = makeWrapped(original, typeName, field.name);
    }
  }
  return schema;
}

function makeWrapped<TSource, TArgs>(
  original: GraphQLFieldResolver<TSource, unknown, TArgs>,
  typeName: string,
  fieldName: string,
): GraphQLFieldResolver<TSource, unknown, TArgs> {
  const spanName = `${typeName}.${fieldName}`;
  return function wrapped(source, args, context, info) {
    const startTime = new Date();
    const result = original(source, args, context, info);
    if (!isPromiseLike(result)) return result;
    const span = tracer.startSpan(
      spanName,
      { startTime },
      otelContext.active(),
    );
    return Promise.resolve(result).then(
      (value) => {
        span.end();
        return value;
      },
      (err: unknown) => {
        if (err instanceof Error) span.recordException(err);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        span.end();
        throw err;
      },
    );
  };
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value != null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

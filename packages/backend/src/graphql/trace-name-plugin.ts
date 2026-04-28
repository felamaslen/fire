import type { ApolloServerPlugin, BaseContext } from "@apollo/server";
import { context as otelContext, type Span, trace } from "@opentelemetry/api";
import { getRPCMetadata } from "@opentelemetry/core";
import { Kind, type OperationDefinitionNode } from "graphql";

type Options<TContext extends BaseContext> = {
  /** Returns the trace-root span the plugin should rename. Required when neither `getRPCMetadata(...)` nor `trace.getActiveSpan()` returns the request's parent span at `didResolveOperation` time — e.g. with `@fastify/otel`, the active span at that point is a child `handler - …` hook span, not the `request` span. The caller is responsible for capturing the parent span at `onRequest` time and passing it through the GraphQL context. */
  getRequestSpan?: (contextValue: TContext) => Span | undefined;
};

/** Rename the trace root from the generic `POST /graphql` to `{operationType} {operationName}` (e.g. `query NetWorthCategories`) once Apollo has parsed the document, and apply the same rename to the active span (so the deepest fastify hook span lines up with what the trace root says). Falls back to the first selected field name for anonymous operations. */
export function traceNamePlugin<TContext extends BaseContext = BaseContext>(
  options: Options<TContext> = {},
): ApolloServerPlugin<TContext> {
  return {
    async requestDidStart() {
      return {
        async didResolveOperation({ operation, operationName, contextValue }) {
          const name = buildSpanName(operation, operationName);
          if (!name) return;
          const ctx = otelContext.active();
          options.getRequestSpan?.(contextValue)?.updateName(name);
          getRPCMetadata(ctx)?.span.updateName(name);
          trace.getActiveSpan()?.updateName(name);
        },
      };
    },
  };
}

function buildSpanName(
  operation: OperationDefinitionNode | null | undefined,
  operationName: string | null | undefined,
): string | undefined {
  if (!operation) return undefined;
  const type = operation.operation;
  if (operationName) return `${type} ${operationName}`;
  const firstField = operation.selectionSet.selections.find(
    (s) => s.kind === Kind.FIELD,
  );
  return firstField ? `${type} ${firstField.name.value}` : type;
}

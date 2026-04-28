import type { ApolloServerPlugin, BaseContext } from "@apollo/server";
import { context as otelContext, trace } from "@opentelemetry/api";
import { getRPCMetadata } from "@opentelemetry/core";
import { Kind, type OperationDefinitionNode } from "graphql";

/** Rename the HTTP server span and the active fastify span from the generic `POST /graphql` to `{operationType} {operationName}` (e.g. `query NetWorthCategories`) once Apollo has parsed the document. Falls back to the first selected field name for anonymous operations. */
export function traceNamePlugin<
  TContext extends BaseContext = BaseContext,
>(): ApolloServerPlugin<TContext> {
  return {
    async requestDidStart() {
      return {
        async didResolveOperation({ operation, operationName }) {
          const name = buildSpanName(operation, operationName);
          if (!name) return;
          const ctx = otelContext.active();
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

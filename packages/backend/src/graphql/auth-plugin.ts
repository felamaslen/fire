import type { ApolloServerPlugin } from "@apollo/server";
import {
  type DocumentNode,
  GraphQLError,
  type GraphQLField,
  type GraphQLSchema,
  Kind,
  type OperationDefinitionNode,
} from "graphql";

import type { Context } from "./context";

/**
 * Mark a root query / mutation field as callable without authentication. Every other root field requires a valid `real` or `demo` token — selecting an auth-required root field on an anonymous request throws `UNAUTHENTICATED` before any resolver runs. Only meaningful on `Query` / `Mutation` fields; nested fields inherit the root's decision.
 *
 * @gqlDirective noAuth on FIELD_DEFINITION
 */
export function noAuthDirective(): void {}

/** Root field names (across `Query` + `Mutation`) callable without a token. */
export type NoAuthFieldSet = Set<string>;

/** Walk the root `Query` and `Mutation` types and collect the names carrying `@noAuth`. */
export function collectNoAuthFields(schema: GraphQLSchema): NoAuthFieldSet {
  const out: NoAuthFieldSet = new Set();
  for (const root of [schema.getQueryType(), schema.getMutationType()]) {
    if (!root) continue;
    for (const [name, field] of Object.entries(root.getFields())) {
      if (hasNoAuth(field)) out.add(name);
    }
  }
  return out;
}

function hasNoAuth(field: GraphQLField<unknown, unknown>): boolean {
  const astDirectives = field.astNode?.directives;
  if (astDirectives?.some((d) => d.name.value === "noAuth")) return true;
  const gratsDirectives = (
    field.extensions as
      | { grats?: { directives?: ReadonlyArray<{ name: string }> } }
      | undefined
  )?.grats?.directives;
  return gratsDirectives?.some((d) => d.name === "noAuth") ?? false;
}

/**
 * Apollo plugin that enforces "auth by default, opt out with `@noAuth` on the root field". Because every selection in a GraphQL operation descends from a root `Query` / `Mutation` field, checking only the top-level selections is sufficient: if the root is auth-gated, everything under it is too. On `didResolveOperation` it inspects each operation's root selections and throws `UNAUTHENTICATED` for any that isn't in `noAuthFields`. Introspection (`__schema`, `__type`, `__typename`) is always allowed.
 */
export function authPlugin(
  _schema: GraphQLSchema,
  noAuthFields: NoAuthFieldSet,
): ApolloServerPlugin<Context> {
  return {
    async requestDidStart() {
      return {
        async didResolveOperation({ contextValue, document }) {
          if (contextValue.session.kind !== "anon") return;
          const violation = findAuthViolation(document, noAuthFields);
          if (violation) {
            throw new GraphQLError(
              `Unauthenticated: ${violation} requires authentication`,
              { extensions: { code: "UNAUTHENTICATED" } },
            );
          }
        },
      };
    },
  };
}

function findAuthViolation(
  document: DocumentNode,
  noAuthFields: NoAuthFieldSet,
): string | null {
  for (const def of document.definitions) {
    if (def.kind !== Kind.OPERATION_DEFINITION) continue;
    const op = def as OperationDefinitionNode;
    for (const sel of op.selectionSet.selections) {
      if (sel.kind !== Kind.FIELD) continue;
      const name = sel.name.value;
      if (name.startsWith("__")) continue;
      if (!noAuthFields.has(name)) return name;
    }
  }
  return null;
}

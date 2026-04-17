import { getDirective, MapperKind, mapSchema } from "@graphql-tools/utils";
import { GraphQLError, type GraphQLSchema } from "graphql";

/**
 * Mark a field as semantically non-null — schema-level nullable (per the Query-field-nullability convention) but the resolver must never actually return null. Returning null throws a `UNEXPECTED_NULL` GraphQLError at resolve time.
 *
 * @gqlDirective semanticNonNull on FIELD_DEFINITION
 */
export function semanticNonNullDirective(): void {}

/** Wrap every `@semanticNonNull`-tagged field's resolver so a null return throws a `UNEXPECTED_NULL` GraphQLError. */
export function applySemanticNonNull(schema: GraphQLSchema): GraphQLSchema {
  return mapSchema(schema, {
    [MapperKind.OBJECT_FIELD]: (fieldConfig, fieldName, typeName) => {
      const applied = getDirective(schema, fieldConfig, "semanticNonNull");
      if (!applied?.length) return fieldConfig;
      const original = fieldConfig.resolve;
      fieldConfig.resolve = async (source, args, context, info) => {
        const result = original
          ? await original(source, args, context, info)
          : (source as Record<string, unknown> | null | undefined)?.[
              info.fieldName
            ];
        if (result == null) {
          throw new GraphQLError(
            `${typeName}.${fieldName} resolved to null but is marked @semanticNonNull`,
            { extensions: { code: "UNEXPECTED_NULL" } },
          );
        }
        return result;
      };
      return fieldConfig;
    },
  });
}

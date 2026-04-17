import type { ApolloServerPlugin, BaseContext } from "@apollo/server";
import {
  type ASTNode,
  type DocumentNode,
  getArgumentValues,
  getNullableType,
  GraphQLError,
  type GraphQLInputType,
  type GraphQLSchema,
  isInputObjectType,
  isListType,
  TypeInfo,
  visit,
  visitWithTypeInfo,
} from "graphql";

/**
 * Enforce a regex on the decorated string value. The provided value must match `pattern` or the request is rejected before resolution. Applies to field arguments and input-object field definitions.
 *
 * @gqlDirective constraint on ARGUMENT_DEFINITION | INPUT_FIELD_DEFINITION
 */
export function constraintDirective(_args: {
  /** ECMAScript-compatible regex source (without delimiters). */
  pattern: string;
}): void {}

/** Apollo Server plugin that enforces `@constraint(pattern: ...)` on argument definitions during `didResolveOperation` — before any resolver runs. Throws a `BAD_USER_INPUT` GraphQLError on the first violation. */
export function constraintPlugin<TContext extends BaseContext = BaseContext>(
  schema: GraphQLSchema,
): ApolloServerPlugin<TContext> {
  return {
    async requestDidStart() {
      return {
        async didResolveOperation({ document, request }) {
          validateConstraints(schema, document, request.variables ?? {});
        },
      };
    },
  };
}

/** Walk an operation against the schema and throw a `BAD_USER_INPUT` GraphQLError on the first `@constraint` violation. No-op if the document is clean. */
function validateConstraints(
  schema: GraphQLSchema,
  document: DocumentNode,
  variables: Record<string, unknown> = {},
): void {
  const typeInfo = new TypeInfo(schema);
  visit(
    document,
    visitWithTypeInfo(typeInfo, {
      Field(node) {
        const fieldDef = typeInfo.getFieldDef();
        if (!fieldDef) return;

        let values: Record<string, unknown>;
        try {
          values = getArgumentValues(fieldDef, node, variables);
        } catch {
          return;
        }

        for (const argDef of fieldDef.args) {
          const argValue = values[argDef.name];
          const basePath = [`${fieldDef.name}.${argDef.name}`];
          const argPattern = constraintPatternOf(argDef);
          if (argPattern != null) {
            applyPattern(
              argValue,
              argPattern,
              basePath,
              node,
              (path, pattern) =>
                `Argument "${argDef.name}" on field "${fieldDef.name}"${
                  path.length > 1 ? ` at ${path.slice(1).join(".")}` : ""
                } does not match pattern /${pattern}/`,
            );
          }
          validateInputValue(argDef.type, argValue, basePath, node);
        }
      },
    }),
  );
}

function validateInputValue(
  type: GraphQLInputType,
  value: unknown,
  path: string[],
  node: ASTNode,
): void {
  if (value == null) return;
  const nullable = getNullableType(type);
  if (isListType(nullable)) {
    if (!Array.isArray(value)) return;
    for (let i = 0; i < value.length; i++) {
      validateInputValue(
        nullable.ofType,
        value[i],
        path.concat(`[${i}]`),
        node,
      );
    }
    return;
  }
  if (!isInputObjectType(nullable)) return;
  if (typeof value !== "object") return;
  const obj = value as Record<string, unknown>;
  for (const [fieldName, fieldDef] of Object.entries(nullable.getFields())) {
    const fieldValue = obj[fieldName];
    if (fieldValue === undefined) continue;
    const fieldPath = path.concat(fieldName);
    const pattern = constraintPatternOf(fieldDef);
    if (pattern != null) {
      applyPattern(
        fieldValue,
        pattern,
        fieldPath,
        node,
        (p, pat) =>
          `Input field "${p.join(".")}" does not match pattern /${pat}/`,
      );
    }
    validateInputValue(fieldDef.type, fieldValue, fieldPath, node);
  }
}

function applyPattern(
  value: unknown,
  pattern: string,
  path: string[],
  node: ASTNode,
  message: (path: string[], pattern: string) => string,
): void {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      applyPattern(value[i], pattern, path.concat(`[${i}]`), node, message);
    }
    return;
  }
  if (typeof value !== "string") return;
  if (new RegExp(pattern).test(value)) return;
  throw new GraphQLError(message(path, pattern), {
    nodes: node,
    extensions: { code: "BAD_USER_INPUT" },
  });
}

function constraintPatternOf(
  def:
    | {
        astNode?: { directives?: readonly unknown[] } | null;
        extensions?: Record<string, unknown>;
      }
    | null
    | undefined,
): string | null {
  // 1) SDL-built schemas carry directives on the AST node.
  const astDirectives = def?.astNode?.directives as
    | ReadonlyArray<{
        name: { value: string };
        arguments?: ReadonlyArray<{
          name: { value: string };
          value: { kind: string; value?: string };
        }>;
      }>
    | undefined;
  const astDirective = astDirectives?.find(
    (d) => d.name.value === "constraint",
  );
  if (astDirective) {
    const arg = astDirective.arguments?.find((a) => a.name.value === "pattern");
    if (arg && arg.value.kind === "StringValue" && arg.value.value != null) {
      return arg.value.value;
    }
  }

  // 2) Grats-built schemas surface directives via `extensions.grats.directives`.
  const gratsDirectives = (
    def?.extensions as
      | {
          grats?: {
            directives?: ReadonlyArray<{
              name: string;
              args?: Record<string, unknown>;
            }>;
          };
        }
      | undefined
  )?.grats?.directives;
  const gratsDirective = gratsDirectives?.find((d) => d.name === "constraint");
  const pattern = gratsDirective?.args?.pattern;
  return typeof pattern === "string" ? pattern : null;
}

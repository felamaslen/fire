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
import type { Int } from "grats";

/**
 * Enforce bounds on the decorated value before any resolver runs. `pattern` matches against strings; `min` and `max` clamp numeric values (inclusive). The constraint fails and the request is rejected if any of the provided bounds is violated. Applies to field arguments and input-object field definitions.
 *
 * @gqlDirective constraint on ARGUMENT_DEFINITION | INPUT_FIELD_DEFINITION
 */
export function constraintDirective(_args: {
  /** ECMAScript-compatible regex source (without delimiters). Applies to string values only. */
  pattern?: string | null;
  /** Inclusive lower bound for integer values. */
  min?: Int | null;
  /** Inclusive upper bound for integer values. */
  max?: Int | null;
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
          const argConstraint = constraintOf(argDef);
          if (argConstraint?.pattern != null) {
            applyPattern(
              argValue,
              argConstraint.pattern,
              basePath,
              node,
              (path, pattern) =>
                `Argument "${argDef.name}" on field "${fieldDef.name}"${
                  path.length > 1 ? ` at ${path.slice(1).join(".")}` : ""
                } does not match pattern /${pattern}/`,
            );
          }
          if (argConstraint?.min != null || argConstraint?.max != null) {
            applyBounds(
              argValue,
              argConstraint.min,
              argConstraint.max,
              basePath,
              node,
              (path, label) =>
                `Argument "${argDef.name}" on field "${fieldDef.name}"${
                  path.length > 1 ? ` at ${path.slice(1).join(".")}` : ""
                } ${label}`,
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
    const constraint = constraintOf(fieldDef);
    if (constraint?.pattern != null) {
      applyPattern(
        fieldValue,
        constraint.pattern,
        fieldPath,
        node,
        (p, pat) =>
          `Input field "${p.join(".")}" does not match pattern /${pat}/`,
      );
    }
    if (constraint?.min != null || constraint?.max != null) {
      applyBounds(
        fieldValue,
        constraint.min,
        constraint.max,
        fieldPath,
        node,
        (p, label) => `Input field "${p.join(".")}" ${label}`,
      );
    }
    validateInputValue(fieldDef.type, fieldValue, fieldPath, node);
  }
}

function applyBounds(
  value: unknown,
  min: number | null | undefined,
  max: number | null | undefined,
  path: string[],
  node: ASTNode,
  message: (path: string[], label: string) => string,
): void {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      applyBounds(value[i], min, max, path.concat(`[${i}]`), node, message);
    }
    return;
  }
  if (typeof value !== "number") return;
  if (min != null && value < min) {
    throw new GraphQLError(message(path, `is below minimum ${min}`), {
      nodes: node,
      extensions: { code: "BAD_USER_INPUT" },
    });
  }
  if (max != null && value > max) {
    throw new GraphQLError(message(path, `is above maximum ${max}`), {
      nodes: node,
      extensions: { code: "BAD_USER_INPUT" },
    });
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

type ConstraintArgs = {
  pattern?: string | null;
  min?: number | null;
  max?: number | null;
};

function constraintOf(
  def:
    | {
        astNode?: { directives?: readonly unknown[] } | null;
        extensions?: Record<string, unknown>;
      }
    | null
    | undefined,
): ConstraintArgs | null {
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
    const out: ConstraintArgs = {};
    for (const arg of astDirective.arguments ?? []) {
      const name = arg.name.value;
      if (name === "pattern" && arg.value.kind === "StringValue") {
        out.pattern = arg.value.value ?? null;
      } else if (
        (name === "min" || name === "max") &&
        (arg.value.kind === "IntValue" || arg.value.kind === "FloatValue") &&
        arg.value.value != null
      ) {
        out[name] = Number(arg.value.value);
      }
    }
    return out;
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
  if (!gratsDirective) return null;
  const args = gratsDirective.args ?? {};
  return {
    pattern: typeof args.pattern === "string" ? args.pattern : null,
    min: typeof args.min === "number" ? args.min : null,
    max: typeof args.max === "number" ? args.max : null,
  };
}

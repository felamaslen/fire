/**
 * Enforce nullability conventions on Grats resolvers:
 *
 * - `@gqlQueryField` must return a nullable type.
 * - `@gqlMutationField` must NOT return a nullable type.
 * - Any field (query, mutation, or `@gqlField`) carrying `@gqlAnnotate semanticNonNull` must return a nullable type — the annotation only attaches a directive; the schema type still has to be nullable, so it wouldn't make sense to put it on a non-null field.
 *
 * Mirrors the runtime assertions in `schema.test.ts`; surfaces them at lint time.
 */

function unwrapPromise(type) {
  if (
    type &&
    type.type === "TSTypeReference" &&
    type.typeName &&
    type.typeName.type === "Identifier" &&
    type.typeName.name === "Promise" &&
    type.typeArguments &&
    type.typeArguments.params &&
    type.typeArguments.params[0]
  ) {
    return type.typeArguments.params[0];
  }
  return type;
}

function isNullableType(type) {
  const inner = unwrapPromise(type);
  if (!inner) return false;
  if (inner.type !== "TSUnionType") return false;
  return inner.types.some((t) => {
    if (t.type === "TSNullKeyword" || t.type === "TSUndefinedKeyword") {
      return true;
    }
    if (t.type === "TSLiteralType" && t.literal && t.literal.value === null) {
      return true;
    }
    return false;
  });
}

function findTag(blockValue, tag) {
  return new RegExp(`@${tag}(?:\\W|$)`).test(blockValue);
}

export const gqlResolverNullabilityRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Grats resolvers: `@gqlQueryField` must return a nullable type; `@gqlMutationField` must return a non-null type; any field with `@gqlAnnotate semanticNonNull` must return a nullable type.",
    },
    messages: {
      queryNullable:
        "Query root field `{{ name }}` must return a nullable type (append `| null` to the return type).",
      mutationNonNull:
        "Mutation root field `{{ name }}` must return a non-null type (remove `| null` / `| undefined` from the return type).",
      semanticNonNullNullable:
        "`{{ name }}` is annotated `@gqlAnnotate semanticNonNull` but returns a non-null type. `semanticNonNull` only attaches a directive to a nullable schema field — drop the annotation, or make the return type nullable.",
    },
    schema: [],
  },
  create(context) {
    const sourceCode = context.sourceCode;

    function check(functionNode, commentTarget, name) {
      const comments = sourceCode.getCommentsBefore(commentTarget);
      const block = comments
        .slice()
        .reverse()
        .find((c) => c.type === "Block");
      if (!block) return;
      const isQuery = findTag(block.value, "gqlQueryField");
      const isMutation = findTag(block.value, "gqlMutationField");
      const isField = findTag(block.value, "gqlField");
      const isSemanticNonNull =
        findTag(block.value, "gqlAnnotate") &&
        /semanticNonNull/.test(block.value);
      if (!isQuery && !isMutation && !isField && !isSemanticNonNull) return;
      const ret =
        functionNode.returnType && functionNode.returnType.typeAnnotation;
      if (!ret) return; // no explicit return type — inference; test suite catches it
      const nullable = isNullableType(ret);
      if (isQuery && !nullable) {
        context.report({
          node: functionNode,
          messageId: "queryNullable",
          data: { name },
        });
      }
      if (isMutation && nullable) {
        context.report({
          node: functionNode,
          messageId: "mutationNonNull",
          data: { name },
        });
      }
      if (isSemanticNonNull && !nullable) {
        context.report({
          node: functionNode,
          messageId: "semanticNonNullNullable",
          data: { name },
        });
      }
    }

    function checkProperty(node, name, typeAnnotationNode) {
      const comments = sourceCode.getCommentsBefore(node);
      const block = comments
        .slice()
        .reverse()
        .find((c) => c.type === "Block");
      if (!block) return;
      const isSemanticNonNull =
        findTag(block.value, "gqlAnnotate") &&
        /semanticNonNull/.test(block.value);
      if (!isSemanticNonNull) return;
      const ret = typeAnnotationNode && typeAnnotationNode.typeAnnotation;
      if (!ret) return;
      if (!isNullableType(ret)) {
        context.report({
          node,
          messageId: "semanticNonNullNullable",
          data: { name },
        });
      }
    }

    return {
      FunctionDeclaration(node) {
        if (node.id) check(node, node, node.id.name);
      },
      ExportNamedDeclaration(node) {
        if (
          node.declaration &&
          node.declaration.type === "FunctionDeclaration" &&
          node.declaration.id
        ) {
          // Comment attaches to the export node, not the inner function.
          check(node.declaration, node, node.declaration.id.name);
        }
      },
      PropertyDefinition(node) {
        const name =
          node.key && node.key.type === "Identifier"
            ? node.key.name
            : "<anonymous>";
        checkProperty(node, name, node.typeAnnotation);
      },
      TSParameterProperty(node) {
        const param = node.parameter;
        const name =
          param && param.type === "Identifier" ? param.name : "<anonymous>";
        const typeAnnotation = param && param.typeAnnotation;
        checkProperty(node, name, typeAnnotation);
      },
    };
  },
};

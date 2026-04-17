# fire

Monorepo for a personal net worth tracker.

## Structure

- `packages/backend` — Fastify + Apollo GraphQL server on top of Postgres 18 (via `docker-compose.yml`). Schema is hand-written under `src/graphql/**` using [Grats](https://grats.capt.dev/) JSDoc tags and generated into `packages/backend/src/__generated__/{schema.ts,schema.graphql}` via `pnpm grats` (both committed). Database schema lives in `src/db/schema/**` (Drizzle ORM) with generated migrations in `src/db/migrations/` (all committed).

## Code style

- **JSDoc line breaks are semantic, not cosmetic.** Inside a JSDoc comment, only insert a hard line break where there's a genuine paragraph boundary (e.g. before a block tag like `@param`, `@returns`, `@gqlField`, or between two distinct ideas that warrant a blank line). Do not wrap prose across multiple lines for display width — let prettier / the editor soft-wrap. A one-sentence or even multi-sentence description goes on a single line.
- **Wrap code-like tokens in docstrings in backticks.** Anything that names a type, field, table, column, function, flag, env var, path, or command — e.g. `NetWorthCategoryAsset.id`, `PlanningMonthBills`, `env.UPLOADS_DIR`, `pnpm codegen` — goes inside backticks in JSDoc / GraphQL descriptions. Prose references to a concept ("the asset", "the bill") stay unquoted; anything a reader could paste into their editor does not.
- **Never add `eslint-disable` / `eslint-disable-next-line` comments to silence a lint error.** If a rule is firing, the first move is to fix the code so the rule passes, or — if the rule doesn't fit this codebase — change the rule in `eslint.config.js`. A disable comment is only ever acceptable for a truly local, unavoidable exception (e.g. generated code interop, a framework-required side-effect import), and when added, it MUST carry an inline comment at the same site explaining *why* the rule is wrong here. "Silence warning" is not a why. Same goes for `@ts-ignore` / `@ts-expect-error`.

### Frontend GraphQL development

- **Parents select the fields they need; they never `readFragment` a child's document.** If a section or page needs a field (e.g. `id` for a React key, `assetType` for grouping) to wire a child into the render tree, that field must be selected on the parent's own query / fragment document, *in addition to* spreading the child's fragment. The parent's prop type is then derived from its own document — typically `Extract<ResultOf<typeof ParentDocument>, { __typename: "…" }>[]` — not `FragmentOf<typeof ChildDocument>[]`. A component only ever calls `readFragment` on a document it owns, and only on the document whose shape matches its prop. This keeps ownership clean: each component selects exactly what it consumes, and cannot silently depend on fields its child happens to have asked for.
- **Use fragment masking for component data props; never shape them explicitly.** A presentational component colocates its own fragment (e.g. `AssetRowDocument = graphql(\`fragment AssetRow on NetWorthCategoryAsset { … }\`)`) and types its data prop as `{ data: FragmentOf<typeof AssetRowDocument> }`, unmasking with `const asset = readFragment(AssetRowDocument, data)` before reading fields. Parent components spread the child's fragment (`...AssetRow`) into their own query / fragment — they do not build an object matching the child's field set by hand. Do not pass resolved objects (`{ asset: AssetCategory }`) down; do not declare prop interfaces that mirror the fragment. This keeps `gql.tada` masking honest: each component reads exactly what it asked for.
- **Derive client GraphQL result/variable types from the document with `gql.tada`; never redeclare them by hand.** Build documents with `graphql(\`…\`)` from `packages/web/src/graphql.ts` (which wraps `initGraphQLTada` against the downloaded schema). Derive the response shape with `ResultOf<typeof SomeDocument>` and variables with `VariablesOf<typeof SomeDocument>` — do not mirror the selection set as a standalone TS `type` / `interface`. Narrow into subtrees with indexed access (`ResultOf<…>['field'][number]['node']`) and `Extract<…>` rather than rewriting shapes. When a selection reaches through a nullable field, wrap with `NonNullable<…>` instead of restating the inner shape. Regenerate introspection via `pnpm codegen` after `pnpm download-schema`.
- **Colocate client GraphQL documents with their consumers.** `gql` documents in `packages/web/**` live in the component / route file that uses them, not in a shared `graphql/` module. A document is only lifted into its own file once it's genuinely reused across multiple components.
- **Name client GraphQL operation documents `{OperationName}Document`.** Every `gql` document in `packages/web/**` that defines a named query or mutation is exported (or declared at module scope) as `{OperationName}Document` — e.g. `query NetWorthCategories { … }` becomes `NetWorthCategoriesDocument`, `mutation NetWorthCategoryCreate { … }` becomes `NetWorthCategoryCreateDocument`. Match the operation's PascalCase name exactly; no `SCREAMING_SNAKE_CASE`, no re-abbreviations.

## Testing

- Vitest runs with `globals: true`. Never import `describe`, `it`, `test`, `expect`, `beforeAll`, `beforeEach`, `afterAll`, `afterEach`, `vi`, etc. from `vitest` — use them as globals. The types come from `"vitest/globals"` in `tsconfig.json`.
- **All GraphQL error-message assertions use inline snapshots.** When a test expects a GraphQL operation to fail, capture the thrown / returned error message with `toThrowErrorMatchingInlineSnapshot` (for `await expect(...).rejects.…`) or `toMatchInlineSnapshot` (for error strings pulled out of a response body). Regex `toMatch(/.../)` is not enough — the exact wording is part of the test's contract and changes to it should surface as snapshot diffs, not silent passes.

## Skills to use proactively

- **`commit`** (`.claude/skills/commit/SKILL.md`) — conventional commit format (`feat(scope): …`, `fix(scope): …`, etc.). Use on every commit.
- **`graphql-schema`** (`.claude/skills/graphql-schema/SKILL.md`) — use when adding or editing anything under `packages/backend/src/graphql/**`.
- **`graphql-testing`** (`.claude/skills/graphql-testing/SKILL.md`) — use when adding or editing any `*.test.ts` that exercises the GraphQL API.
- **`db-schema`** (`.claude/skills/db-schema/SKILL.md`) — use when adding or editing anything under `packages/backend/src/db/schema/**` or generating a new Drizzle migration.

# fire

Monorepo for a personal net worth tracker.

## Structure

- `packages/backend` — Fastify + Apollo GraphQL server on top of Postgres 18 (via `docker-compose.yml`). Schema is hand-written under `src/graphql/**` using [Grats](https://grats.capt.dev/) JSDoc tags and generated into `packages/backend/src/__generated__/{schema.ts,schema.graphql}` via `pnpm grats` (both committed). Database schema lives in `src/db/schema/**` (Drizzle ORM) with generated migrations in `src/db/migrations/` (all committed).

## Code style

- **JSDoc line breaks are semantic, not cosmetic.** Inside a JSDoc comment, only insert a hard line break where there's a genuine paragraph boundary (e.g. before a block tag like `@param`, `@returns`, `@gqlField`, or between two distinct ideas that warrant a blank line). Do not wrap prose across multiple lines for display width — let prettier / the editor soft-wrap. A one-sentence or even multi-sentence description goes on a single line.

## Testing

- Vitest runs with `globals: true`. Never import `describe`, `it`, `test`, `expect`, `beforeAll`, `beforeEach`, `afterAll`, `afterEach`, `vi`, etc. from `vitest` — use them as globals. The types come from `"vitest/globals"` in `tsconfig.json`.

## Skills to use proactively

- **`commit`** (`.claude/skills/commit/SKILL.md`) — conventional commit format (`feat(scope): …`, `fix(scope): …`, etc.). Use on every commit.
- **`graphql-schema`** (`.claude/skills/graphql-schema/SKILL.md`) — use when adding or editing anything under `packages/backend/src/graphql/**`.
- **`graphql-testing`** (`.claude/skills/graphql-testing/SKILL.md`) — use when adding or editing any `*.test.ts` that exercises the GraphQL API.
- **`db-schema`** (`.claude/skills/db-schema/SKILL.md`) — use when adding or editing anything under `packages/backend/src/db/schema/**` or generating a new Drizzle migration.

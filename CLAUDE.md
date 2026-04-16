# fire

Monorepo for a personal net worth tracker.

## Structure

- `packages/backend` — Fastify + Apollo GraphQL server on top of Postgres 18 (via `docker-compose.yml`). Schema is hand-written under `src/graphql/**` using [Grats](https://grats.capt.dev/) JSDoc tags and generated into `packages/backend/src/__generated__/{schema.ts,schema.graphql}` via `pnpm grats` (both committed). Database schema lives in `src/db/schema/**` (Drizzle ORM) with generated migrations in `src/db/migrations/` (all committed).

## Skills to use proactively

- **`commit`** (`.claude/skills/commit/SKILL.md`) — conventional commit format (`feat(scope): …`, `fix(scope): …`, etc.). Use on every commit.
- **`graphql-schema`** (`.claude/skills/graphql-schema/SKILL.md`) — use when adding or editing anything under `packages/backend/src/graphql/**`.
- **`graphql-testing`** (`.claude/skills/graphql-testing/SKILL.md`) — use when adding or editing any `*.test.ts` that exercises the GraphQL API.
- **`db-schema`** (`.claude/skills/db-schema/SKILL.md`) — use when adding or editing anything under `packages/backend/src/db/schema/**` or generating a new Drizzle migration.

# fire

Monorepo for a personal net worth tracker.

## Structure

- `packages/backend` — Fastify + Apollo GraphQL server. Schema is hand-written in `src/schema.ts` using [Grats](https://grats.capt.dev/) JSDoc tags (`@gqlType`, `@gqlField`, `@gqlQueryField`). Run `pnpm grats` to regenerate the executable schema into `packages/backend/__generated__/{schema.ts,schema.graphql}`. These generated files are committed — regenerate and commit them whenever `src/schema.ts` changes.

## Commits

Always invoke the `commit` skill (`.claude/skills/commit/SKILL.md`) when creating git commits. Commits must follow conventional commit format: `feat(scope): ...`, `fix(scope): ...`, `chore(scope): ...`, etc.

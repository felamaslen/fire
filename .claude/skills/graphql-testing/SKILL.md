---
name: graphql-testing
description: Conventions for writing GraphQL integration tests in this repo (vitest under packages/backend, using the real Fastify app and gql.tada for typed documents). Use proactively whenever adding or editing a `*.test.ts` file that exercises the GraphQL API.
---

# GraphQL testing

GraphQL tests in `packages/backend` drive the real Fastify server (from `src/index.ts`) via `fastify.inject` and compose documents with `gql.tada` for end-to-end type safety between query text and assertions.

## Conventions

1. **Don't build a standalone schema.** Never call `getSchema(...)` / `graphql()` from the `graphql` package in a test. Import the live Fastify instance from `@/index` and dispatch requests through `fastify.inject({ method: "POST", url: "/graphql", payload: { query, variables } })`. Tests must exercise the real server wiring (scalars, plugins, context).

2. **Use `gql.tada` for every document.** Write queries/mutations inside `` graphql`...` `` (the tada-bound tag from `#test/gql`). Tada infers the result/variables types from the committed schema, so destructuring the response and passing variables are both typechecked. Never pass a plain string to the server.

   ```ts
   import { graphql, runGql } from "#test/gql";

   const doc = graphql(`
     mutation Create($id: ID!) {
       netWorthCategoryUpdate(id: $id, input: { asset: { name: "X", type: CASH } }) {
         id name
       }
     }
   `);
   const data = await runGql(doc, { id: assetId });
   ```

   Select interface fields outside inline fragments when the caller needs them across all union members — tada narrows the result per fragment, so `... on NetWorthCategoryAsset { id }` alone won't expose `id` on the liability/option variants.

3. **Co-locate test files with the implementation.** A feature under `src/graphql/net-worth/` has its tests at `src/graphql/net-worth/net-worth.test.ts` (not under a top-level `test/` tree). Shared test helpers — `#test/gql`, global setup, per-test setup — live in `packages/backend/test/` and are imported via the `#test/*` alias.

4. **Don't wrap tests in a describe that repeats the filename.** `net-worth.test.ts` already scopes the file; a `describe("net-worth", ...)` around the whole file adds nothing. Use `describe` only for meaningful subgroups within the file (e.g. `describe("categories", ...)`, `describe("entries", ...)`), and leave standalone tests at the top level.

5. **Throw on GraphQL errors by default.** `runGql` rejects when `body.errors` is non-empty, so tests can use `await expect(runGql(...)).rejects.toThrow(/.../)` for the error path and rely on a resolved value for the happy path. Don't manually inspect `res.statusCode` or parse `res.body` unless you're asserting on the HTTP transport itself.

## Quick reference

| Helper                         | Purpose                                                                 |
| ------------------------------ | ----------------------------------------------------------------------- |
| `graphql` (from `#test/gql`)   | tada-bound tag — compiles the document and infers result/variable types |
| `runGql(doc, variables)`       | sends the document via `fastify.inject`, throws on errors, returns data |
| `fastify` (from `@/index`)     | the running server — use directly only for non-GraphQL route tests      |

---
name: commit
description: Create git commits following the conventional commit format used in this repo. Use proactively whenever the user asks to commit, stage, or save changes to git.
---

# Commit

All commits in this repo follow the conventional commit format:

```
<type>(<scope>): <subject>
```

## Types

- `feat` — new feature
- `fix` — bug fix
- `docs` — documentation only
- `refactor` — code change that is neither a fix nor a feature
- `perf` — performance improvement
- `test` — adding or updating tests
- `chore` — tooling, deps, or other non-src changes
- `style` — formatting only (no logic change)
- `build` — build system or external deps
- `ci` — CI configuration

## Scope

Lowercase, identifies the affected area. Prefer package names (`backend`), then sub-areas (`graphql`, `schema`, `deps`, `readme`).

## Subject

- Imperative mood, lowercase, no trailing period
- Keep under ~70 characters
- Describe the _what_, leave the _why_ for the body (optional)

## Examples

- `feat(backend): add ping query resolver`
- `fix(graphql): handle null in pong field`
- `chore(deps): bump fastify to 5.8.5`
- `docs(readme): describe net worth focus`
- `refactor(backend): extract apollo bootstrap into helper`

## Workflow

1. Run `git status` and `git diff` (plus `git diff --staged` if anything is staged) to see the full change set.
2. If changes span unrelated areas, split into multiple commits by scope. Otherwise a single commit is fine.
3. Stage only the relevant files by name — avoid `git add -A` / `git add .` to keep accidental files out.
4. Write the message via heredoc so formatting is preserved:
   ```bash
   git commit -m "$(cat <<'EOF'
   feat(backend): add ping query resolver
   EOF
   )"
   ```
5. Never add AI attribution. Never use `--no-verify` or skip hooks — if a hook fails, fix the underlying issue and create a new commit.
6. Run `git status` after the commit to confirm the tree is clean.

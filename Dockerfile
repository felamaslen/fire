# Monolith image: builds the `packages/web` SPA, then runs the Fastify backend
# with `WEB_DIST_DIR` pointing at those built assets so the backend serves
# both the GraphQL API and the web app from the same port.
#
# Build context is the repo root so we can copy workspace manifests in the
# right layout for `pnpm install` across the whole workspace.

FROM node:24-alpine AS base
RUN apk add --no-cache libc6-compat \
  && corepack enable \
  && corepack prepare pnpm@10.31.0 --activate
WORKDIR /app

# --- deps ---------------------------------------------------------------
# Install every workspace's dependencies once. Shared across the web build
# stage and the runtime stage so the `pnpm install` layer is cached across
# source-only changes.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/backend/package.json packages/backend/
COPY packages/web/package.json packages/web/
RUN pnpm install --frozen-lockfile

# --- web build ----------------------------------------------------------
# Compile the SPA to `packages/web/dist`. `VITE_GRAPHQL_URL` is baked into
# the bundle; defaulting to a relative `/graphql` means the built app talks
# to whichever host it's served from — exactly what we want for the
# monolith. Override the `ARG` at build time to point at a different API.
FROM deps AS web-build
COPY packages/web ./packages/web
ARG VITE_GRAPHQL_URL=/graphql
ENV VITE_GRAPHQL_URL=$VITE_GRAPHQL_URL
RUN pnpm --filter web build

# --- runtime ------------------------------------------------------------
# Backend is run via `vite-node` straight from TS, so no separate compile
# step — we just need source + installed node_modules. The built SPA lands
# at `/app/web-dist` and is served by `src/spa.ts` via `WEB_DIST_DIR`.
FROM deps AS runtime
COPY packages/backend ./packages/backend
COPY --from=web-build /app/packages/web/dist /app/web-dist

WORKDIR /app/packages/backend

ENV NODE_ENV=production
ENV WEB_DIST_DIR=/app/web-dist

EXPOSE 4000

CMD ["pnpm", "start"]

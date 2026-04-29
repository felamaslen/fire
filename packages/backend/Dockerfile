# Production-oriented image for the backend. In dev, `docker-compose.yml`
# mounts the host source tree over `/app/packages/backend` and overrides
# the default command to `pnpm dev`, so the same image serves both modes.
#
# Build context is the repo root (see `docker-compose.yml`) so we can copy
# workspace manifests in the right layout for `pnpm install`.
FROM node:24-alpine

# `libpq` is needed at runtime for the `pg-native` addon to dlopen libpq.
# `build-base` + `python3` + `postgresql-dev` are needed at install time so
# `node-gyp` can compile the addon against `pg_config` + the libpq headers.
# Keeping everything in one layer because this Dockerfile doesn't split deps
# from runtime — the dev-mode compose mount overlays the source tree anyway.
RUN apk add --no-cache libc6-compat libpq build-base python3 postgresql-dev \
  && corepack enable \
  && corepack prepare pnpm@10.31.0 --activate

WORKDIR /app

# Copy manifests first so the dependency install layer stays cached across
# source-only changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/backend/package.json packages/backend/
COPY packages/web/package.json packages/web/

RUN pnpm install --frozen-lockfile

# Copy the rest of the backend sources so the image is self-contained in
# prod. In dev, docker-compose mounts the host tree over this — that mount
# takes priority, so these layers are effectively ignored at runtime.
COPY packages/backend ./packages/backend

WORKDIR /app/packages/backend

EXPOSE 4000

CMD ["pnpm", "start"]

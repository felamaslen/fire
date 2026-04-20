#!/usr/bin/env bash
# Build the monolith image, push to Docker Hub, and redeploy on the target
# host via `docker compose`. Idempotent: re-running redeploys without
# touching the Postgres data, uploads, or backups volumes on the server.
#
# Usage:
#   scripts/deploy.sh --host myserver [--location /opt/fire] [--platform linux/amd64]
#
# `--host` is passed straight to `ssh`, so any alias from `~/.ssh/config` works.

set -euo pipefail

IMAGE="felamaslen/fire"
HOST=""
LOCATION="/opt/fire"
PLATFORM="linux/amd64"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host)
      HOST="$2"; shift 2 ;;
    --host=*)
      HOST="${1#*=}"; shift ;;
    --location)
      LOCATION="$2"; shift 2 ;;
    --location=*)
      LOCATION="${1#*=}"; shift ;;
    --platform)
      PLATFORM="$2"; shift 2 ;;
    --platform=*)
      PLATFORM="${1#*=}"; shift ;;
    -h|--help)
      sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)
      echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$HOST" ]]; then
  echo "--host is required" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# --- tag --------------------------------------------------------------------
# Clean working tree → build + push `:<git-sha>` and `:latest` so the deploy
# is pinned to an immutable tag. Dirty tree → only push `:latest` (and warn),
# because a git-sha tag would be a lie about what's in the image.
GIT_SHA="$(git rev-parse --short=12 HEAD)"
if [[ -z "$(git status --porcelain)" ]]; then
  TAG="$GIT_SHA"
  TAGS=("$TAG" "latest")
  echo "==> Clean working tree — tagging as :$TAG and :latest"
else
  TAG="latest"
  TAGS=("latest")
  echo "==> WARNING: working tree is dirty — pushing :latest only (no git-sha tag)"
fi

# --- docker hub auth --------------------------------------------------------
# `docker buildx --push` needs creds for `docker.io/felamaslen/*`. Verify the
# *right* account is logged in — a different user's creds would pass a naive
# "any login?" check but fail at push time with a confusing 403. When a
# `DOCKER_PASSWORD` is present in the repo-root `.env`, log in non-
# interactively via `--password-stdin` so CI / scripted runs don't prompt.
EXPECTED_USER="${IMAGE%%/*}"
CURRENT_USER="$(docker system info 2>/dev/null | awk -F': ' '/^ *Username:/ {print $2; exit}')"

if [[ -f .env ]]; then
  # Pull just DOCKER_PASSWORD out of the repo-root `.env` without sourcing
  # the whole file (which would execute arbitrary content and clobber our
  # locals). Strip optional surrounding quotes.
  DOCKER_PASSWORD_FROM_ENV="$(
    awk -F= '/^[[:space:]]*DOCKER_PASSWORD[[:space:]]*=/ {
      sub(/^[^=]*=/, "");
      sub(/^[[:space:]]*"?/, "");
      sub(/"?[[:space:]]*$/, "");
      print; exit
    }' .env
  )"
else
  DOCKER_PASSWORD_FROM_ENV=""
fi

if [[ "$CURRENT_USER" != "$EXPECTED_USER" ]]; then
  if [[ -n "$CURRENT_USER" ]]; then
    echo "==> Docker Hub is logged in as '$CURRENT_USER', need '$EXPECTED_USER' — re-authenticating"
    docker logout >/dev/null 2>&1 || true
  else
    echo "==> Not logged in to Docker Hub — logging in as '$EXPECTED_USER'"
  fi
  if [[ -n "$DOCKER_PASSWORD_FROM_ENV" ]]; then
    printf '%s' "$DOCKER_PASSWORD_FROM_ENV" \
      | docker login --username "$EXPECTED_USER" --password-stdin
  else
    echo "   (set DOCKER_PASSWORD in .env to skip the prompt)"
    docker login --username "$EXPECTED_USER"
  fi
fi

# --- build + push -----------------------------------------------------------
BUILD_ARGS=(--platform "$PLATFORM" --push)
for t in "${TAGS[@]}"; do
  BUILD_ARGS+=(-t "$IMAGE:$t")
done

echo "==> Building & pushing $IMAGE (${TAGS[*]}) for $PLATFORM"
docker buildx build "${BUILD_ARGS[@]}" -f Dockerfile .

# --- remote setup -----------------------------------------------------------
echo "==> Preparing $HOST:$LOCATION"
ssh "$HOST" "mkdir -p '$LOCATION/var/db' '$LOCATION/var/uploads' '$LOCATION/var/backups' '$LOCATION/var/cache'"

# Generate a Postgres password on first deploy. Subsequent deploys read the
# existing `.env` — the password is the key to the persisted DB volume, so
# regenerating it would lock us out of our own data.
ssh "$HOST" "bash -s" <<EOSH
set -euo pipefail
cd '$LOCATION'
if [[ ! -f .env ]]; then
  umask 077
  pw="\$(openssl rand -hex 24)"
  printf 'POSTGRES_PASSWORD=%s\n' "\$pw" > .env
  echo '==> Generated new POSTGRES_PASSWORD in $LOCATION/.env'
fi
EOSH

# --- ship the compose file --------------------------------------------------
echo "==> Copying docker-compose.prod.yml → $HOST:$LOCATION/docker-compose.yml"
scp -q docker-compose.prod.yml "$HOST:$LOCATION/docker-compose.yml"

# --- redeploy ---------------------------------------------------------------
echo "==> Pulling $IMAGE:$TAG, running migrations, and starting compose stack"
ssh "$HOST" "bash -s" <<EOSH
set -euo pipefail
cd '$LOCATION'
export TAG='$TAG'

# Pull the new image(s) first so the migration runs against the code that's
# about to start serving traffic.
docker compose pull

# Bring Postgres up (and only Postgres) and wait for its healthcheck so the
# migration has something to talk to.
docker compose up -d --wait postgres

# Run drizzle-kit migrate in a one-off container built from the app image.
# \`--rm\` so it doesn't leave a stopped container around; the service's env
# (DATABASE_URL etc.) is inherited from docker-compose.yml.
echo '==> Running database migrations'
docker compose run --rm app pnpm db:migrate

# Bring \`backup\` (and anything else) up / prune orphans. Does NOT touch
# \`app\` — we handle that explicitly below because \`--force-recreate\`
# on an \`up\` invocation has proven unreliable in this setup (sometimes
# the container is merely restarted rather than replaced, which loses new
# mounts / env added to the compose file).
docker compose up -d --wait --remove-orphans --no-deps backup

# Explicit rm + up for \`app\`. Guarantees a new container so:
#   - fresh Node process → module-level caches cleared on every deploy
#   - any compose-file changes (new volumes, env vars, image digest) land
# \`--no-deps\` so Postgres isn't touched; \`rm -sf\` stops + removes in one go.
docker compose rm -sf app
docker compose up -d --wait --no-deps app
docker compose ps
EOSH

echo "==> Deploy complete: $IMAGE:$TAG is live on $HOST"

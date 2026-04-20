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

# Seed the server's `.env` on first deploy + top it up with any newly-
# required secrets. Each key is generated only if it's missing — never
# rotated — because these are effectively the keys to persistent state:
#   - `POSTGRES_PASSWORD` keys the on-disk DB volume (rotating locks us out
#     of our own data).
#   - `AUTH_SECRET` signs outstanding `Authorization: Bearer` tokens
#     (rotating logs every user out).
#   - `AUTH_PIN` is the real-user gate; regenerating would quietly change
#     it under the operator. We generate a random 4-digit PIN and print
#     it so the operator can capture it; they can edit `.env` afterwards
#     to set a chosen value.
ssh "$HOST" "bash -s" <<EOSH
set -euo pipefail
cd '$LOCATION'
umask 077
touch .env
ensure_key() {
  local key="\$1"
  local value="\$2"
  if ! grep -q "^\$key=" .env; then
    printf '%s=%s\n' "\$key" "\$value" >> .env
    echo "==> Seeded \$key in $LOCATION/.env"
  fi
}
ensure_key POSTGRES_PASSWORD "\$(openssl rand -hex 24)"
ensure_key AUTH_SECRET       "\$(openssl rand -hex 32)"
ensure_key AUTH_PIN          "\$(( RANDOM % 9000 + 1000 ))"
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
# about to start serving traffic. \`docker compose pull\` only pulls the
# tag resolved from \`image:\` (the sha, via \`\${TAG}\`), so we *also*
# explicitly refresh \`:latest\` — otherwise any ad-hoc \`docker compose\`
# op on the server without \`TAG\` set falls back to a stale local image.
docker compose pull
docker pull '$IMAGE:latest'

# Bring Postgres up (and only Postgres) and wait for its healthcheck so the
# migration has something to talk to.
docker compose up -d --wait postgres

# Run drizzle-kit migrate in a one-off container built from the app image.
# \`--rm\`  — don't leave a stopped container around; env (DATABASE_URL etc.)
#            is inherited from docker-compose.yml.
# \`-T\`   — **critical**: without this, \`docker compose run\` forwards its
#            stdin into the container. We run the whole script via
#            \`ssh bash -s <<EOSH\`, so stdin here *is* the heredoc, and
#            every line after this command silently gets consumed by
#            pnpm instead of executed by the shell (including the app
#            recreate below). Resulting deploys looked green but left
#            the old container running.
echo '==> Running database migrations'
docker compose run --rm -T app pnpm db:migrate

# Bring \`backup\` (and anything else non-app) up / prune orphans. Does NOT
# touch \`app\` — that's handled explicitly below with stronger recreation
# semantics.
docker compose up -d --wait --remove-orphans --no-deps backup

# Replace the \`app\` container from scratch:
#   - \`--pull always\`    : re-fetch the tag right before recreating, so a
#                           \`:latest\` we pushed a moment ago isn't missed
#                           by whatever image ID compose already has on
#                           file from the earlier \`docker compose pull\`.
#   - \`--force-recreate\` : replace the existing container even if compose
#                           thinks the config is unchanged. Previous
#                           deploys hit cases where \`up\` decided to
#                           restart-in-place, silently keeping the old
#                           image and dropping new mounts / env.
#   - \`--no-deps\`        : leave Postgres + backup alone.
#   - \`--wait\`           : fail the deploy if the new container's
#                           healthcheck doesn't flip green.
#
# Kill any stray \`app\` container first in case an earlier compose run
# left one orphaned under a different project name / label — belt-and-
# braces, the combined flags above should already handle the common case.
docker compose rm -sf app || true
if docker compose up -d --wait --no-deps --force-recreate --pull always app; then
  docker compose ps
else
  echo '==> app failed to come up — tailing logs' >&2
  docker compose logs --tail=100 app >&2 || true
  exit 1
fi
EOSH

echo "==> Deploy complete: $IMAGE:$TAG is live on $HOST"

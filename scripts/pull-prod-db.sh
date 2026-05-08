#!/usr/bin/env bash
# Dump the production Postgres database over ssh and restore it into the
# local dev `postgres` service (defined in `packages/backend/docker-compose.yml`),
# overwriting whatever's currently there. Streams `pg_dump -Fc` straight from
# the remote container into a local `pg_restore` — no dump file is written
# to disk on either side. Then rsyncs the prod `uploads/` tree into the
# local `uploads-data` docker volume, skipping files already present
# (so re-runs are cheap and never clobber a locally-modified file).
#
# Usage:
#   scripts/pull-prod-db.sh --host myserver [--location /opt/fire] [--yes]
#
# `--host` is passed straight to `ssh`, so any alias from `~/.ssh/config` works.
# `--yes` skips the "are you sure" prompt (useful for scripted runs).

set -euo pipefail

HOST=""
LOCATION="/opt/fire"
ASSUME_YES=0

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
    -y|--yes)
      ASSUME_YES=1; shift ;;
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
BACKEND_DIR="$REPO_ROOT/packages/backend"

if [[ ! -f "$BACKEND_DIR/docker-compose.yml" ]]; then
  echo "Could not find $BACKEND_DIR/docker-compose.yml" >&2
  exit 1
fi

if (( ! ASSUME_YES )); then
  read -r -p "This will WIPE the local 'fire' database and replace it with prod from $HOST. Continue? [y/N] " reply </dev/tty || reply=""
  [[ "$reply" =~ ^[Yy] ]] || { echo "Aborted."; exit 1; }
fi

cd "$BACKEND_DIR"

echo "==> Ensuring local postgres is up"
docker compose up -d --wait postgres >/dev/null

# Resolve the prod compose project name on the remote host. The deploy script
# copies `docker-compose.prod.yml` to `$LOCATION/docker-compose.yml`, so the
# `postgres` service is reachable via `docker compose exec` from `$LOCATION`.
echo "==> Dumping prod database from $HOST:$LOCATION and streaming into local postgres"

# Drop + recreate the local DB from the `postgres` maintenance DB so the
# restore lands in a truly empty target. `--force` (Postgres 13+) terminates
# any leftover sessions holding `fire` open.
docker compose exec -T postgres psql -U fire -d postgres -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS fire WITH (FORCE);" \
  -c "CREATE DATABASE fire OWNER fire;" >/dev/null

# `pg_dump -Fc` (custom format) on the remote, piped through ssh into a local
# `pg_restore` running inside the dev postgres container. `--no-owner` /
# `--no-privileges` strip prod-specific role grants so restore doesn't fail
# trying to assign ownership to a role that doesn't exist locally.
ssh "$HOST" "cd '$LOCATION' && docker compose exec -T postgres pg_dump -U fire -d fire -Fc" \
  | docker compose exec -T postgres pg_restore -U fire -d fire --no-owner --no-privileges --exit-on-error

# Prod stores uploads as a host bind under `$LOCATION/var/uploads` (see
# `docker-compose.prod.yml`). Locally they live in the named docker volume
# `<project>_uploads-data` mounted into the backend container. Stage the
# remote tree into a host tempdir with rsync, then merge it into the
# volume via a one-shot alpine container using `cp -rn` (no-clobber) —
# files already present locally are kept untouched.
echo "==> Syncing uploads from $HOST:$LOCATION/var/uploads"

COMPOSE_PROJECT="${COMPOSE_PROJECT_NAME:-$(basename "$BACKEND_DIR")}"
UPLOADS_VOLUME="${COMPOSE_PROJECT}_uploads-data"

if ! docker volume inspect "$UPLOADS_VOLUME" >/dev/null 2>&1; then
  echo "Could not find docker volume '$UPLOADS_VOLUME' (is the backend stack up?)" >&2
  exit 1
fi

STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT

rsync -ah --stats --progress "$HOST:$LOCATION/var/uploads/" "$STAGING/"

docker run --rm \
  -v "$UPLOADS_VOLUME:/dst" \
  -v "$STAGING:/src:ro" \
  alpine:3 \
  sh -c 'apk add --no-cache rsync >/dev/null && rsync -a --ignore-existing --stats /src/ /dst/'

echo "==> Done. Local 'fire' database and uploads now mirror prod on $HOST."

#!/usr/bin/env bash
# Dump the local dev Postgres database (defined in
# `packages/backend/docker-compose.yml`) and restore it into the production
# `postgres` service over ssh, overwriting whatever's currently there. Before
# touching prod, a `pg_dump -Fc` of the current prod database is written to
# `packages/backend/.idea/prod-backup-YYYYMMDDHHMMSS.sql` as a safety net.
#
# Usage:
#   scripts/push-prod-db.sh --host myserver [--location /opt/fire] [--yes]
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
      sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
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
  read -r -p "This will WIPE the prod 'fire' database on $HOST and replace it with your LOCAL database. Continue? [y/N] " reply </dev/tty || reply=""
  [[ "$reply" =~ ^[Yy] ]] || { echo "Aborted."; exit 1; }
fi

cd "$BACKEND_DIR"

echo "==> Ensuring local postgres is up"
docker compose up -d --wait postgres >/dev/null

BACKUP_DIR="$BACKEND_DIR/.idea"
mkdir -p "$BACKUP_DIR"
TIMESTAMP="$(date +%Y%m%d%H%M%S)"
BACKUP_FILE="$BACKUP_DIR/prod-backup-$TIMESTAMP.sql"

echo "==> Backing up prod database from $HOST:$LOCATION to $BACKUP_FILE"
# `pg_dump -Fc` (custom format) on the remote, streamed over ssh into a local
# file. Custom format because that's what `pg_restore` expects if we ever need
# to roll back.
ssh "$HOST" "cd '$LOCATION' && docker compose exec -T postgres pg_dump -U fire -d fire -Fc" \
  > "$BACKUP_FILE"

if [[ ! -s "$BACKUP_FILE" ]]; then
  echo "Backup file is empty — aborting before touching prod." >&2
  exit 1
fi

echo "==> Pushing local database to prod $HOST:$LOCATION"

# Drop + recreate the prod DB from the `postgres` maintenance DB so the
# restore lands in a truly empty target. `--force` (Postgres 13+) terminates
# any leftover sessions holding `fire` open.
ssh "$HOST" "cd '$LOCATION' && docker compose exec -T postgres psql -U fire -d postgres -v ON_ERROR_STOP=1 \
  -c \"DROP DATABASE IF EXISTS fire WITH (FORCE);\" \
  -c \"CREATE DATABASE fire OWNER fire;\"" >/dev/null

# `pg_dump -Fc` from the local container, piped over ssh into a `pg_restore`
# running inside the prod postgres container. `--no-owner` / `--no-privileges`
# strip local-specific role grants so restore doesn't fail trying to assign
# ownership to a role that doesn't exist on the prod side.
docker compose exec -T postgres pg_dump -U fire -d fire -Fc \
  | ssh "$HOST" "cd '$LOCATION' && docker compose exec -T postgres pg_restore -U fire -d fire --no-owner --no-privileges --exit-on-error"

echo "==> Done. Prod 'fire' database on $HOST now mirrors your local DB."
echo "    Backup of previous prod state: $BACKUP_FILE"

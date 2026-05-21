#!/usr/bin/env bash
# Build the monolith image, push to Docker Hub, and redeploy on the target
# host via `docker compose`. Idempotent: re-running redeploys without
# touching the Postgres data, uploads, or backups volumes on the server.
#
# Usage:
#   scripts/deploy.sh --host myserver [--location /opt/fire] [--platform linux/amd64] [--bind-extra-ips]
#
# `--host` is passed straight to `ssh`, so any alias from `~/.ssh/config` works.
#
# `--bind-extra-ips` discovers every non-link-local IPv4 address on the
# target host (in addition to `127.0.0.1`) and — after prompting — adds a
# matching `ports:` entry for the `app` service so the backend listens on
# each of them. Off by default; loopback-only is the safer baseline.

set -euo pipefail

IMAGE="felamaslen/fire"
HOST=""
LOCATION="/opt/fire"
PLATFORM="linux/amd64"
BIND_EXTRA_IPS=0

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
    --bind-extra-ips)
      BIND_EXTRA_IPS=1; shift ;;
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

# --- reconcile .env ---------------------------------------------------------
# Diff the server's current `.env` against local `.env.production` and prompt
# the operator key-by-key before mutating the server file. Comments and blank
# lines are dropped — only `KEY=value` lines are preserved. Order is taken
# from the server file (kept keys first, in their existing positions), then
# any newly-added keys from `.env.production` are appended.
echo "==> Reconciling $LOCATION/.env with local .env.production"

env_prev="$(ssh "$HOST" "cat '$LOCATION/.env' 2>/dev/null || true")"
if [[ -f .env.production ]]; then
  env_next="$(cat .env.production)"
else
  env_next=""
fi

# Parse `KEY=value` lines into parallel indexed arrays. We avoid associative
# arrays so this stays compatible with macOS's stock bash 3.2.
parse_env_lines() {
  local line key value
  while IFS= read -r line; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ -z "${line//[[:space:]]/}" ]] && continue
    [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=(.*)$ ]] || continue
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    if [[ "$value" =~ ^\"(.*)\"$ ]] || [[ "$value" =~ ^\'(.*)\'$ ]]; then
      value="${BASH_REMATCH[1]}"
    fi
    printf '%s=%s\n' "$key" "$value"
  done
}

prev_keys=(); prev_vals=()
while IFS='=' read -r k v; do
  [[ -z "$k" ]] && continue
  prev_keys+=("$k"); prev_vals+=("$v")
done < <(printf '%s\n' "$env_prev" | parse_env_lines)

next_keys=(); next_vals=()
while IFS='=' read -r k v; do
  [[ -z "$k" ]] && continue
  next_keys+=("$k"); next_vals+=("$v")
done < <(printf '%s\n' "$env_next" | parse_env_lines)

# Linear-search lookup: prints the value of $1 in the parallel arrays
# `${2}_keys` / `${2}_vals` and returns 0 if found, 1 otherwise. Empty
# values are valid, so we signal presence via exit code rather than output.
lookup_value() {
  local needle="$1" arr_name="$2"
  local keys_var="${arr_name}_keys" vals_var="${arr_name}_vals"
  eval "local n=\${#${keys_var}[@]}"
  local i=0
  while (( i < n )); do
    eval "local key=\"\${${keys_var}[\$i]}\""
    if [[ "$key" == "$needle" ]]; then
      eval "printf '%s' \"\${${vals_var}[\$i]}\""
      return 0
    fi
    i=$((i+1))
  done
  return 1
}

prompt_yn() {
  local reply
  read -r -p "$1 [Y/n] " reply </dev/tty || reply=""
  [[ -z "$reply" || "$reply" =~ ^[Yy] ]]
}

final_keys=(); final_vals=()

for i in "${!prev_keys[@]}"; do
  key="${prev_keys[$i]}"
  pv="${prev_vals[$i]}"
  if nv="$(lookup_value "$key" next)"; then
    if [[ "$pv" != "$nv" ]]; then
      if prompt_yn "Env var $key has changed from '$pv' to '$nv'. Overwrite?"; then
        final_keys+=("$key"); final_vals+=("$nv")
      else
        final_keys+=("$key"); final_vals+=("$pv")
      fi
    else
      final_keys+=("$key"); final_vals+=("$pv")
    fi
  else
    if prompt_yn "Env var $key has been removed (was '$pv'). Delete?"; then
      :
    else
      final_keys+=("$key"); final_vals+=("$pv")
    fi
  fi
done

for i in "${!next_keys[@]}"; do
  key="${next_keys[$i]}"
  nv="${next_vals[$i]}"
  if ! lookup_value "$key" prev >/dev/null; then
    if prompt_yn "Env var $key has been added (value '$nv'). Add?"; then
      final_keys+=("$key"); final_vals+=("$nv")
    fi
  fi
done

final_env=""
for i in "${!final_keys[@]}"; do
  final_env+="${final_keys[$i]}=${final_vals[$i]}"$'\n'
done

ssh "$HOST" "umask 077 && cat > '$LOCATION/.env'" <<<"$final_env"

# Mirror the merged result back into local `.env.production` so the next
# deploy starts from the same baseline the server has. Only rewrite if the
# normalised content differs from what's already on disk.
local_env_normalised=""
for i in "${!next_keys[@]}"; do
  local_env_normalised+="${next_keys[$i]}=${next_vals[$i]}"$'\n'
done
if [[ "$final_env" != "$local_env_normalised" ]]; then
  printf '%s' "$final_env" > .env.production
  echo "==> Updated local .env.production to match merged result"
fi

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
# Upload as a `.draft` first so we can edit it in place on the server (e.g.
# to inject extra `ports:` entries for the host's public IPs) before
# atomically promoting it to `docker-compose.yml`. Keeps the live compose
# file untouched if anything below fails or the operator aborts.
DRAFT_PATH="$LOCATION/docker-compose.yml.draft"
FINAL_PATH="$LOCATION/docker-compose.yml"
echo "==> Copying docker-compose.prod.yml → $HOST:$DRAFT_PATH"
scp -q docker-compose.prod.yml "$HOST:$DRAFT_PATH"

if (( BIND_EXTRA_IPS )); then
  # Discover every globally-scoped IPv4 on the server, then keep only the
  # privately-routable ones: RFC1918 (10/8, 172.16/12, 192.168/16) plus
  # CGNAT (100.64/10, used by Tailscale et al.). `scope global` already
  # excludes loopback (127/8) and link-local (169.254/16); the awk filter
  # then drops anything publicly routable so we never accidentally expose
  # the app on a WAN interface.
  echo "==> Discovering private (non-publicly-routable) IPv4 addresses on $HOST"
  extra_ips_raw="$(ssh "$HOST" "ip -4 -o addr show scope global | awk '{print \$4}' | cut -d/ -f1 | awk -F. '
    \$1==10 { print; next }
    \$1==172 && \$2>=16 && \$2<=31 { print; next }
    \$1==192 && \$2==168 { print; next }
    \$1==100 && \$2>=64 && \$2<=127 { print; next }
  '" || true)"
  extra_ips=()
  while IFS= read -r ip; do
    [[ -z "$ip" ]] && continue
    extra_ips+=("$ip")
  done <<<"$extra_ips_raw"

  selected_ips=()
  if (( ${#extra_ips[@]} == 0 )); then
    echo "   (no extra addresses found — leaving compose file bound to 127.0.0.1 only)"
  else
    for ip in "${extra_ips[@]}"; do
      if prompt_yn "Add listen directive for $ip alongside 127.0.0.1?"; then
        selected_ips+=("$ip")
      fi
    done
  fi

  if (( ${#selected_ips[@]} > 0 )); then
    # Build the additional `ports:` lines with the same 6-space indent as
    # the existing `- "127.0.0.1:…"` entry, ship them to the server as a
    # temp file, and splice them in right after that line with awk.
    insert_block=""
    for ip in "${selected_ips[@]}"; do
      insert_block+="      - \"$ip:\${APP_PORT:-4000}:4000\""$'\n'
    done
    echo "==> Adding listen directives for: ${selected_ips[*]}"
    ssh "$HOST" "cat > '$DRAFT_PATH.insert'" <<<"$insert_block"
    ssh "$HOST" "bash -s" <<EOSH
set -euo pipefail
awk '
  BEGIN {
    while ((getline line < "$DRAFT_PATH.insert") > 0) {
      block = block line "\n"
    }
    close("$DRAFT_PATH.insert")
  }
  { print }
  /^      - "127\.0\.0\.1:\\\${APP_PORT/ && !done {
    printf "%s", block
    done = 1
  }
' '$DRAFT_PATH' > '$DRAFT_PATH.new'
mv '$DRAFT_PATH.new' '$DRAFT_PATH'
rm -f '$DRAFT_PATH.insert'
EOSH
  fi
fi

echo "==> Promoting draft → $HOST:$FINAL_PATH"
ssh "$HOST" "mv '$DRAFT_PATH' '$FINAL_PATH'"

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

# Run @pgkit/migrator in a one-off container built from the app image.
# \`--rm\`      — don't leave a stopped container around; env (DATABASE_URL
#                etc.) is inherited from docker-compose.yml.
# \`-T\`       — disable pseudo-TTY allocation (compose would otherwise try
#                to open one and fail under \`ssh bash -s\`).
# \`</dev/null\` — **critical**: even with \`-T\`, \`docker compose run\` still
#                attaches stdin and forwards it into the container. Our
#                stdin here is the \`ssh bash -s <<EOSH\` heredoc, so
#                without this redirect every line after this command
#                gets consumed by pnpm inside the migration container
#                instead of executed by the remote shell — including
#                the app recreate below. Deploys looked green but left
#                the old container running.
echo '==> Running database migrations'
docker compose run --rm -T app pnpm db:migrate </dev/null

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

#!/bin/bash
# Read AWS Secrets Manager → write .env / .json files under deploy/.secrets/
# Containers bind-mount this dir as /run/secrets:ro (see docker-compose.yml).
#
# Env contract:
#   SECRETS_PREFIX   namespace under Secrets Manager (default: openclaw)
#                    matches terraform var.secrets_prefix; every secret is
#                    fetched as `<SECRETS_PREFIX>/<name>`.
#   MEMEX_PUBLIC_WRITE  set to 1 in .env to opt in to public MCP write
#                          tools. Default OFF — a fresh public-template
#                          clone never accepts mutating MCP traffic.
set -euo pipefail

# Try to source the repo-level .env so this script works both from
# bootstrap.sh (which exports the prefix) and from a manual rerun.
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
if [ -f "${REPO_ROOT}/.env" ]; then
  # shellcheck source=/dev/null
  . "${REPO_ROOT}/.env"
fi

SECRETS_PREFIX="${SECRETS_PREFIX:-openclaw}"

# Resolve to <repo>/deploy/.secrets/ regardless of where this script lives.
# `dirname "$0"` is .../deploy/secrets — go up one level so the secrets land
# next to docker-compose.yml, matching the compose bind-mount source.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SECRETS_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)/.secrets"
mkdir -p "$SECRETS_DIR"
chmod 0700 "$SECRETS_DIR"

fetch_text() {
  local name="$1" out="$2"
  aws secretsmanager get-secret-value \
    --secret-id "${SECRETS_PREFIX}/$name" \
    --query SecretString \
    --output text > "${SECRETS_DIR}/${out}"
  chmod 0400 "${SECRETS_DIR}/${out}"
}

# Plain string secrets
fetch_text "telegram-bot-token" "telegram-bot-token.txt"
fetch_text "home-assistant-token" "home-assistant-token.txt"
# Gateway token — stable across restarts. The openclaw entrypoint reads
# this from /run/secrets/ to pin gateway.auth.token; rotating the secret +
# restarting deploy-openclaw-1 is the manual rotation path.
fetch_text "gateway-token" "gateway-token.txt"

# JSON secrets — kept as JSON for jq consumption inside containers
fetch_text "google-calendar" "google-calendar.json"
fetch_text "obsidian-sync" "obsidian-sync.json"

# Cloudflared tunnel token → .env format for compose env_file.
# cloudflared reads TUNNEL_TOKEN natively when --token isn't passed.
TOKEN=$(aws secretsmanager get-secret-value \
  --secret-id "${SECRETS_PREFIX}/cloudflared-tunnel-token" \
  --query SecretString --output text)
{
  echo "TUNNEL_TOKEN=${TOKEN}"
  # Compat alias for any non-CLI consumer; harmless duplicate.
  echo "CLOUDFLARE_TUNNEL_TOKEN=${TOKEN}"
} > "${SECRETS_DIR}/cloudflared.env"
chmod 0400 "${SECRETS_DIR}/cloudflared.env"

# memex.env is the single env_file the memex container reads.
# Two independent secrets land in it:
#
#   MEMEX_POSTGRES_URL    provisioned by terraform/rds.tf
#                            (the RDS endpoint memex talks to)
#   MEMEX_PUBLIC_BEARER   provisioned by terraform/secrets.tf
#                            (auth token for the public MCP ingress)
#
# A missing Postgres URL is fatal in production but accepted here so
# fresh provisioning doesn't break the boot loop — the container falls
# back to a local PGLite (dev-only). A missing bearer simply disables
# the public ingress; internal Docker traffic still flows.
MEMEX_ENV="${SECRETS_DIR}/memex.env"
: > "$MEMEX_ENV"
chmod 0600 "$MEMEX_ENV"

if aws secretsmanager describe-secret \
  --secret-id "${SECRETS_PREFIX}/memex-postgres-url" >/dev/null 2>&1; then
  PG_URL=$(aws secretsmanager get-secret-value \
    --secret-id "${SECRETS_PREFIX}/memex-postgres-url" \
    --query SecretString --output text)
  echo "MEMEX_POSTGRES_URL=${PG_URL}" >> "$MEMEX_ENV"
  echo "[secrets] memex Postgres URL fetched"
else
  echo "[secrets] WARN: memex Postgres URL not provisioned — daemon will start on local PGLite (dev fallback)"
fi

if aws secretsmanager describe-secret \
  --secret-id "${SECRETS_PREFIX}/memex-public-bearer" >/dev/null 2>&1; then
  PUB_BEARER=$(aws secretsmanager get-secret-value \
    --secret-id "${SECRETS_PREFIX}/memex-public-bearer" \
    --query SecretString --output text)
  echo "MEMEX_PUBLIC_BEARER=${PUB_BEARER}" >> "$MEMEX_ENV"
  echo "[secrets] memex public bearer fetched"
else
  echo "[secrets] memex public bearer not yet provisioned (public ingress disabled)"
fi

# Public write — propagate the .env opt-in value (default 0 = read-only).
# When MEMEX_PUBLIC_WRITE=1 is set in .env, the public Cloudflare ingress
# accepts `index` / `log_friction` MCP calls (in addition to the read tools)
# for bearer-authenticated requests. Pair with the daily bearer rotation
# (deploy/systemd/memex-rotate-bearer.timer) so a leaked token is
# invalidated within 24 h.
PUBLIC_WRITE="${MEMEX_PUBLIC_WRITE:-0}"
echo "MEMEX_PUBLIC_WRITE=${PUBLIC_WRITE}" >> "$MEMEX_ENV"
if [ "$PUBLIC_WRITE" = "1" ]; then
  echo "[secrets] memex public write ENABLED (opted in via MEMEX_PUBLIC_WRITE=1)"
else
  echo "[secrets] memex public write DISABLED (default — read-only MCP)"
fi

chmod 0400 "$MEMEX_ENV"

echo "[secrets] fetched secrets to ${SECRETS_DIR} (prefix: ${SECRETS_PREFIX})"

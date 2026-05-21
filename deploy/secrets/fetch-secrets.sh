#!/bin/bash
# Read AWS Secrets Manager → write .env / .json files under deploy/.secrets/
# Containers bind-mount this dir as /run/secrets:ro (see docker-compose.yml).
#
# Env contract:
#   AWS_REGION       AWS region to query Secrets Manager in. Required.
#   SECRETS_PREFIX   namespace under Secrets Manager (default: memex)
#                    matches terraform var.secrets_prefix; every secret is
#                    fetched as `<SECRETS_PREFIX>/<name>`.
#   MEMEX_PUBLIC_WRITE  set to 1 in .env to opt in to public MCP write tools.
set -euo pipefail

# Defensive: never leak secret values via shell trace if someone exports DEBUG.
set +x

# Try to source the repo-level .env so this script works both from
# bootstrap.sh (which exports the prefix) and from a manual rerun.
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
if [ -f "${REPO_ROOT}/.env" ]; then
  # shellcheck source=/dev/null
  . "${REPO_ROOT}/.env"
fi

: "${AWS_REGION:?AWS_REGION must be set (export it or define it in ${REPO_ROOT}/.env)}"
SECRETS_PREFIX="${SECRETS_PREFIX:-memex}"

# Resolve to <repo>/deploy/.secrets/ regardless of where this script lives.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SECRETS_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)/.secrets"
umask 077
mkdir -p "$SECRETS_DIR"
# 0711: root owns + lists, others may descend into the dir (so non-root
# container UIDs — e.g. the telegram-bridge running as uid 10001 — can
# read named files inside). Non-root host users cannot enumerate the
# dir, which is the actual confidentiality requirement. Individual
# files keep their own per-secret modes set below.
chmod 0711 "$SECRETS_DIR"

# Strip the single trailing newline that `aws secretsmanager get-secret-value
# --output text` always appends. Most consumers (docker compose env_file,
# jq) tolerate it, but a few (postgres URL parsers, openclaw config set)
# do not — be safe by default.
sm_text() {
  aws secretsmanager get-secret-value \
    --secret-id "${SECRETS_PREFIX}/$1" \
    --region "$AWS_REGION" \
    --query SecretString --output text \
    | tr -d '\n\r'
}

fetch_text() {
  local name="$1" out="$2" mode="${3:-0400}"
  sm_text "$name" > "${SECRETS_DIR}/${out}"
  chmod "$mode" "${SECRETS_DIR}/${out}"
}

# Plain string secrets. telegram-bot-token + memex-public-bearer are mode
# 0444 — the telegram-bridge container reads both as non-root uid 10001.
# The 0711 parent dir already prevents non-root host users from
# enumerating; only siblings inside this stack (openclaw / memex / bridge)
# can read by exact name.
fetch_text "telegram-bot-token" "telegram-bot-token.txt" 0444
fetch_text "home-assistant-token" "home-assistant-token.txt"
fetch_text "gateway-token" "gateway-token.txt"

# memex-public-bearer is the auth token the bridge sends on its
# MCP JSON-RPC calls into memex. memex itself reads the same value
# via $MEMEX_PUBLIC_BEARER in memex.env (mode 0400, root-only) below;
# this 0444 sibling file is the bridge's read path. Gate on
# describe-secret so a fresh install (before the bearer is provisioned)
# still completes without an aws-cli failure.
if aws secretsmanager describe-secret \
  --secret-id "${SECRETS_PREFIX}/memex-public-bearer" \
  --region "$AWS_REGION" >/dev/null 2>&1; then
  fetch_text "memex-public-bearer" "memex-public-bearer.txt" 0444
fi

# JSON secrets — kept as JSON for jq consumption inside containers
fetch_text "google-calendar" "google-calendar.json"

# Cloudflared tunnel token → .env format for compose env_file.
TUNNEL_TOKEN=$(sm_text "cloudflared-tunnel-token")
{
  printf 'TUNNEL_TOKEN=%s\n' "$TUNNEL_TOKEN"
  printf 'CLOUDFLARE_TUNNEL_TOKEN=%s\n' "$TUNNEL_TOKEN"
} > "${SECRETS_DIR}/cloudflared.env"
chmod 0400 "${SECRETS_DIR}/cloudflared.env"
unset TUNNEL_TOKEN

# memex.env is the single env_file the memex container reads.
MEMEX_ENV="${SECRETS_DIR}/memex.env"
: > "$MEMEX_ENV"
chmod 0600 "$MEMEX_ENV"

if aws secretsmanager describe-secret \
  --secret-id "${SECRETS_PREFIX}/memex-postgres-url" \
  --region "$AWS_REGION" >/dev/null 2>&1; then
  PG_URL=$(sm_text "memex-postgres-url")
  printf 'MEMEX_POSTGRES_URL=%s\n' "$PG_URL" >> "$MEMEX_ENV"
  unset PG_URL
  echo "[secrets] memex Postgres URL fetched"
else
  echo "[secrets] WARN: memex Postgres URL not provisioned — daemon will start on local PGLite (dev fallback)"
fi

if aws secretsmanager describe-secret \
  --secret-id "${SECRETS_PREFIX}/memex-public-bearer" \
  --region "$AWS_REGION" >/dev/null 2>&1; then
  PUB_BEARER=$(sm_text "memex-public-bearer")
  printf 'MEMEX_PUBLIC_BEARER=%s\n' "$PUB_BEARER" >> "$MEMEX_ENV"
  unset PUB_BEARER
  echo "[secrets] memex public bearer fetched"
else
  echo "[secrets] memex public bearer not yet provisioned (public ingress disabled)"
fi

# Internal-route shared token. Defends POST /index and POST /friction
# on the docker-internal bridge from a compromised sibling container.
# Both memex and the bridge container read this from MEMEX_INTERNAL_TOKEN
# at startup; absence falls through to legacy "open internal" behaviour
# with a startup warning (so existing single-node installs upgrade
# cleanly even before the operator creates the secret).
if aws secretsmanager describe-secret \
  --secret-id "${SECRETS_PREFIX}/memex-internal-token" \
  --region "$AWS_REGION" >/dev/null 2>&1; then
  INT_TOKEN=$(sm_text "memex-internal-token")
  printf 'MEMEX_INTERNAL_TOKEN=%s\n' "$INT_TOKEN" >> "$MEMEX_ENV"
  unset INT_TOKEN
  echo "[secrets] memex internal token fetched"
else
  echo "[secrets] memex internal token not yet provisioned — internal routes stay open (legacy fallthrough)"
fi

PUBLIC_WRITE="${MEMEX_PUBLIC_WRITE:-0}"
printf 'MEMEX_PUBLIC_WRITE=%s\n' "$PUBLIC_WRITE" >> "$MEMEX_ENV"
if [ "$PUBLIC_WRITE" = "1" ]; then
  echo "[secrets] memex public write ENABLED (opted in via MEMEX_PUBLIC_WRITE=1)"
else
  echo "[secrets] memex public write DISABLED (default — read-only MCP)"
fi

chmod 0400 "$MEMEX_ENV"

echo "[secrets] fetched secrets to ${SECRETS_DIR} (prefix: ${SECRETS_PREFIX})"

#!/bin/bash
# Daily rotation of the public memex bearer token.
#
# Steps:
#   1. Generate a new 32-byte hex token.
#   2. PUT it into Secrets Manager (<SECRETS_PREFIX>/memex-public-bearer).
#   3. Re-run fetch-secrets.sh so the on-disk env file picks up the new
#      value, then `docker restart deploy-memex-1` to make the daemon
#      see it. Retrieve the rotated token from Secrets Manager on demand.
#
# Env contract (sourced from ${REPO_DIR}/.env):
#   AWS_REGION, SECRETS_PREFIX
# Optional knobs:
#   MEMEX_ROTATE_COMPOSE_DIR   path to deploy/ (default: ${REPO_DIR}/deploy)
#   MEMEX_ROTATE_CONTAINER     container name (default: deploy-memex-1)

set -euo pipefail

REPO_DIR="${REPO_DIR:-/opt/memex}"
if [ -f "${REPO_DIR}/.env" ]; then
  # shellcheck source=/dev/null
  . "${REPO_DIR}/.env"
fi

: "${AWS_REGION:?AWS_REGION must be set (sourced from \${REPO_DIR}/.env)}"
SECRETS_PREFIX="${SECRETS_PREFIX:-memex}"

BEARER_SECRET_ID="${SECRETS_PREFIX}/memex-public-bearer"
COMPOSE_DIR="${MEMEX_ROTATE_COMPOSE_DIR:-${REPO_DIR}/deploy}"
MEMEX_CONTAINER="${MEMEX_ROTATE_CONTAINER:-deploy-memex-1}"

log() {
  printf '[%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"
}

# 1. Mint a fresh token.
NEW_TOKEN="$(openssl rand -hex 32)"
log "minted new token (length: ${#NEW_TOKEN})"

# 2. Update Secrets Manager. `put-secret-value` keeps the previous
# version as AWSPREVIOUS so a rollback is one CLI call away if anything
# downstream breaks before container restart.
aws secretsmanager put-secret-value \
  --secret-id "$BEARER_SECRET_ID" \
  --secret-string "$NEW_TOKEN" \
  --region "$AWS_REGION" >/dev/null
log "secrets manager: updated $BEARER_SECRET_ID"

# 3. Restage on-disk secret + restart memex so it reads the new env.
if [[ -x "$COMPOSE_DIR/secrets/fetch-secrets.sh" ]]; then
  (cd "$COMPOSE_DIR" && "$COMPOSE_DIR/secrets/fetch-secrets.sh") >/dev/null
  log "fetch-secrets.sh: re-staged .secrets/ from Secrets Manager"
else
  log "WARN: fetch-secrets.sh not found at $COMPOSE_DIR/secrets — skipping restage"
fi

if docker ps --format '{{.Names}}' | grep -q "^${MEMEX_CONTAINER}$"; then
  docker restart "$MEMEX_CONTAINER" >/dev/null
  log "docker: restarted $MEMEX_CONTAINER"
else
  log "WARN: container $MEMEX_CONTAINER not running — skipping restart"
fi

# The rotated token lives in Secrets Manager; MCP clients pull it on
# demand:
#   aws secretsmanager get-secret-value --secret-id ${BEARER_SECRET_ID} \
#     --region ${AWS_REGION} --query SecretString --output text
log "rotation complete"

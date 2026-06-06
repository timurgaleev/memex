#!/bin/bash
# Daily rotation of the public memex bearer token.
#
# Steps:
#   1. Generate a new 32-byte hex token.
#   2. PUT it into Secrets Manager (<SECRETS_PREFIX>/memex-public-bearer).
#   3. Re-run fetch-secrets.sh so the on-disk env file picks up the new
#      value, then force-recreate the memex container via compose so it
#      re-reads the changed env_file. (`docker restart` does NOT reload a
#      changed env_file — env is baked at container create — so a plain
#      restart would keep the OLD bearer and silently break public auth
#      until the next deploy.) Retrieve the rotated token from Secrets
#      Manager on demand.
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
MEMEX_SERVICE="${MEMEX_ROTATE_SERVICE:-memex}"

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

# 3. Restage on-disk secret so the env_file holds the new value.
if [[ -x "$COMPOSE_DIR/secrets/fetch-secrets.sh" ]]; then
  (cd "$COMPOSE_DIR" && "$COMPOSE_DIR/secrets/fetch-secrets.sh") >/dev/null
  log "fetch-secrets.sh: re-staged .secrets/ from Secrets Manager"
else
  log "WARN: fetch-secrets.sh not found at $COMPOSE_DIR/secrets — skipping restage"
fi

# 4. Force-recreate memex so it RE-READS the changed env_file. A plain
# `docker restart` restarts the process with the env baked in at create
# time and would keep the OLD bearer — public auth then breaks until the
# next deploy. `compose up --force-recreate` rebuilds the container with
# the freshly-staged env_file.
if docker ps --format '{{.Names}}' | grep -q "^${MEMEX_CONTAINER}$"; then
  (cd "$REPO_DIR" && docker compose --env-file "${REPO_DIR}/.env" \
     -f "$COMPOSE_DIR/docker-compose.yml" up -d --force-recreate "$MEMEX_SERVICE") >/dev/null
  log "docker compose: force-recreated $MEMEX_SERVICE (reloads rotated env_file)"
else
  log "WARN: container $MEMEX_CONTAINER not running — skipping recreate"
fi

# The rotated token lives in Secrets Manager; MCP clients pull it on
# demand:
#   aws secretsmanager get-secret-value --secret-id ${BEARER_SECRET_ID} \
#     --region ${AWS_REGION} --query SecretString --output text
log "rotation complete"

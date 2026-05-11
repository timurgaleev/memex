#!/bin/bash
# Daily rotation of the public memex bearer token.
#
# Steps:
#   1. Generate a new 32-byte hex token.
#   2. PUT it into Secrets Manager (<SECRETS_PREFIX>/memex-public-bearer).
#   3. Re-run fetch-secrets.sh so the on-disk env file picks up the new
#      value, then `docker restart deploy-memex-1` to make the daemon
#      see it.
#   4. Optionally Telegram-deliver the new token to MEMEX_ROTATE_TG_CHAT_ID
#      so it can be pasted into a remote MCP client.
#
# Env contract (sourced from ${REPO_DIR}/.env):
#   AWS_REGION, SECRETS_PREFIX, MEMEX_HOST
# Optional knobs:
#   MEMEX_ROTATE_TG_CHAT_ID    chat to notify (empty = skip Telegram)
#   MEMEX_ROTATE_COMPOSE_DIR   path to deploy/ (default: ${REPO_DIR}/deploy)
#   MEMEX_ROTATE_CONTAINER     container name (default: deploy-memex-1)

set -euo pipefail

REPO_DIR="${REPO_DIR:-/opt/memex}"
if [ -f "${REPO_DIR}/.env" ]; then
  # shellcheck source=/dev/null
  . "${REPO_DIR}/.env"
fi

AWS_REGION="${AWS_REGION:-eu-west-1}"
SECRETS_PREFIX="${SECRETS_PREFIX:-memex}"
MEMEX_HOST="${MEMEX_HOST:-}"
ROTATE_TZ="${MEMEX_ROTATE_TZ:-UTC}"

BEARER_SECRET_ID="${SECRETS_PREFIX}/memex-public-bearer"
TELEGRAM_SECRET_ID="${SECRETS_PREFIX}/telegram-bot-token"
TELEGRAM_CHAT_ID="${MEMEX_ROTATE_TG_CHAT_ID:-}"
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

# 4. Notify via Telegram. Failure here is logged but does not fail the
# rotation — the secret is already updated. Skip entirely if no chat id
# was configured.
if [[ -z "$TELEGRAM_CHAT_ID" ]]; then
  log "telegram: no MEMEX_ROTATE_TG_CHAT_ID set — skipping delivery"
  log "rotation complete"
  exit 0
fi

TG_TOKEN="$(aws secretsmanager get-secret-value \
  --secret-id "$TELEGRAM_SECRET_ID" \
  --region "$AWS_REGION" \
  --query SecretString --output text 2>/dev/null || echo "")"

if [[ -z "$TG_TOKEN" ]]; then
  log "WARN: telegram bot token not available — token NOT delivered"
  exit 0
fi

NOW="$(TZ="$ROTATE_TZ" date '+%Y-%m-%d %H:%M %Z')"
MCP_URL="https://${MEMEX_HOST:-brain.example.com}/mcp"
MESSAGE=$(cat <<EOF
🔑 memex bearer rotated — $NOW

Public MCP: $MCP_URL
Token (valid until next scheduled rotation):

\`$NEW_TOKEN\`

Paste into ~/.claude.json under
\`mcpServers.memex.headers.Authorization\` as \`Bearer <token>\`.
EOF
)

if curl -fsSL --max-time 15 \
     -X POST "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" \
     --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
     --data-urlencode "parse_mode=Markdown" \
     --data-urlencode "text=${MESSAGE}" \
     >/dev/null; then
  log "telegram: delivered new token to chat ${TELEGRAM_CHAT_ID}"
else
  log "WARN: telegram delivery failed — token NOT delivered (retrieve from Secrets Manager)"
fi

log "rotation complete"

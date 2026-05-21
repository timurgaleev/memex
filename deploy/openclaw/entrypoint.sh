#!/bin/bash
# openclaw entrypoint — patches config from template + secrets at startup.
set -euo pipefail

mkdir -p "${HOME}/.openclaw"

SECRETS_PREFIX="${SECRETS_PREFIX:-memex}"
: "${AWS_REGION:?AWS_REGION must be set in the container environment}"

# Resolve gateway token from Secrets Manager (KMS-encrypted, CloudTrail-audited).
# Legacy EFS fallback kept only for pre-Secrets-Manager installs.
GATEWAY_TOKEN=""
if aws secretsmanager describe-secret \
     --secret-id "${SECRETS_PREFIX}/gateway-token" \
     --region "$AWS_REGION" >/dev/null 2>&1; then
  GATEWAY_TOKEN=$(aws secretsmanager get-secret-value \
    --secret-id "${SECRETS_PREFIX}/gateway-token" \
    --region "$AWS_REGION" \
    --query SecretString --output text | tr -d '\n\r')
fi
if [ -z "$GATEWAY_TOKEN" ]; then
  TOKEN_FILE="${HOME}/.openclaw/workspace/.gateway-token"
  if [ ! -s "$TOKEN_FILE" ]; then
    mkdir -p "$(dirname "$TOKEN_FILE")"
    umask 077
    node -e 'process.stdout.write(require("crypto").randomBytes(20).toString("hex"))' > "$TOKEN_FILE"
  fi
  GATEWAY_TOKEN=$(tr -d '\n\r' < "$TOKEN_FILE")
fi

# Resolve the public memex bearer so openclaw can register memex as an
# external MCP server (mcp.servers.memex). The bearer rotates daily at
# 06:00 Berlin; scripts/rotate-memex-public-bearer.sh restarts this
# container after each rotation so this fetch always returns the current
# value. If the secret is missing (fresh install before the bearer is
# seeded), the entrypoint drops the mcp.servers.memex block via jq so the
# gateway boots without a half-configured MCP client.
MEMEX_PUBLIC_BEARER=""
if aws secretsmanager describe-secret \
     --secret-id "${SECRETS_PREFIX}/memex-public-bearer" \
     --region "$AWS_REGION" >/dev/null 2>&1; then
  MEMEX_PUBLIC_BEARER=$(aws secretsmanager get-secret-value \
    --secret-id "${SECRETS_PREFIX}/memex-public-bearer" \
    --region "$AWS_REGION" \
    --query SecretString --output text | tr -d '\n\r')
fi

# Telegram channel ownership:
# - OPENCLAW_TELEGRAM_DISABLED=1   → drop the channels.telegram block so
#                                    the `telegram-bridge` container owns
#                                    the bot's `getUpdates` long-poll
#                                    exclusively (recommended).
# - default (legacy)               → openclaw configures the Telegram
#                                    channel itself; only one of openclaw
#                                    and the bridge can long-poll at a
#                                    time (Telegram returns 409 Conflict).
TELEGRAM_DISABLED="${OPENCLAW_TELEGRAM_DISABLED:-0}"

if [ "$TELEGRAM_DISABLED" != "1" ]; then
  if [ ! -s /run/secrets/telegram-bot-token.txt ]; then
    echo "FATAL: /run/secrets/telegram-bot-token.txt missing or empty — run deploy/secrets/fetch-secrets.sh on the host" >&2
    exit 1
  fi
  TELEGRAM_TOKEN=$(tr -d '\n\r' < /run/secrets/telegram-bot-token.txt)
else
  TELEGRAM_TOKEN=""
  echo "[entrypoint] OPENCLAW_TELEGRAM_DISABLED=1 — bridge container owns the bot"
fi

# Patch config from template — jq seeds template defaults + secrets in one
# fast pass. HA + GCal credentials are NOT in openclaw.json: the `ha` and
# `gcal` helper CLIs (mounted at /opt/<project>/bin/) fetch them directly
# from Secrets Manager via the EC2 IAM role at call time.
#
# memex MCP wiring: if MEMEX_PUBLIC_BEARER resolved, substitute it into
# mcp.servers.memex.headers.Authorization. If not (fresh install), drop
# the mcp.servers.memex block entirely so the gateway doesn't try to
# connect with a placeholder bearer and spam reconnect errors.
# shellcheck disable=SC2016
# $memex_bearer here is a jq variable bound via --arg, not a shell var;
# single quotes are correct — we want jq to expand it, not the shell.
MCP_PATCH='if $memex_bearer != "" then
  .mcp.servers.memex.headers.Authorization = "Bearer " + $memex_bearer
else
  del(.mcp.servers.memex)
end'

if [ "$TELEGRAM_DISABLED" = "1" ]; then
  jq \
    --arg gateway_token "$GATEWAY_TOKEN" \
    --arg memex_bearer "$MEMEX_PUBLIC_BEARER" \
    "del(.channels.telegram) | .gateway.auth.token = \$gateway_token | $MCP_PATCH" \
    /app/config.template.json > "${HOME}/.openclaw/openclaw.json"
else
  jq \
    --arg telegram_token "$TELEGRAM_TOKEN" \
    --arg gateway_token "$GATEWAY_TOKEN" \
    --arg memex_bearer "$MEMEX_PUBLIC_BEARER" \
    ".channels.telegram.botToken = \$telegram_token | .gateway.auth.token = \$gateway_token | $MCP_PATCH" \
    /app/config.template.json > "${HOME}/.openclaw/openclaw.json"
fi

# Re-stamp every secret-bearing field via openclaw's own writer so the
# resulting file carries the audit-meta the gateway expects on next boot.
if [ "$TELEGRAM_DISABLED" != "1" ]; then
  openclaw config set channels.telegram.botToken "$TELEGRAM_TOKEN" >/dev/null
fi
openclaw config set gateway.auth.token "$GATEWAY_TOKEN" >/dev/null

export BRAIN_URL="http://memex:18790"

exec openclaw gateway

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

TELEGRAM_TOKEN=$(tr -d '\n\r' < /run/secrets/telegram-bot-token.txt)

# Patch config from template — jq seeds template defaults + secrets in one
# fast pass. HA + GCal credentials are NOT in openclaw.json: the `ha` and
# `gcal` helper CLIs (mounted at /opt/<project>/bin/) fetch them directly
# from Secrets Manager via the EC2 IAM role at call time.
jq \
  --arg telegram_token "$TELEGRAM_TOKEN" \
  --arg gateway_token "$GATEWAY_TOKEN" \
  '.channels.telegram.botToken = $telegram_token | .gateway.auth.token = $gateway_token' \
  /app/config.template.json > "${HOME}/.openclaw/openclaw.json"

# Re-stamp every secret-bearing field via openclaw's own writer so the
# resulting file carries the audit-meta the gateway expects on next boot.
openclaw config set channels.telegram.botToken "$TELEGRAM_TOKEN" >/dev/null
openclaw config set gateway.auth.token "$GATEWAY_TOKEN" >/dev/null

export BRAIN_URL="http://memex:18790"

exec openclaw gateway

#!/bin/bash
# openclaw entrypoint — patches config from template + secrets at startup.
# Replaces the post-onboard.sh Python that mutated ~/.openclaw/openclaw.json
# on the bare-metal install.
set -euo pipefail

# Ensure config dir exists (workspace bind-mount may not seed it)
mkdir -p "${HOME}/.openclaw"

# Resolve gateway token. Preferred path: AWS Secrets Manager (KMS-encrypted,
# CloudTrail-audited, survives container rebuilds, manually rotatable).
# Legacy fallback: a 40-char hex token persisted on EFS at
# workspace/.gateway-token, generated on first boot of pre-Secrets-Manager
# builds. Drop the fallback once openclaw/gateway-token is provisioned in
# every environment.
GATEWAY_TOKEN=""
if aws secretsmanager describe-secret \
     --secret-id openclaw/gateway-token \
     --region "${AWS_REGION:-eu-west-1}" >/dev/null 2>&1; then
  GATEWAY_TOKEN=$(aws secretsmanager get-secret-value \
    --secret-id openclaw/gateway-token \
    --region "${AWS_REGION:-eu-west-1}" \
    --query SecretString --output text)
fi
if [ -z "$GATEWAY_TOKEN" ]; then
  TOKEN_FILE="${HOME}/.openclaw/workspace/.gateway-token"
  if [ ! -s "$TOKEN_FILE" ]; then
    mkdir -p "$(dirname "$TOKEN_FILE")"
    node -e 'process.stdout.write(require("crypto").randomBytes(20).toString("hex"))' > "$TOKEN_FILE"
    chmod 0600 "$TOKEN_FILE"
  fi
  GATEWAY_TOKEN=$(cat "$TOKEN_FILE")
fi

# Patch config from template — jq seeds template defaults + secrets in one
# fast pass. HA + GCal credentials are NOT in openclaw.json: the `ha` and
# `gcal` helper CLIs (mounted at /opt/memex/bin/) fetch them directly
# from Secrets Manager via the EC2 IAM role at call time.
TELEGRAM_TOKEN=$(cat /run/secrets/telegram-bot-token.txt)
jq \
  --arg telegram_token "$TELEGRAM_TOKEN" \
  --arg gateway_token "$GATEWAY_TOKEN" \
  '.channels.telegram.botToken = $telegram_token | .gateway.auth.token = $gateway_token' \
  /app/config.template.json > "${HOME}/.openclaw/openclaw.json"

# Re-stamp every secret-bearing field via openclaw's own writer so the
# resulting file carries the audit-meta the gateway expects on the next
# observe. Without this, gateway boot detects "missing-meta-vs-last-good",
# clobbers our file, and regenerates the token — invalidating every cached
# browser session and breaking dashboard access until manually re-paired.
openclaw config set channels.telegram.botToken "$TELEGRAM_TOKEN" >/dev/null
openclaw config set gateway.auth.token "$GATEWAY_TOKEN" >/dev/null

# Tell openclaw where to find memex on the docker-internal network
export BRAIN_URL="http://memex:18790"

# Gateway invocation: --bind/--port/--auth come from config (gateway.bind=lan
# binds to all interfaces inside the container so the cloudflared sidecar
# can reach openclaw via http://openclaw:18789).
exec openclaw gateway

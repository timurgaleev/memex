#!/bin/bash
# telegram-bridge entrypoint — verifies the runtime contract before
# handing off to the Python daemon.
set -euo pipefail

: "${AWS_REGION:?AWS_REGION must be set}"
: "${MEMEX_BRIDGE_ALLOWED_CHAT_IDS:?MEMEX_BRIDGE_ALLOWED_CHAT_IDS must be set (comma-separated numeric chat ids)}"

TOKEN_FILE="${TELEGRAM_BOT_TOKEN_FILE:-/run/secrets/telegram-bot-token.txt}"
if [ ! -s "$TOKEN_FILE" ]; then
  echo "FATAL: bot token missing or empty at ${TOKEN_FILE}" >&2
  echo "       Run deploy/secrets/fetch-secrets.sh on the host first." >&2
  exit 1
fi

# The Bedrock-side helpers (gcal/ha) read from Secrets Manager; verify
# the IAM role is in fact reachable before we promise the operator
# anything works. A silent failure here would surface as "bot replies
# 'helper error'" indefinitely.
if ! aws sts get-caller-identity --region "$AWS_REGION" >/dev/null 2>&1; then
  echo "FATAL: aws sts get-caller-identity failed — IAM role not assumable" >&2
  exit 1
fi

exec python3 /app/main.py

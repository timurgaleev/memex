#!/bin/bash
# Run after `openclaw onboard` to apply production config settings.
# Must be run as the openclaw user: sudo -u openclaw bash scripts/post-onboard.sh
#
# Reads ${REPO_DIR:-/opt/memex}/.env for PUBLIC_HOST + AWS_REGION.
set -euo pipefail

REPO_DIR="${REPO_DIR:-/opt/memex}"
if [ -f "${REPO_DIR}/.env" ]; then
  # shellcheck source=/dev/null
  . "${REPO_DIR}/.env"
fi

: "${PUBLIC_HOST:?PUBLIC_HOST must be set (.env not rendered yet? run scripts/bootstrap.sh)}"
: "${AWS_REGION:=eu-west-1}"

echo "=== Applying post-onboard config (public host: ${PUBLIC_HOST}) ==="

# Allow the control UI to be accessed via Cloudflare tunnel
openclaw config set gateway.controlUi.allowedOrigins "[\"https://${PUBLIC_HOST}\"]"

# Trust cloudflared (loopback proxy) for real client IP forwarding
openclaw config set gateway.trustedProxies '["127.0.0.1"]'

# Allow control UI connections without device identity challenge (needed for external access via tunnel)
openclaw config set gateway.controlUi.allowInsecureAuth true

# Telegram: allow all group messages (allowlist with empty list silently drops all)
openclaw config set channels.telegram.groupPolicy open

# Memory search: disable (no embedding provider configured for Bedrock)
openclaw config set agents.defaults.memorySearch.enabled false


# Search: enable DuckDuckGo (no API key needed)
openclaw plugins enable duckduckgo


# Configure Bedrock models via custom provider — bypasses openclaw's internal registry.
# This prevents openclaw from injecting thinking-specific parameters (which cause session
# corruption with Nova Pro). Models defined here are treated as generic bedrock-converse-stream.
AWS_REGION="$AWS_REGION" python3 << 'PYEOF'
import json, os
cfg_path = os.path.expanduser('~/.openclaw/openclaw.json')
aws_region = os.environ.get('AWS_REGION', 'eu-west-1')
with open(cfg_path) as f:
    cfg = json.load(f)

models = cfg.setdefault('models', {})
# bedrockDiscovery was removed from the openclaw schema. models.mode='replace'
# with an explicit provider list below is now the only way to prevent Bedrock
# auto-discovery from flooding the picker. Keeping the old key would make the
# gateway crash with "Unrecognized key: bedrockDiscovery" on boot.
models.pop('bedrockDiscovery', None)
models['mode'] = 'replace'
models.setdefault('providers', {})['amazon-bedrock'] = {
    "baseUrl": f"https://bedrock-runtime.{aws_region}.amazonaws.com",
    "api": "bedrock-converse-stream",
    "auth": "aws-sdk",
    "models": [
        # nova-2-lite is PRIMARY — no thinking blocks, correct session replay behavior
        {"id": "global.amazon.nova-2-lite-v1:0", "name": "Nova 2 Lite", "input": ["text","image"], "contextWindow": 200000, "maxTokens": 8192},
        # nova-pro is FALLBACK only — generates thinking blocks that corrupt openclaw session history
        {"id": "eu.amazon.nova-pro-v1:0",         "name": "Nova Pro",   "input": ["text","image"], "contextWindow": 200000, "maxTokens": 8192},
        {"id": "eu.amazon.nova-lite-v1:0",         "name": "Nova Lite",  "input": ["text","image"], "contextWindow": 300000, "maxTokens": 5120},
        {"id": "eu.amazon.nova-micro-v1:0",        "name": "Nova Micro", "input": ["text"],         "contextWindow": 128000, "maxTokens": 5120},
    ]
}

agents = cfg.setdefault('agents', {}).setdefault('defaults', {})
# IMPORTANT: nova-2-lite must be primary. Nova Pro generates thinking blocks that
# cause "User messages cannot contain reasoning content" errors in openclaw.
agents['model'] = {
    'primary': 'amazon-bedrock/global.amazon.nova-2-lite-v1:0',
    'fallbacks': ['amazon-bedrock/eu.amazon.nova-pro-v1:0']
}
agents.pop('thinkingDefault', None)
# Restrict model picker — only 4 models shown, not the full Bedrock catalog
agents['models'] = {
    'amazon-bedrock/global.amazon.nova-2-lite-v1:0': {},
    'amazon-bedrock/eu.amazon.nova-pro-v1:0': {},
    'amazon-bedrock/eu.amazon.nova-lite-v1:0': {},
    'amazon-bedrock/eu.amazon.nova-micro-v1:0': {},
}

with open(cfg_path, 'w') as f:
    json.dump(cfg, f, indent=2)
print('Model provider configured: global.amazon.nova-2-lite-v1:0 (primary), eu.amazon.nova-pro-v1:0 (fallback)')
PYEOF

echo "Active models:"
openclaw models list 2>&1 | head -5

echo ""
echo "=== Config updated. Restart openclaw to apply: ==="
echo "  sudo systemctl restart openclaw"
echo "  sudo systemctl start cloudflared"
echo ""
echo "=== Device pairing note ==="
echo "First connection from each new browser needs one-time approval:"
echo "  openclaw devices list"
echo "  openclaw devices approve <request-id>"

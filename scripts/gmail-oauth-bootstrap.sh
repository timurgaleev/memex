#!/bin/bash
# One-shot wrapper around scripts/gmail-oauth-bootstrap.py.
#
# Modern macOS / Linux Pythons block `pip install` against the system
# Python (PEP 668: externally-managed-environment). This wrapper
# bootstraps a project-private virtualenv at ~/.openclaw-py, installs
# the two deps, and invokes the bootstrap script — one command instead
# of remembering the venv dance.
#
# Usage:
#     AWS_PROFILE=bedrock ./scripts/gmail-oauth-bootstrap.sh
#
# Override the venv location with OPENCLAW_PY_VENV=path if you'd
# rather not use ~/.openclaw-py.

set -euo pipefail

VENV="${OPENCLAW_PY_VENV:-$HOME/.openclaw-py}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PY_SCRIPT="$SCRIPT_DIR/gmail-oauth-bootstrap.py"

if [[ ! -f "$PY_SCRIPT" ]]; then
  echo "error: $PY_SCRIPT not found — run from a fresh clone of the openclaw repo" >&2
  exit 1
fi

if [[ -z "${AWS_PROFILE:-}" && -z "${AWS_ACCESS_KEY_ID:-}" ]]; then
  echo "warning: AWS_PROFILE not set — boto3 will fall back to the default profile" >&2
fi

# Resolve a python3 — prefer brew's openssl-aware build if present.
if command -v python3 >/dev/null 2>&1; then
  PY="python3"
else
  echo "error: python3 not on PATH — install via 'brew install python' first" >&2
  exit 1
fi

if [[ ! -d "$VENV" ]]; then
  echo "[bootstrap] creating venv at $VENV"
  "$PY" -m venv "$VENV"
fi

# Always re-run pip install — it's idempotent if deps are already current.
echo "[bootstrap] ensuring deps in venv"
"$VENV/bin/pip" install --quiet --upgrade google-auth-oauthlib boto3

echo "[bootstrap] running OAuth flow — browser will open"
exec "$VENV/bin/python" "$PY_SCRIPT"

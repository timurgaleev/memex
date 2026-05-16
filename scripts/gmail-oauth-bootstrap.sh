#!/bin/bash
# One-shot wrapper around scripts/gmail-oauth-bootstrap.py.
#
# Modern macOS / Linux Pythons block `pip install` against the system
# Python (PEP 668: externally-managed-environment). This wrapper
# bootstraps a project-private virtualenv at ~/.memex-py, installs the
# two deps, and invokes the bootstrap script.
#
# Usage:
#     AWS_REGION=<region> AWS_PROFILE=<your-profile> \
#       ./scripts/gmail-oauth-bootstrap.sh
#
# Override the venv location with MEMEX_PY_VENV=path.

set -euo pipefail

VENV="${MEMEX_PY_VENV:-$HOME/.memex-py}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PY_SCRIPT="$SCRIPT_DIR/gmail-oauth-bootstrap.py"

if [[ ! -f "$PY_SCRIPT" ]]; then
  echo "error: $PY_SCRIPT not found — run from a fresh clone of the memex repo" >&2
  exit 1
fi

if [[ -z "${AWS_REGION:-${AWS_DEFAULT_REGION:-}}" ]]; then
  echo "error: AWS_REGION (or AWS_DEFAULT_REGION) must be set" >&2
  exit 1
fi

if [[ -z "${AWS_PROFILE:-}" && -z "${AWS_ACCESS_KEY_ID:-}" ]]; then
  echo "warning: AWS_PROFILE not set — boto3 will fall back to the default profile" >&2
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "error: python3 not on PATH — install via 'brew install python' first" >&2
  exit 1
fi

if [[ ! -d "$VENV" ]]; then
  echo "[bootstrap] creating venv at $VENV"
  python3 -m venv "$VENV"
fi

echo "[bootstrap] ensuring deps in venv"
"$VENV/bin/pip" install --quiet --upgrade google-auth-oauthlib boto3

echo "[bootstrap] running OAuth flow — browser will open"
exec "$VENV/bin/python" "$PY_SCRIPT"

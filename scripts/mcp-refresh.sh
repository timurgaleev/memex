#!/bin/bash
# Refresh the local Claude Code registration of the memex MCP server with the
# current public bearer.
#
# The server-side bearer rotates daily (see rotate-memex-public-bearer.sh), so
# a client that registered yesterday's token gets 401s. This pulls the current
# token from Secrets Manager and re-registers the MCP server in one shot — run
# it when you start a work session, or whenever a memex MCP call returns 401.
# Keeps the strong daily rotation; just removes the manual re-register step.
#
# Runs on the OPERATOR'S machine (where Claude Code is installed), NOT on the
# host. The token is never printed, never written to shell history, and is
# fetched fresh from Secrets Manager on every run.
#
# Env contract:
#   MEMEX_MCP_URL        required — the brain MCP endpoint (e.g. https://<host>/mcp)
# Optional knobs:
#   MEMEX_SECRETS_PREFIX secret prefix (default: memex) → <prefix>/memex-public-bearer
#   MEMEX_MCP_NAME       MCP server name to register (default: memex)
#   MEMEX_MCP_SCOPE      registration scope (default: user — all projects)
#   AWS_PROFILE          passed to aws if set
#   AWS_REGION           passed to aws if set
#
# Suggested alias (add to ~/.zshrc, set the URL to your brain endpoint):
#   alias mcpr='MEMEX_MCP_URL="https://<your-brain-host>/mcp" AWS_PROFILE=<profile> ~/path/to/memex/scripts/mcp-refresh.sh'

set -euo pipefail

NAME="${MEMEX_MCP_NAME:-memex}"
PREFIX="${MEMEX_SECRETS_PREFIX:-memex}"
SECRET_ID="${PREFIX}/memex-public-bearer"
# Register at USER scope so the server is available across all projects, not
# just the cwd (`claude mcp add` defaults to local/project scope). Override
# with MEMEX_MCP_SCOPE if you really want a project-local registration.
SCOPE="${MEMEX_MCP_SCOPE:-user}"

log() { printf '[mcp-refresh] %s\n' "$*" >&2; }

if [ -z "${MEMEX_MCP_URL:-}" ]; then
  log "ERROR: MEMEX_MCP_URL is not set (the brain MCP endpoint, e.g. https://<host>/mcp)."
  exit 2
fi
for bin in aws claude; do
  command -v "$bin" >/dev/null 2>&1 || { log "ERROR: '$bin' not found on PATH."; exit 2; }
done

# Build optional aws flags without leaking empties.
AWS_FLAGS=()
[ -n "${AWS_PROFILE:-}" ] && AWS_FLAGS+=(--profile "$AWS_PROFILE")
[ -n "${AWS_REGION:-}" ] && AWS_FLAGS+=(--region "$AWS_REGION")

log "fetching current bearer from Secrets Manager (${SECRET_ID})…"
# Capture into a variable so the token never hits disk or the process table
# of a separate command. Quote-safe; no `set -x` anywhere in this script.
# `${arr[@]+"${arr[@]}"}` expands to nothing when the array is empty — the
# bash 3.2 (macOS default) + `set -u` safe form (a bare "${arr[@]}" would
# trip "unbound variable" on an empty array).
TOKEN="$(aws ${AWS_FLAGS[@]+"${AWS_FLAGS[@]}"} secretsmanager get-secret-value \
  --secret-id "$SECRET_ID" --query SecretString --output text)"
if [ -z "$TOKEN" ] || [ "$TOKEN" = "None" ]; then
  log "ERROR: empty bearer from ${SECRET_ID} (check AWS auth / secret name)."
  exit 1
fi

# Re-register: remove the stale entry (ignore if absent), then add fresh.
# Suppress BOTH streams on the add: on error `claude` may echo the invocation
# (including the --header bearer) to stderr, so we never surface its output —
# print a generic failure instead. (The token is necessarily passed to
# `claude mcp add` via --header and persisted by it to ~/.claude.json at 0600;
# that is the standard MCP-registration model, not introduced here. On a
# single-user workstation argv is visible only to the same user + root.)
claude mcp remove "$NAME" --scope "$SCOPE" >/dev/null 2>&1 || true
if ! claude mcp add --scope "$SCOPE" --transport http "$NAME" "$MEMEX_MCP_URL" \
  --header "Authorization: Bearer ${TOKEN}" >/dev/null 2>&1; then
  unset TOKEN
  log "ERROR: 'claude mcp add' failed (check: claude logged in? URL reachable?)."
  exit 1
fi

unset TOKEN
log "ok: '${NAME}' re-registered at ${SCOPE} scope with the current bearer (${MEMEX_MCP_URL})."

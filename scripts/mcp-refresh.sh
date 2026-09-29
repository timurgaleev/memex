#!/bin/bash
# Refresh the local Claude Code registration of the memrain MCP server with the
# current public bearer.
#
# The server-side bearer rotates daily (see rotate-memrain-public-bearer.sh), so
# a client that registered yesterday's token gets 401s. This pulls the current
# token from Secrets Manager and re-registers the MCP server in one shot — run
# it when you start a work session, or whenever a memrain MCP call returns 401.
# Keeps the strong daily rotation; just removes the manual re-register step.
#
# Runs on the OPERATOR'S machine (where Claude Code is installed), NOT on the
# host. The token is never printed, never written to shell history, and is
# fetched fresh from Secrets Manager on every run.
#
# Env contract (each MEMRAIN_* name falls back to its legacy MEMEX_* name):
#   MEMRAIN_MCP_URL        required — the brain MCP endpoint (e.g. https://<host>/mcp)
#   AWS_REGION             required — region the stack's secrets live in
# Optional knobs:
#   MEMRAIN_SECRETS_PREFIX secret prefix (default: memex) → <prefix>/memrain-public-bearer,
#                          then <prefix>/memex-public-bearer
#   PUBLIC_BEARER_SECRET_NAME  full secret id of the bearer; replaces the lookup above
#   MEMRAIN_MCP_NAME       MCP server name to register (default: memrain; an
#                          existing `memex` registration is left in place)
#   MEMRAIN_MCP_SCOPE      registration scope (default: user — all projects)
#   AWS_PROFILE            passed to aws if set
#
# Suggested alias (add to ~/.zshrc, set URL/region/profile to your deploy):
#   alias mcpr='MEMRAIN_MCP_URL="https://<your-brain-host>/mcp" AWS_REGION=<region> AWS_PROFILE=<profile> ~/path/to/memrain/scripts/mcp-refresh.sh'

set -euo pipefail

MCP_URL="${MEMRAIN_MCP_URL:-${MEMEX_MCP_URL:-}}"
NAME="${MEMRAIN_MCP_NAME:-${MEMEX_MCP_NAME:-}}"
NAME_DEFAULTED=0
if [ -z "$NAME" ]; then
  NAME=memrain
  NAME_DEFAULTED=1
fi
# Read by secret_id_for (deploy/secrets/lib.sh, sourced below).
# shellcheck disable=SC2034
SECRETS_PREFIX="${MEMRAIN_SECRETS_PREFIX:-${MEMEX_SECRETS_PREFIX:-memex}}"
# Register at USER scope so the server is available across all projects, not
# just the cwd (`claude mcp add` defaults to local/project scope). Override
# with MEMRAIN_MCP_SCOPE if you really want a project-local registration.
SCOPE="${MEMRAIN_MCP_SCOPE:-${MEMEX_MCP_SCOPE:-user}}"

log() { printf '[mcp-refresh] %s\n' "$*" >&2; }

if [ -z "$MCP_URL" ]; then
  log "ERROR: MEMRAIN_MCP_URL is not set (the brain MCP endpoint, e.g. https://<host>/mcp)."
  exit 2
fi
for bin in aws claude; do
  command -v "$bin" >/dev/null 2>&1 || { log "ERROR: '$bin' not found on PATH."; exit 2; }
done

# The secret lives in ONE region (where the stack is deployed). Without an
# explicit region the AWS CLI falls back to the profile default, which on a
# multi-region account silently looks in the wrong region and reports
# ResourceNotFoundException. Require it up front instead.
if [ -z "${AWS_REGION:-}" ]; then
  log "ERROR: AWS_REGION is not set (the region the stack's secrets live in)."
  exit 2
fi

# Build optional aws flags without leaking empties.
AWS_FLAGS=(--region "$AWS_REGION")
[ -n "${AWS_PROFILE:-}" ] && AWS_FLAGS+=(--profile "$AWS_PROFILE")

# The same resolution fetch-secrets.sh and the rotation script use, so this
# reads the secret the server actually serves.
# shellcheck source=/dev/null
. "$(cd "$(dirname "$0")/.." && pwd)/deploy/secrets/lib.sh"
if ! SECRET_ID="$(secret_id_for public-bearer)"; then
  log "ERROR: cannot resolve the public bearer secret (check AWS auth / secret name)."
  exit 1
fi

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
if ! claude mcp add --scope "$SCOPE" --transport http "$NAME" "$MCP_URL" \
  --header "Authorization: Bearer ${TOKEN}" >/dev/null 2>&1; then
  unset TOKEN
  log "ERROR: 'claude mcp add' failed (check: claude logged in? URL reachable?)."
  exit 1
fi

unset TOKEN
log "ok: '${NAME}' re-registered at ${SCOPE} scope with the current bearer (${MCP_URL})."

# The default name changed with the rename. A registration under the old name
# is never removed here: it may carry a different credential the operator
# still uses. Output is discarded, since `claude mcp get` prints headers.
if [ "$NAME_DEFAULTED" -eq 1 ] && claude mcp get memex >/dev/null 2>&1; then
  log "note: an MCP server named 'memex' is still registered and was left as is."
  log "      Remove it yourself once '${NAME}' works: claude mcp remove memex --scope <its scope>"
fi

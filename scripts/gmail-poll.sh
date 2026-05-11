#!/usr/bin/env bash
# Hourly trigger for the Gmail recipe. Runs `memex gmail poll` inside
# the running memex container and logs the JSON result line for ops.
#
# The recipe itself handles quiet-hours (06:00–08:00 Berlin via
# `throttle.preflight`), dedup (recipe_state KV), retries (jobs queue
# pattern even when invoked from CLI), and Bedrock cost control
# (max 50 messages × Nova Lite Converse + Titan v2).
#
# Wired in by `deploy/systemd/memex-gmail-poll.{service,timer}`.

set -euo pipefail

CONTAINER="deploy-memex-1"
MAX="${MEMEX_GMAIL_POLL_MAX:-50}"
SINCE="${MEMEX_GMAIL_POLL_SINCE_HOURS:-24}"

# Refuse silently if the container isn't running. systemd will surface
# the non-zero exit so the next `journalctl` shows the cause.
if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "[gmail-poll] $CONTAINER not running — skipping"
  exit 0
fi

# bun is the entrypoint; CLI lives at /app/src/cli.ts.
docker exec -w /app "$CONTAINER" \
  bun run src/cli.ts gmail poll \
    --max "$MAX" \
    --since "$SINCE"

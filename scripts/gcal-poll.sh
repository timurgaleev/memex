#!/usr/bin/env bash
# Hourly trigger for the GCal recipe. Runs `memex gcal poll` inside
# the running memex container and logs the JSON result line for ops.
#
# The recipe itself handles quiet-hours (06:00–08:00 Berlin via
# `throttle.preflight`), dedup (recipe_state KV keyed on
# `<calendarId>:<eventId>:<updated>`), and Bedrock cost control
# (max 200 events × Nova Lite Converse + Titan v2).
#
# Wired in by `deploy/systemd/memex-gcal-poll.{service,timer}`.

set -euo pipefail

CONTAINER="deploy-memex-1"
HORIZON="${MEMEX_GCAL_POLL_HORIZON:-7}"
MAX="${MEMEX_GCAL_POLL_MAX:-200}"

# Refuse silently if the container isn't running. systemd will surface
# the non-zero exit so the next `journalctl` shows the cause.
if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "[gcal-poll] $CONTAINER not running — skipping"
  exit 0
fi

# bun is the entrypoint; CLI lives at /app/src/cli.ts.
docker exec -w /app "$CONTAINER" \
  bun run src/cli.ts gcal poll \
    --horizon-days "$HORIZON" \
    --max "$MAX"

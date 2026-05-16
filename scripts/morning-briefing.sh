#!/bin/bash
# Compose and deliver a morning briefing to the configured Telegram
# chat. Pulled by the `memex-morning-briefing.timer` systemd unit at
# 07:00 Europe/Berlin daily.
#
# Design constraint: the script MUST produce a delivered message even
# when most ingredients fail (HA down, openclaw container restarting,
# a single helper crashing). Every helper invocation is wrapped so a
# non-zero exit becomes a "—"/"unknown" string rather than aborting
# the whole pipeline.
#
# Env contract (sourced from ${REPO_DIR}/.env, or set by the systemd
# unit via Environment=):
#   AWS_REGION              required
#   SECRETS_PREFIX          defaults to memex
#   MEMEX_BRIEFING_CHAT_ID  numeric Telegram chat id to deliver to
#   MEMEX_BRIEFING_CONTAINER  openclaw container (default deploy-openclaw-1)
#   MEMEX_BRIEFING_BIN_DIR    helper bin path (default /opt/memex/bin)
#
# We intentionally DO NOT set `set -e` — a failing helper must not
# kill the whole briefing. Each step uses explicit error handling so
# the script's exit-code reflects only the final Telegram delivery.
set -uo pipefail

REPO_DIR="${REPO_DIR:-/opt/memex}"

# Source .env safely: only KEY=value lines, no arbitrary shell.
# Plain `. "${REPO_DIR}/.env"` would execute any command in the file
# and run as root — group-writable .env would be privilege escalation.
if [ -f "${REPO_DIR}/.env" ]; then
  while IFS= read -r line; do
    case "$line" in
      ''|\#*) continue ;;
      [A-Za-z_][A-Za-z0-9_]*=*) export "$line" ;;
    esac
  done < "${REPO_DIR}/.env"
fi

# .env carries `AWS_PROFILE=default` for the container-side workflow,
# but the host root user running this systemd unit has no
# /root/.aws/config — the SDK would then 1/FAILURE with "config
# profile (default) could not be found". Clear AWS_PROFILE so the
# AWS SDK falls back to IMDSv2 + the EC2 instance role.
unset AWS_PROFILE

: "${AWS_REGION:?AWS_REGION must be set}"
: "${MEMEX_BRIEFING_CHAT_ID:?MEMEX_BRIEFING_CHAT_ID must be set (Telegram chat id)}"
SECRETS_PREFIX="${SECRETS_PREFIX:-memex}"
CONTAINER="${MEMEX_BRIEFING_CONTAINER:-deploy-openclaw-1}"
BIN="${MEMEX_BRIEFING_BIN_DIR:-/opt/memex/bin}"

# Wait briefly for the openclaw container to be ready (the systemd
# unit runs After=docker.service but docker being up != the container
# being ready). Give it 30s post-boot.
for _ in 1 2 3 4 5 6; do
  if docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true; then
    break
  fi
  sleep 5
done

# helper: run an HA fetch via the in-container helper, return JSON or
# the literal string `{}` so downstream python parsing doesn't crash.
ha_get() {
  docker exec "$CONTAINER" "$BIN/ha" get "$1" 2>/dev/null || echo '{}'
}

# helper: extract a JSON field via python, with a default on any error.
json_field() {
  local default="$1"; shift
  python3 -c "
import sys,json
try:
  d=json.load(sys.stdin)
  $@
except Exception:
  print('$default')
"
}

# ---------------------------------------------------------------------------
# Gather ingredients
# ---------------------------------------------------------------------------
DATE="$(date '+%A, %-d %B')"

W=$(ha_get /api/states/weather.home)
TEMP=$(printf '%s' "$W" | json_field "—" "print(int(round(d['attributes']['temperature'])))")
COND_RAW=$(printf '%s' "$W" | json_field "weather unavailable" "print(d['state'])")
COND=$(printf '%s' "$COND_RAW" | sed -e 's/partlycloudy/partly cloudy/' -e 's/clearnight/clear/' -e 's/-/ /g')

case "$COND" in
  *cloud*)             ICON="☁️" ;;
  *rain*|*drizzle*)    ICON="🌧" ;;
  *sun*|*clear*)       ICON="☀️" ;;
  *snow*)              ICON="🌨" ;;
  *fog*|*mist*)        ICON="🌫" ;;
  *storm*|*thunder*)   ICON="⛈" ;;
  *)                   ICON="🌤" ;;
esac

# Vibe phrasing keyed to the temp band. Guard against the "—" fallback
# arithmetic-comparing — that would error under `pipefail` if not
# isolated. Nested if avoids the chained `-le` against a string.
if [ "$TEMP" = "—" ]; then
  VIBE="dress for the day"
else
  if   [ "$TEMP" -le 0 ];  then VIBE="bundle up — properly"
  elif [ "$TEMP" -le 5 ];  then VIBE="bundle up"
  elif [ "$TEMP" -le 12 ]; then VIBE="jacket weather"
  elif [ "$TEMP" -le 20 ]; then VIBE="sweater is fine"
  elif [ "$TEMP" -le 27 ]; then VIBE="go light"
  else                          VIBE="bring water"
  fi
fi

HOMEG=$(ha_get /api/states/group.family_persons | json_field unknown "print(d['state'])")
DOORS=$(ha_get /api/states/group.doors           | json_field unknown "print(d['state'])")
LEAKS=$(ha_get /api/states/group.water_leak_sensors | json_field unknown "print(d['state'])")

# Calendar — same defensive pattern as HA.
CAL=$(docker exec "$CONTAINER" "$BIN/gcal" today 2>/dev/null \
  | sed -n '/Today/,$p' | tail -n +2 | head -3 | sed 's/^[[:space:]]*//' || echo)
if [ -z "$CAL" ] || echo "$CAL" | grep -qi "no events"; then
  CAL="Calendar is clear — the day is yours."
fi

if [ "$DOORS" = off ] && [ "$LEAKS" = off ]; then
  HOUSE="House is settled."
elif [ "$LEAKS" = on ]; then
  HOUSE="⚠️ Water leak alert — go check."
elif [ "$DOORS" = on ]; then
  HOUSE="Heads up — a door or window is open."
else
  HOUSE="House sensors offline."
fi

if   [ "$HOMEG" = home ];     then PRESENCE="Everyone home."
elif [ "$HOMEG" = not_home ]; then PRESENCE="Everyone out."
else                               PRESENCE="Mixed: $HOMEG."
fi

# ---------------------------------------------------------------------------
# Compose
# ---------------------------------------------------------------------------
MSG=$(cat <<MSG_EOF
🗓 ${DATE}

${ICON} ${TEMP}°C, ${COND} — ${VIBE}.
🏠 ${PRESENCE} ${HOUSE}
📅 ${CAL}
MSG_EOF
)

# ---------------------------------------------------------------------------
# Deliver
# ---------------------------------------------------------------------------
# Fetch the bot token; surface a clear log line and a non-zero exit
# if the IAM role can't read it (systemd will mark the unit failed
# rather than silently skip a day).
if ! TG=$(aws secretsmanager get-secret-value \
            --secret-id "${SECRETS_PREFIX}/telegram-bot-token" \
            --region "$AWS_REGION" \
            --query SecretString --output text 2>&1); then
  echo "[briefing] FATAL: cannot fetch telegram-bot-token: $TG" >&2
  exit 1
fi

# Retry on transient Telegram 5xx / 429 — Telegram routinely throttles
# bots; one transient hiccup must not cost a day's briefing.
if curl -fsS \
     --retry 3 --retry-delay 5 --retry-all-errors \
     --max-time 30 \
     -X POST "https://api.telegram.org/bot${TG}/sendMessage" \
     --data-urlencode "chat_id=${MEMEX_BRIEFING_CHAT_ID}" \
     --data-urlencode "text=${MSG}" \
     >/dev/null 2>&1; then
  echo "[briefing] delivered"
else
  echo "[briefing] delivery failed after retries" >&2
  exit 1
fi

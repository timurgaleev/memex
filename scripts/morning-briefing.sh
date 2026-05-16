#!/bin/bash
# Compose and deliver a morning briefing to the configured Telegram
# chat. Pulled by the `memex-morning-briefing.timer` systemd unit at
# 07:00 Europe/Berlin daily.
#
# Sources:
#   weather + house state → Home Assistant via /opt/memex/bin/ha
#   calendar             → Google Calendar via /opt/memex/bin/gcal
#   delivery             → Telegram Bot API directly (so the openclaw
#                          gateway pairing scope is not on the critical
#                          path — the briefing fires even if the chat
#                          surface is being re-paired)
#
# Env (sourced from ${REPO_DIR}/.env when run directly; the systemd
# unit sets them explicitly via Environment= lines):
#   AWS_REGION           required
#   SECRETS_PREFIX       defaults to memex
#   MEMEX_BRIEFING_CHAT_ID  numeric Telegram chat id to deliver to
#   MEMEX_BRIEFING_CONTAINER  openclaw container name (default deploy-openclaw-1)
#   MEMEX_BRIEFING_BIN_DIR    helper bin path (default /opt/memex/bin)
set -euo pipefail

REPO_DIR="${REPO_DIR:-/opt/memex}"
if [ -f "${REPO_DIR}/.env" ]; then
  # shellcheck source=/dev/null
  . "${REPO_DIR}/.env"
fi

: "${AWS_REGION:?AWS_REGION must be set}"
: "${MEMEX_BRIEFING_CHAT_ID:?MEMEX_BRIEFING_CHAT_ID must be set (Telegram chat id)}"
SECRETS_PREFIX="${SECRETS_PREFIX:-memex}"
CONTAINER="${MEMEX_BRIEFING_CONTAINER:-deploy-openclaw-1}"
BIN="${MEMEX_BRIEFING_BIN_DIR:-/opt/memex/bin}"

# ---------------------------------------------------------------------------
# Gather ingredients
# ---------------------------------------------------------------------------
DATE="$(date '+%A, %-d %B')"

W=$(docker exec "$CONTAINER" "$BIN/ha" get /api/states/weather.home 2>/dev/null || echo '{}')
TEMP=$(echo "$W" | python3 -c "import sys,json
try:
  d=json.load(sys.stdin)
  print(int(round(d['attributes']['temperature'])))
except Exception:
  print('—')")
COND=$(echo "$W" | python3 -c "import sys,json
try:
  s=json.load(sys.stdin)['state']
  print(s.replace('partlycloudy','partly cloudy').replace('clearnight','clear').replace('-',' '))
except Exception:
  print('weather unavailable')")

case "$COND" in
  *cloud*)        ICON="☁️" ;;
  *rain*|*drizzle*) ICON="🌧" ;;
  *sun*|*clear*)  ICON="☀️" ;;
  *snow*)         ICON="🌨" ;;
  *fog*|*mist*)   ICON="🌫" ;;
  *storm*|*thunder*) ICON="⛈" ;;
  *)              ICON="🌤" ;;
esac

if   [ "$TEMP" = "—" ] 2>/dev/null; then VIBE="dress for the day"
elif [ "$TEMP" -le 0 ]  2>/dev/null; then VIBE="bundle up — properly"
elif [ "$TEMP" -le 5 ]  2>/dev/null; then VIBE="bundle up"
elif [ "$TEMP" -le 12 ] 2>/dev/null; then VIBE="jacket weather"
elif [ "$TEMP" -le 20 ] 2>/dev/null; then VIBE="sweater is fine"
elif [ "$TEMP" -le 27 ] 2>/dev/null; then VIBE="go light"
else                                      VIBE="bring water"
fi

HOMEG=$(docker exec "$CONTAINER" "$BIN/ha" get /api/states/group.family_persons 2>/dev/null \
  | python3 -c "import sys,json
try: print(json.load(sys.stdin)['state'])
except Exception: print('unknown')")

DOORS=$(docker exec "$CONTAINER" "$BIN/ha" get /api/states/group.doors 2>/dev/null \
  | python3 -c "import sys,json
try: print(json.load(sys.stdin)['state'])
except Exception: print('unknown')")

LEAKS=$(docker exec "$CONTAINER" "$BIN/ha" get /api/states/group.water_leak_sensors 2>/dev/null \
  | python3 -c "import sys,json
try: print(json.load(sys.stdin)['state'])
except Exception: print('unknown')")

CAL=$(docker exec "$CONTAINER" "$BIN/gcal" today 2>/dev/null \
  | sed -n '/Today/,$p' | tail -n +2 | head -3 | sed 's/^[[:space:]]*//')
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

if [ "$HOMEG" = home ]; then PRESENCE="Everyone home."
elif [ "$HOMEG" = not_home ]; then PRESENCE="Everyone out."
else PRESENCE="Mixed: $HOMEG."
fi

# ---------------------------------------------------------------------------
# Compose + deliver
# ---------------------------------------------------------------------------
MSG=$(cat <<MSG_EOF
🗓 ${DATE}

${ICON} ${TEMP}°C, ${COND} — ${VIBE}.
🏠 ${PRESENCE} ${HOUSE}
📅 ${CAL}
MSG_EOF
)

TG=$(aws secretsmanager get-secret-value \
  --secret-id "${SECRETS_PREFIX}/telegram-bot-token" \
  --region "$AWS_REGION" \
  --query SecretString --output text)

curl -fsS --max-time 15 \
  -X POST "https://api.telegram.org/bot${TG}/sendMessage" \
  --data-urlencode "chat_id=${MEMEX_BRIEFING_CHAT_ID}" \
  --data-urlencode "text=${MSG}" \
  >/dev/null && echo "[briefing] delivered" || echo "[briefing] delivery failed"

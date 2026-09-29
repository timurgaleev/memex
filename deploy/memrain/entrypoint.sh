#!/bin/sh
# memex container entrypoint.
# 1. Idempotently init the config. Backend follows the environment:
#    MEMRAIN_POSTGRES_URL (or the legacy MEMEX_POSTGRES_URL) set -> postgres
#    (heals a stale pglite config too — otherwise the env URL is silently
#    ignored and the brain runs on the local dev database while the real
#    Postgres sits empty);
#    unset and MEMRAIN_REQUIRE_POSTGRES=1 -> refuse to start (exit 78), so a
#    lost secret can never bring the service up on an empty PGLite brain;
#    unset otherwise -> pglite (writes the config + brain.pglite if missing).
# 2. exec serve. PID 1 is bun so signals reach it cleanly.
set -eu

PG_URL="${MEMRAIN_POSTGRES_URL:-${MEMEX_POSTGRES_URL:-}}"
REQUIRE="${MEMRAIN_REQUIRE_POSTGRES:-${MEMEX_REQUIRE_POSTGRES:-}}"

if [ -f "${HOME:-}/.memrain/config.json" ] && grep -q '/home/bun/\.memex/' "${HOME}/.memrain/config.json"; then
  echo "[memrain] WARN: ${HOME}/.memrain/config.json still references /home/bun/.memex/ paths; they resolve through the compat mount" >&2
fi

if [ -n "$PG_URL" ]; then
  export MEMRAIN_POSTGRES_URL="$PG_URL"
  bun run src/cli.ts init --postgres
elif [ "$REQUIRE" = "1" ]; then
  echo "[memrain] FATAL: MEMRAIN_REQUIRE_POSTGRES=1 but no Postgres URL; refusing to start on PGLite" >&2
  exit 78
else
  bun run src/cli.ts init --pglite
fi

exec bun run src/cli.ts serve --http --host 0.0.0.0 --port 18790

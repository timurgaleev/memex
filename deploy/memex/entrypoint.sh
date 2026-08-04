#!/bin/sh
# memex container entrypoint.
# 1. Idempotently init the config. Backend follows the environment:
#    MEMEX_POSTGRES_URL set -> postgres (heals a stale pglite config too —
#    otherwise the env URL is silently ignored and the brain runs on the
#    local dev database while the real Postgres sits empty);
#    unset -> pglite (writes ~/.memex/config.json + brain.pglite if missing).
# 2. exec serve. PID 1 is bun so signals reach it cleanly.
set -eu

if [ -n "${MEMEX_POSTGRES_URL:-}" ]; then
  bun run src/cli.ts init --postgres
else
  bun run src/cli.ts init --pglite
fi

exec bun run src/cli.ts serve --http --host 0.0.0.0 --port 18790

#!/bin/sh
# memex container entrypoint.
# 1. Idempotently `init --pglite` (writes ~/.memex/config.json + brain.pglite if missing).
# 2. exec serve. PID 1 is bun so signals reach it cleanly.
set -eu

bun run src/cli.ts init --pglite

exec bun run src/cli.ts serve --http --host 0.0.0.0 --port 18790

#!/usr/bin/env bash
#
# Run the Postgres-only part of the memex suite against a real Postgres 16
# with pgvector. PGLite serializes transactions, so races and driver-specific
# binding behaviour only show up here.
#
# What it runs, in order:
#   1. every migration, applied to an empty database;
#   2. the migration set applied a second time — it must apply nothing;
#   3. every test file under deploy/memex/tests that reads
#      MEMEX_TEST_POSTGRES_URL (found by grep, so a new *_pg test is picked
#      up without touching this script).
#
# Database:
#   - default: a throwaway pgvector/pgvector:pg16 container on a free
#     loopback port, removed on exit whether the run passed or failed.
#   - MEMEX_TEST_POSTGRES_URL already set: use that database instead and
#     start no container (CI passes a service container this way). It MUST
#     be a scratch database — migrations and tests write to it.
#
# Env:
#   TEST_PG_IMAGE    image for the throwaway container
#                    (default pgvector/pgvector:pg16)
#   TEST_PG_TIMEOUT  seconds to wait for readiness (default 60)
#   TEST_TIMEOUT     per-test timeout in ms passed to bun (default 30000)

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG="$REPO/deploy/memex"
IMAGE="${TEST_PG_IMAGE:-pgvector/pgvector:pg16}"
READY_TIMEOUT="${TEST_PG_TIMEOUT:-60}"
TEST_TIMEOUT="${TEST_TIMEOUT:-30000}"

CONTAINER=""

cleanup() {
  local status=$?
  if [ -n "$CONTAINER" ]; then
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    echo "[test-pg] removed container $CONTAINER"
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

log() { echo "[test-pg] $*"; }
die() { echo "[test-pg] $*" >&2; exit 1; }

start_container() {
  command -v docker >/dev/null 2>&1 || die "docker not found (or set MEMEX_TEST_POSTGRES_URL to a scratch database)"
  local password
  password="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  CONTAINER="memex-test-pg-$$-$RANDOM"
  # Port 0 on the host side: Docker picks a free port, so parallel runs and a
  # developer's own Postgres on 5432 never collide.
  docker run -d --name "$CONTAINER" \
    -e POSTGRES_USER=memex \
    -e POSTGRES_PASSWORD="$password" \
    -e POSTGRES_DB=memex_test \
    -p 127.0.0.1::5432 \
    "$IMAGE" >/dev/null
  local port
  port="$(docker port "$CONTAINER" 5432/tcp | head -n1 | sed 's/.*://')"
  [ -n "$port" ] || die "could not read the published port of $CONTAINER"
  log "container $CONTAINER ($IMAGE) on 127.0.0.1:$port"

  # The image's entrypoint runs a temporary server during initdb that listens
  # on the unix socket only, then restarts. Probing TCP inside the container
  # waits for the real server rather than the init one.
  local waited=0
  until docker exec "$CONTAINER" pg_isready -q -h 127.0.0.1 -U memex -d memex_test >/dev/null 2>&1; do
    [ "$waited" -lt "$READY_TIMEOUT" ] || { docker logs "$CONTAINER" >&2 || true; die "Postgres not ready after ${READY_TIMEOUT}s"; }
    sleep 1
    waited=$((waited + 1))
  done
  log "ready after ${waited}s"
  export MEMEX_TEST_POSTGRES_URL="postgres://memex:${password}@127.0.0.1:${port}/memex_test?sslmode=disable"
}

apply_migrations_twice() {
  # Inline so the check runs the same runMigrations the daemon boots with,
  # against the same engine, without loading any daemon config.
  # shellcheck disable=SC2016 # the TypeScript is meant to reach bun unexpanded
  (cd "$PKG" && bun -e '
    import { PostgresEngine } from "./src/core/engine/postgres.ts";
    import { runMigrations, discoverMigrations } from "./src/core/migrate.ts";
    const engine = new PostgresEngine({ url: process.env.MEMEX_TEST_POSTGRES_URL!, max: 2 });
    try {
      await engine.ready();
      const total = discoverMigrations().length;
      const first = await runMigrations(engine);
      console.log(`[test-pg] first apply: ${first.applied.length} applied, ${first.skipped} skipped, ${total} on disk`);
      if (first.applied.length + first.skipped !== total) throw new Error("first apply did not account for every migration");
      const second = await runMigrations(engine);
      console.log(`[test-pg] second apply: ${second.applied.length} applied, ${second.skipped} skipped`);
      if (second.applied.length !== 0 || second.skipped !== total) {
        throw new Error(`second apply was not a no-op: ${JSON.stringify(second.applied)}`);
      }
    } finally {
      await engine.close();
    }
  ')
}

run_pg_tests() {
  local files=()
  local f
  while IFS= read -r f; do
    files+=("tests/$(basename "$f")")
  done < <(grep -l MEMEX_TEST_POSTGRES_URL "$PKG"/tests/*.test.ts | sort)
  [ "${#files[@]}" -gt 0 ] || die "no test file reads MEMEX_TEST_POSTGRES_URL"
  log "running ${#files[@]} test file(s): ${files[*]}"
  (cd "$PKG" && bun test --timeout "$TEST_TIMEOUT" "${files[@]}")
}

command -v bun >/dev/null 2>&1 || die "bun not found"

if [ -n "${MEMEX_TEST_POSTGRES_URL:-}" ]; then
  log "using MEMEX_TEST_POSTGRES_URL from the environment (no container)"
else
  start_container
fi

apply_migrations_twice
run_pg_tests
log "ok"

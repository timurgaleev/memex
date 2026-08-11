#!/usr/bin/env bash
#
# Run the memex bun suite in fixed-size shards, each a FRESH `bun test`
# process.
#
# Why sharding is mandatory, not an optimisation: every PGLite (WASM
# Postgres) instance a test spins up reserves WASM linear memory that is
# never returned to the OS, even after `storage.close()` — WASM heaps only
# grow. Running all test files in ONE process accumulates that memory until
# PGLite's `pg_initdb` dies with `RangeError: Out of memory`, and every
# later `storage.init()` fails with it. The result is hundreds of phantom
# failures that have nothing to do with the code under test. Sharding bounds
# peak memory to one chunk's worth and resets it between shards.
#
# Chunk SIZE (not a fixed shard count) keeps per-process memory bounded as
# the suite grows.
#
# Env:
#   SHARD_SIZE    test files per bun process (default 20)
#   TEST_TIMEOUT  per-test timeout in ms passed to bun (default 30000)
#   MAX_SECONDS   wall-clock budget for the whole loop; 0 = unlimited
#                 (default 0). Used by the non-gating CI canary to stop
#                 before the job's timeout-minutes cap, which would
#                 otherwise CANCEL the run instead of failing it.
#   TEST_DIR      directory scanned for *.test.ts (default tests)
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 2

SHARD_SIZE="${SHARD_SIZE:-20}"
TEST_TIMEOUT="${TEST_TIMEOUT:-30000}"
MAX_SECONDS="${MAX_SECONDS:-0}"
TEST_DIR="${TEST_DIR:-tests}"

# Group markers fold the per-shard output in the Actions log; plain runs
# would only see the literal text, so emit them only under CI.
group_open() {
  if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::group::$1"; else echo "==> $1"; fi
}
group_close() {
  if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::endgroup::"; fi
}

# Read loop rather than `mapfile`: macOS ships bash 3.2, which has no mapfile
# (it silently yields an empty array), and this script is a local gate, not
# CI-only.
files=()
while IFS= read -r f; do files+=("$f"); done < <(find "${TEST_DIR}" -name '*.test.ts' | sort)
if [ "${#files[@]}" -eq 0 ]; then
  echo "no test files found under ${TEST_DIR}/" >&2
  exit 2
fi
echo "discovered ${#files[@]} test files; shard size ${SHARD_SIZE}"

fail=0
for ((i = 0; i < ${#files[@]}; i += SHARD_SIZE)); do
  slice=("${files[@]:i:SHARD_SIZE}")
  shard=$((i / SHARD_SIZE))
  if [ "${MAX_SECONDS}" -gt 0 ] && [ "${SECONDS}" -ge "${MAX_SECONDS}" ]; then
    echo "::warning::wall-clock budget ${MAX_SECONDS}s reached after ${SECONDS}s; stopping at shard ${shard} (non-gating)"
    break
  fi
  group_open "bun test shard ${shard} (${#slice[@]} files, first: ${slice[0]})"
  if ! bun test --timeout "${TEST_TIMEOUT}" "${slice[@]}"; then
    fail=1
    echo "shard ${shard} FAILED"
  fi
  group_close
done

exit "${fail}"

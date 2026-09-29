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
# Most of a test's cost used to be `Storage.init()` running every migration
# on an empty cluster. The run builds one migrated directory up front
# (scripts/build-test-template.ts, keyed on a hash of the migrations) and
# exports MEMRAIN_TEST_PGLITE_TEMPLATE, so a test's fresh database starts as a
# copy of it. Tests that must watch migrations run opt out in the file.
#
# Env:
#   SHARD_SIZE    test files per bun process (default 20)
#   JOBS          shards run at once (default min(4, cpus/2) locally, 1 under
#                 CI). Each bun process peaks around 1.6 GB, so JOBS=4 needs
#                 ~6.5 GB free. With JOBS>1 a shard's output is buffered and
#                 printed whole when it finishes.
#   TEST_TIMEOUT  per-test timeout in ms passed to bun (default 30000)
#   MAX_SECONDS   wall-clock budget for the whole run; 0 = unlimited
#                 (default 0). A shard that has not started by then is
#                 skipped with a warning, so a job stops before its
#                 timeout-minutes cap instead of being CANCELLED.
#   TEST_DIR      directory scanned for *.test.ts (default tests)
#   TEST_TEMPLATE 0 runs every test against a freshly migrated database
#                 (default 1 = use the template)
#   SHARD_GROUPS  number of parallel workers the suite is split across
#                 (default 1 = this process runs every file)
#   SHARD_GROUP   this worker's index, 0-based (default 0). Files are dealt
#                 longest-first to the least-loaded worker by the seconds in
#                 TIMINGS (a file it does not list counts as the median), so
#                 each worker gets about the same wall time.
#   TIMINGS       per-file seconds, `<file>\t<seconds>` (default
#                 tests/.timings.tsv)
#   CHANGED       a git ref: each shard runs only its files that `bun test
#                 --changed=<ref>` counts as affected (touched since the ref,
#                 or importing something that was). For the edit loop
#                 (`bun run test:changed`); the full run stays the gate.
set -uo pipefail

SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"

# Group markers fold the per-shard output in the Actions log; plain runs
# would only see the literal text, so emit them only under CI.
group_open() {
  if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::group::$1"; else echo "==> $1"; fi
}
group_close() {
  if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::endgroup::"; fi
}

# One shard, run by the xargs fan-out below: `<self> __shard <list file>`.
# Writes the exit status next to the list, so the parent can tell which
# shards failed however xargs folds their statuses.
run_shard() {
  local list="$1" shard files=() f rc
  shard="$(basename "${list}" .list)"
  shard=$((10#${shard}))
  while IFS= read -r f; do files+=("$f"); done < "${list}"
  if [ "${MAX_SECONDS}" -gt 0 ] && [ $(($(date +%s) - RUN_STARTED)) -ge "${MAX_SECONDS}" ]; then
    echo "::warning::wall-clock budget ${MAX_SECONDS}s reached; skipping shard ${shard} (non-gating)"
    echo skipped > "${list%.list}.rc"
    return 0
  fi
  local title="bun test shard ${shard} (${#files[@]} files, first: ${files[0]})"
  local args=(test --timeout "${TEST_TIMEOUT}")
  if [ -n "${CHANGED}" ]; then args+=("--changed=${CHANGED}"); fi
  if [ "${JOBS}" -le 1 ]; then
    group_open "${title}"
    bun "${args[@]}" "${files[@]}"
    rc=$?
  else
    bun "${args[@]}" "${files[@]}" > "${list%.list}.out" 2>&1
    rc=$?
    # mkdir is atomic: one finished shard prints at a time.
    until mkdir "${WORK}/print.lock" 2>/dev/null; do sleep 0.1; done
    group_open "${title}"
    cat "${list%.list}.out"
  fi
  if [ "${rc}" -ne 0 ]; then echo "shard ${shard} FAILED"; fi
  group_close
  [ "${JOBS}" -le 1 ] || rmdir "${WORK}/print.lock"
  echo "${rc}" > "${list%.list}.rc"
  return 0
}

if [ "${1:-}" = "__shard" ]; then
  run_shard "$2"
  exit 0
fi

cd "$(dirname "${SELF}")/.." || exit 2

SHARD_SIZE="${SHARD_SIZE:-20}"
TEST_TIMEOUT="${TEST_TIMEOUT:-30000}"
MAX_SECONDS="${MAX_SECONDS:-0}"
TEST_DIR="${TEST_DIR:-tests}"
TEST_TEMPLATE="${TEST_TEMPLATE:-1}"
SHARD_GROUPS="${SHARD_GROUPS:-1}"
SHARD_GROUP="${SHARD_GROUP:-0}"
TIMINGS="${TIMINGS:-tests/.timings.tsv}"
CHANGED="${CHANGED:-}"
if [ -z "${JOBS:-}" ]; then
  if [ -n "${CI:-}" ]; then
    JOBS=1
  else
    cpus="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2)"
    JOBS=$((cpus / 2))
    if [ "${JOBS}" -gt 4 ]; then JOBS=4; fi
    if [ "${JOBS}" -lt 1 ]; then JOBS=1; fi
  fi
fi

# Read loop rather than `mapfile`: macOS ships bash 3.2, which has no mapfile
# (it silently yields an empty array), and this script is a local gate, not
# CI-only.
files=()
while IFS= read -r f; do files+=("$f"); done < <(find "${TEST_DIR}" -name '*.test.ts' | sort)
if [ "${#files[@]}" -eq 0 ]; then
  echo "no test files found under ${TEST_DIR}/" >&2
  exit 2
fi

# Greedy longest-first: each file, heaviest first, goes to the worker with the
# least time so far. Ties break on the file name so every worker computes the
# same split.
if [ "${SHARD_GROUPS}" -gt 1 ]; then
  timings="${TIMINGS}"
  [ -f "${timings}" ] || timings=/dev/null
  mine=()
  while IFS= read -r f; do mine+=("$f"); done < <(
    printf '%s\n' "${files[@]}" | awk -F'\t' -v tf="${timings}" '
      FILENAME == tf { if ($0 !~ /^#/ && NF >= 2) { t[$1] = $2 + 0; n++; v[n] = $2 + 0 } next }
      { f[++m] = $0 }
      END {
        # median of the known timings; 1s when there are none
        for (i = 1; i <= n; i++) for (j = i + 1; j <= n; j++) if (v[j] < v[i]) { x = v[i]; v[i] = v[j]; v[j] = x }
        med = n ? (n % 2 ? v[(n + 1) / 2] : (v[n / 2] + v[n / 2 + 1]) / 2) : 1
        for (i = 1; i <= m; i++) {
          name = f[i]; key = name; sub(/^.*\//, "", key)
          w = (name in t) ? t[name] : ((("tests/" key) in t) ? t["tests/" key] : med)
          printf "%.3f\t%s\n", w, name
        }
      }' "${timings}" - | sort -t "$(printf '\t')" -k1,1gr -k2,2 | awk -F'\t' -v groups="${SHARD_GROUPS}" -v group="${SHARD_GROUP}" '
      {
        best = 0
        for (g = 1; g < groups; g++) if (load[g] < load[best]) best = g
        load[best] += $1
        if (best == group) print $2
      }' | sort
  )
  files=("${mine[@]+"${mine[@]}"}")
fi

shards=$(((${#files[@]} + SHARD_SIZE - 1) / SHARD_SIZE))
echo "discovered ${#files[@]} test files; shard size ${SHARD_SIZE}; ${shards} shards; jobs ${JOBS}; group ${SHARD_GROUP}/${SHARD_GROUPS}"
if [ "${#files[@]}" -eq 0 ]; then
  exit 0
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/memex-shards.XXXXXX")"
trap 'rm -rf "${WORK}"' EXIT

if [ "${TEST_TEMPLATE}" != "0" ]; then
  if command -v sha256sum >/dev/null 2>&1; then hash_cmd=(sha256sum); else hash_cmd=(shasum -a 256); fi
  # Key on migration names and contents plus the installed PGLite, so a renamed
  # migration or an engine upgrade builds a fresh template.
  mig_hash="$( { ls src/core/migrations; cat src/core/migrate.ts src/core/migrations/*; cat node_modules/@electric-sql/pglite/package.json 2>/dev/null; } | "${hash_cmd[@]}" | cut -c1-16)"
  template="${TMPDIR:-/tmp}"
  template="${template%/}/memex-pglite-tpl-${mig_hash}"
  if ! bun scripts/build-test-template.ts "${template}" >/dev/null; then
    echo "could not build the PGLite test template at ${template}" >&2
    exit 2
  fi
  export MEMRAIN_TEST_PGLITE_TEMPLATE="${template}"
  echo "PGLite template ${template}"
else
  unset MEMRAIN_TEST_PGLITE_TEMPLATE
fi

for ((i = 0; i < ${#files[@]}; i += SHARD_SIZE)); do
  printf '%s\n' "${files[@]:i:SHARD_SIZE}" > "${WORK}/$(printf '%04d' $((i / SHARD_SIZE))).list"
done

export JOBS TEST_TIMEOUT MAX_SECONDS WORK CHANGED
RUN_STARTED="$(date +%s)"
export RUN_STARTED
# Sequential shards keep the old order; concurrent ones are buffered, so the
# order they print in is the order they finish.
find "${WORK}" -name '*.list' | sort | xargs -n 1 -P "${JOBS}" "${BASH:-bash}" "${SELF}" __shard

fail=0
failed=()
for list in "${WORK}"/*.list; do
  rc="$(cat "${list%.list}.rc" 2>/dev/null || echo missing)"
  case "${rc}" in
    0|skipped) ;;
    *) fail=1; failed+=("$((10#$(basename "${list}" .list)))") ;;
  esac
done
if [ "${fail}" -ne 0 ]; then
  echo "failed shards: ${failed[*]}"
fi
exit "${fail}"

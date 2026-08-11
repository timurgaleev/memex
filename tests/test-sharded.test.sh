#!/usr/bin/env bash
# tests/test-sharded.test.sh — unit tests for
# deploy/memex/scripts/test-sharded.sh.
#
# `bun` is stubbed on PATH so no real test suite runs: the stub records the
# files it was handed, which is what the shard maths has to get right.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SHARD_SH="$REPO_ROOT/deploy/memex/scripts/test-sharded.sh"

PASS=0
FAIL=0
TMPROOT="$(mktemp -d -t sharded-test.XXXXXX)"
trap 'rm -rf "$TMPROOT"; echo; echo "test-sharded.test.sh: PASS=$PASS FAIL=$FAIL"; [ "$FAIL" -eq 0 ]' EXIT

die() { echo "  ✗ $*"; FAIL=$((FAIL + 1)); }
pass() { echo "  ✓ $*"; PASS=$((PASS + 1)); }

# A fake `bun` that appends one line per invocation: the file count it was
# given, then the file names. `BUN_EXIT` forces a shard failure.
make_stub_bun() {
  local dir="$1"
  mkdir -p "$dir/bin"
  cat > "$dir/bin/bun" <<'EOF'
#!/usr/bin/env bash
# args: test --timeout <ms> <file>...
shift 3
echo "$# $*" >> "$BUN_CALLS"
exit "${BUN_EXIT:-0}"
EOF
  chmod +x "$dir/bin/bun"
}

# A disposable tests dir holding N empty *.test.ts files.
make_test_dir() {
  local dir="$1" n="$2"
  mkdir -p "$dir"
  for ((i = 0; i < n; i++)); do
    printf 'x' > "$dir/$(printf 't%03d' "$i").test.ts"
  done
}

# Run the script under the SAME interpreter running this test, so
# `bash tests/test-sharded.test.sh` with macOS's bash 3.2 actually exercises
# the script on 3.2 rather than on whatever bash sits first in PATH.
run_shards() {
  local sandbox="$1"; shift
  PATH="$sandbox/bin:$PATH" BUN_CALLS="$sandbox/calls" "$@" "${BASH:-bash}" "$SHARD_SH"
}

# --- T1: files are split into shards of SHARD_SIZE, remainder in the last ---
T1="$TMPROOT/t1"
make_stub_bun "$T1"
make_test_dir "$T1/tests" 7
: > "$T1/calls"
out=$(run_shards "$T1" env SHARD_SIZE=3 TEST_DIR="$T1/tests" 2>&1)
rc=$?
counts=$(cut -d' ' -f1 "$T1/calls" | tr '\n' ',')
if [ "$rc" -eq 0 ] && [ "$counts" = "3,3,1," ]; then
  pass "T1 7 files at SHARD_SIZE=3 → shards of 3,3,1"
else
  die "T1 expected rc=0 counts='3,3,1,' got rc=$rc counts='$counts' out='$out'"
fi

# --- T2: every discovered file is handed to exactly one shard ---
handed=$(cut -d' ' -f2- "$T1/calls" | tr ' ' '\n' | sort -u | wc -l | tr -d ' ')
if [ "$handed" = "7" ]; then
  pass "T2 all 7 files run exactly once, none dropped"
else
  die "T2 expected 7 distinct files handed to bun, got $handed"
fi

# --- T3: a failing shard fails the run, and later shards still run ---
T3="$TMPROOT/t3"
make_stub_bun "$T3"
make_test_dir "$T3/tests" 4
: > "$T3/calls"
run_shards "$T3" env SHARD_SIZE=2 TEST_DIR="$T3/tests" BUN_EXIT=1 >/dev/null 2>&1
rc=$?
shards=$(wc -l < "$T3/calls" | tr -d ' ')
if [ "$rc" -eq 1 ] && [ "$shards" = "2" ]; then
  pass "T3 failing shard → exit 1, remaining shards still run"
else
  die "T3 expected rc=1 with 2 shards, got rc=$rc shards=$shards"
fi

# --- T4: an empty test dir is an error, not a silent green ---
T4="$TMPROOT/t4"
make_stub_bun "$T4"
mkdir -p "$T4/tests"
: > "$T4/calls"
out=$(run_shards "$T4" env TEST_DIR="$T4/tests" 2>&1)
rc=$?
if [ "$rc" -eq 2 ] && [ ! -s "$T4/calls" ]; then
  pass "T4 no test files → exit 2, bun never invoked"
else
  die "T4 expected rc=2 and no bun calls, got rc=$rc out='$out'"
fi

# --- T5: MAX_SECONDS budget stops the loop instead of running every shard ---
# MAX_SECONDS=-1 can never be reached (the guard requires > 0), so the budget
# must NOT fire; a budget of 0 likewise means unlimited.
T5="$TMPROOT/t5"
make_stub_bun "$T5"
make_test_dir "$T5/tests" 6
: > "$T5/calls"
run_shards "$T5" env SHARD_SIZE=2 TEST_DIR="$T5/tests" MAX_SECONDS=0 >/dev/null 2>&1
shards=$(wc -l < "$T5/calls" | tr -d ' ')
if [ "$shards" = "3" ]; then
  pass "T5 MAX_SECONDS=0 means unlimited — every shard runs"
else
  die "T5 expected 3 shards with MAX_SECONDS=0, got $shards"
fi

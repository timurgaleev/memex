#!/usr/bin/env bash
# tests/entrypoint.test.sh — deploy/memrain/entrypoint.sh with a stub `bun`:
# the Postgres URL and the REQUIRE switch are read under both names, and a
# required-but-missing URL refuses to start (exit 78) without running init.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENTRYPOINT="$REPO_ROOT/deploy/memrain/entrypoint.sh"

PASS=0
FAIL=0
TMPROOT="$(mktemp -d -t entrypoint-test.XXXXXX)"
finish() {
  rc=$?
  rm -rf "$TMPROOT"
  echo
  echo "entrypoint.test.sh: PASS=$PASS FAIL=$FAIL"
  if [ "$FAIL" -ne 0 ]; then exit 1; fi
  exit "$rc"
}
trap finish EXIT

die() { echo "  ✗ $*"; FAIL=$((FAIL + 1)); }
pass() { echo "  ✓ $*"; PASS=$((PASS + 1)); }

# The stub records each invocation with the URL the app reads.
mkdir -p "$TMPROOT/bin"
cat > "$TMPROOT/bin/bun" <<'STUB'
#!/bin/sh
printf '%s | MEMRAIN_POSTGRES_URL=%s\n' "$*" "${MEMRAIN_POSTGRES_URL:-}" >> "$CALLS"
exit 0
STUB
chmod +x "$TMPROOT/bin/bun"

N=0
# run_entry VAR=value ... -> exit code; calls in $CALLS, output in $OUT
run_entry() {
  N=$((N + 1))
  CALLS="$TMPROOT/calls.$N"
  OUT="$TMPROOT/out.$N"
  mkdir -p "$TMPROOT/home.$N"
  : > "$CALLS"
  env -i PATH="$TMPROOT/bin:/usr/bin:/bin" HOME="$TMPROOT/home.$N" CALLS="$CALLS" "$@" \
    sh "$ENTRYPOINT" > "$OUT" 2>&1
}

URL="postgres://u:p@db/brain"
init_pg="run src/cli.ts init --postgres | MEMRAIN_POSTGRES_URL=$URL"
serve="run src/cli.ts serve --http --host 0.0.0.0 --port 18790"

echo "== entrypoint.sh =="

for env_set in "MEMRAIN_POSTGRES_URL=$URL" "MEMEX_POSTGRES_URL=$URL" "MEMRAIN_POSTGRES_URL= MEMEX_POSTGRES_URL=$URL"; do
  # shellcheck disable=SC2086  # word-split the VAR=value list on purpose
  if run_entry $env_set && [ "$(sed -n 1p "$CALLS")" = "$init_pg" ] \
     && sed -n 2p "$CALLS" | grep -q "^$serve |" && [ "$(wc -l < "$CALLS")" -eq 2 ]; then
    pass "$env_set -> init --postgres with MEMRAIN_POSTGRES_URL exported, then serve"
  else
    die "$env_set"; cat "$CALLS" "$OUT"
  fi
done

for req in MEMRAIN_REQUIRE_POSTGRES MEMEX_REQUIRE_POSTGRES; do
  ec=0; run_entry "$req=1" || ec=$?
  if [ "$ec" -eq 78 ] && [ ! -s "$CALLS" ] && grep -q 'FATAL' "$OUT"; then
    pass "$req=1 and no URL -> exit 78, no init, no serve"
  else
    die "$req=1 and no URL (exit $ec)"; cat "$CALLS" "$OUT"
  fi
done

if run_entry "MEMEX_REQUIRE_POSTGRES=1" "MEMEX_POSTGRES_URL=$URL" && [ "$(sed -n 1p "$CALLS")" = "$init_pg" ]; then
  pass "REQUIRE with a URL -> init --postgres"
else
  die "REQUIRE with a URL"; cat "$CALLS" "$OUT"
fi

if run_entry && sed -n 1p "$CALLS" | grep -q '^run src/cli.ts init --pglite |' \
   && sed -n 2p "$CALLS" | grep -q "^$serve |"; then
  pass "neither -> init --pglite, then serve"
else
  die "neither"; cat "$CALLS" "$OUT"
fi

if run_entry "MEMRAIN_REQUIRE_POSTGRES=0" && sed -n 1p "$CALLS" | grep -q 'init --pglite'; then
  pass "REQUIRE=0 -> init --pglite"
else
  die "REQUIRE=0"; cat "$CALLS" "$OUT"
fi

# A config under the new dir that still names the legacy mount: warn only.
N_NEXT=$((N + 1))
mkdir -p "$TMPROOT/home.$N_NEXT/.memrain"
printf '{"database":{"type":"pglite","path":"/home/bun/.memex/brain.pglite"}}\n' > "$TMPROOT/home.$N_NEXT/.memrain/config.json"
if run_entry && grep -q 'WARN: .*/home/bun/.memex/' "$OUT" && sed -n 1p "$CALLS" | grep -q 'init --pglite'; then
  pass "legacy path in ~/.memrain/config.json -> warning, start continues"
else
  die "legacy path warning"; cat "$CALLS" "$OUT"
fi
if run_entry && ! grep -q 'WARN' "$OUT"; then
  pass "no config -> no warning"
else
  die "no config warning"; cat "$OUT"
fi

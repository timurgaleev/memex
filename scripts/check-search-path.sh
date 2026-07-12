#!/usr/bin/env bash
# scripts/check-search-path.sh — CI guard: trigger functions must pin search_path.
#
# A function that runs as a trigger or event trigger executes under the calling
# session's `search_path`. If its body references an object unqualified, a writer
# who prepends their own schema can shadow what the body meant to call. Every
# trigger / event-trigger function memex defines must therefore carry an explicit
# `SET search_path` in its definition.
#
# This scans deploy/memex/src/core/migrations/*.sql for any
# `CREATE [OR REPLACE] FUNCTION ... RETURNS trigger|event_trigger` whose header
# (up to the body-opening `AS $...$`) lacks `SET search_path`, and fails with the
# offending file + function named.
#
# The pre-095 files that shipped their trigger functions without the clause are
# allowlisted by filename: migration 095 hardens them in place with ALTER
# FUNCTION rather than by rewriting a frozen, already-applied migration.
#
# Exit codes: 0 = clean, 1 = an unpinned trigger function found, 2 = misconfig.
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "")"
if [ -z "$REPO_ROOT" ]; then
  echo "[search-path] ERROR: not inside a git repository" >&2
  exit 2
fi
cd "$REPO_ROOT"

MIG_DIR="deploy/memex/src/core/migrations"
if [ ! -d "$MIG_DIR" ]; then
  echo "[search-path] ERROR: migrations dir not found: $MIG_DIR" >&2
  exit 2
fi

# Files whose trigger functions predate the search_path rule; migration 095
# pins them via ALTER FUNCTION (a shipped migration is never edited in place).
is_allowlisted() {
  case "$(basename "$1")" in
    030_*|032_*|082_*) return 0 ;;
  esac
  return 1
}

violations=0
for f in "$MIG_DIR"/*.sql; do
  [ -e "$f" ] || continue
  is_allowlisted "$f" && continue

  # awk state machine: accumulate each CREATE FUNCTION header up to the body
  # delimiter (AS $...$). If the header returns trigger/event_trigger and has no
  # SET search_path, emit "file|function".
  hits="$(awk -v file="$f" '
    BEGIN { capturing = 0; hdr = ""; fn = "" }
    {
      U = toupper($0)
      if (capturing == 0 && U ~ /CREATE([ \t]+OR[ \t]+REPLACE)?[ \t]+FUNCTION/) {
        capturing = 1; hdr = ""; fn = "?"
        line = $0
        if (match(line, /[Ff][Uu][Nn][Cc][Tt][Ii][Oo][Nn][ \t]+[A-Za-z0-9_."]+/)) {
          fn = substr(line, RSTART, RLENGTH)
          sub(/^[Ff][Uu][Nn][Cc][Tt][Ii][Oo][Nn][ \t]+/, "", fn)
        }
      }
      if (capturing == 1) {
        hdr = hdr " " U
        if (U ~ /AS[ \t]+\$/) {
          if (hdr ~ /RETURNS[ \t]+TRIGGER/ || hdr ~ /RETURNS[ \t]+EVENT_TRIGGER/) {
            if (hdr !~ /SET[ \t]+SEARCH_PATH/) {
              printf "%s|%s\n", file, fn
            }
          }
          capturing = 0; hdr = ""; fn = ""
        }
      }
    }
  ' "$f")"

  if [ -n "$hits" ]; then
    while IFS='|' read -r file func; do
      [ -z "$file" ] && continue
      echo "[search-path] FAIL: $file defines trigger function '$func' without SET search_path" >&2
      violations=$((violations + 1))
    done <<< "$hits"
  fi
done

if [ "$violations" -gt 0 ]; then
  echo "[search-path] $violations trigger function(s) missing SET search_path." >&2
  echo "[search-path] Add 'SET search_path = pg_catalog, public' to the definition (see migration 095)." >&2
  exit 1
fi

echo "[search-path] OK: all trigger/event-trigger functions pin search_path"
exit 0

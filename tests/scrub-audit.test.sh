#!/usr/bin/env bash
# tests/scrub-audit.test.sh — scripts/scrub-audit.sh scans text, not binary
# assets: a webp whose bytes happen to match a pattern is not a finding.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRUB_SH="$REPO_ROOT/scripts/scrub-audit.sh"
TMP="$(mktemp -d -t scrub-test.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0

git -C "$TMP" init -q
# scrub-audit runs the repo's pii audit first; this fixture has nothing for it.
mkdir -p "$TMP/scripts" && printf '#!/bin/sh\nexit 0\n' > "$TMP/scripts/audit.sh" && chmod +x "$TMP/scripts/audit.sh"
printf 'TESTSCRUB_[0-9]+|HIGH|test|synthetic marker\n' > "$TMP/patterns.txt"
printf '\x00\x01TESTSCRUB_42\xff\x00' > "$TMP/image.webp"
git -C "$TMP" add image.webp

check() {  # check <name> <want-exit>
  AUDIT_REPO="$TMP" SCRUB_PATTERNS="$TMP/patterns.txt" SCRUB_PATTERNS_LOCAL=/nonexistent \
    bash "$SCRUB_SH" >"$TMP/out.txt" 2>&1
  rc=$?
  if [ "$rc" -eq "$2" ]; then PASS=$((PASS+1)); echo "  ✓ $1"
  else FAIL=$((FAIL+1)); echo "  ✗ $1 (exit $rc, want $2)"; cat "$TMP/out.txt"; fi
}

check "binary file with a matching byte run is not a HIGH hit" 0

printf 'note TESTSCRUB_42\n' > "$TMP/note.md"
git -C "$TMP" add note.md
check "the same marker in a text file is a HIGH hit" 1

echo "scrub-audit.test.sh: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]

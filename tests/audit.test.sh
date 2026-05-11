#!/usr/bin/env bash
# tests/audit.test.sh — unit tests for scripts/audit.sh.
#
# Uses synthetic test patterns (TESTPII_*) injected via a per-test
# pii-patterns.txt so this test file never embeds real maintainer
# identifiers. Each test sets up a disposable git repo in a temp dir.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AUDIT_SH="$REPO_ROOT/scripts/audit.sh"

PASS=0
FAIL=0
TMPROOT="$(mktemp -d -t audit-test.XXXXXX)"
trap 'rm -rf "$TMPROOT"; echo; echo "audit.test.sh: PASS=$PASS FAIL=$FAIL"; [ "$FAIL" -eq 0 ]' EXIT

die() { echo "  ✗ $*"; FAIL=$((FAIL + 1)); }
pass() { echo "  ✓ $*"; PASS=$((PASS + 1)); }

# Synthetic patterns used throughout — picked so they never collide with
# a real value and are obviously test-only on inspection.
TEST_PATTERNS=$(cat <<'EOF'
\bTESTPII_ACCT_12DIGITS\b|HIGH|Synthetic account-id pattern
\btestpii-email@example\.invalid\b|HIGH|Synthetic email pattern
@testpii-bot\b|HIGH|Synthetic bot-handle pattern
\btestpii-domain\.invalid\b|HIGH|Synthetic domain pattern
EOF
)

TEST_ALLOWLIST=$(cat <<'EOF'
LICENSE
scripts/lib/pii-patterns.txt
scripts/lib/pii-allowlist.txt
EOF
)

new_repo() {
  local name="$1"
  local dir="$TMPROOT/$name"
  mkdir -p "$dir/scripts/lib"
  cp "$AUDIT_SH" "$dir/scripts/audit.sh"
  printf '%s\n' "$TEST_PATTERNS"  > "$dir/scripts/lib/pii-patterns.txt"
  printf '%s\n' "$TEST_ALLOWLIST" > "$dir/scripts/lib/pii-allowlist.txt"
  chmod +x "$dir/scripts/audit.sh"
  (
    cd "$dir" || exit
    git init -q
    git config user.email "test@example.com"
    git config user.name "test"
  )
  echo "$dir"
}

run_audit() {
  local repo="$1"
  (
    cd "$repo" || exit
    git add -A
    git commit -q -m "fixture" 2>/dev/null || true
    bash scripts/audit.sh
  )
}

# ---------------------------------------------------------------------------
echo "== audit.sh =="

# T1. Clean repo: only the audit harness — exit 0.
t1=$(new_repo t1)
ec=0; output=$(run_audit "$t1" 2>&1) || ec=$?
if [ "$ec" -eq 0 ] && echo "$output" | grep -q "no PII matches"; then
  pass "T1 clean repo → exit 0"
else
  die "T1 clean repo (exit=$ec): $output"
fi

# T2. Repo with one HIGH match in tracked file → exit 1.
t2=$(new_repo t2)
echo "Email: testpii-email@example.invalid" > "$t2/README.md"
ec=0; output=$(run_audit "$t2" 2>&1) || ec=$?
if [ "$ec" -eq 1 ] && echo "$output" | grep -q "testpii-email@example.invalid" && echo "$output" | grep -q "FAIL"; then
  pass "T2 PII in tracked file → exit 1 with file:line"
else
  die "T2 expected exit 1 with match output (got exit=$ec): $output"
fi

# T3. Multiple patterns aggregate correctly.
t3=$(new_repo t3)
cat > "$t3/README.md" <<'EOF'
Account: TESTPII_ACCT_12DIGITS
Bot: @testpii-bot
Domain: testpii-domain.invalid
EOF
ec=0; output=$(run_audit "$t3" 2>&1) || ec=$?
if [ "$ec" -eq 1 ] \
   && echo "$output" | grep -q "TESTPII_ACCT_12DIGITS" \
   && echo "$output" | grep -q "@testpii-bot" \
   && echo "$output" | grep -q "testpii-domain.invalid"; then
  pass "T3 multiple patterns aggregate"
else
  die "T3 expected all three patterns reported (got exit=$ec): $output"
fi

# T4. .gitignored file with PII → not flagged.
t4=$(new_repo t4)
echo "*.local" > "$t4/.gitignore"
echo "leaked=TESTPII_ACCT_12DIGITS" > "$t4/secrets.local"
ec=0; output=$(run_audit "$t4" 2>&1) || ec=$?
if [ "$ec" -eq 0 ]; then
  pass "T4 .gitignored file ignored → exit 0"
else
  die "T4 expected exit 0 since .gitignored (got exit=$ec): $output"
fi

# T5. Allowlisted file (LICENSE) does not blow up parsing even when present.
t5=$(new_repo t5)
echo "Copyright 2026 Example Maintainer" > "$t5/LICENSE"
ec=0; output=$(run_audit "$t5" 2>&1) || ec=$?
if [ "$ec" -eq 0 ]; then
  pass "T5 LICENSE allowlist parses cleanly → exit 0"
else
  die "T5 unexpected failure with LICENSE present (exit=$ec): $output"
fi

# T6. Untracked file with PII → not flagged (only tracked files audited).
t6=$(new_repo t6)
echo "leaked=TESTPII_ACCT_12DIGITS" > "$t6/untracked.txt"
echo "ok" > "$t6/README.md"
(cd "$t6" && git add README.md && git commit -q -m fixture)
# Don't add untracked.txt — direct audit invocation.
ec=0; output=$(cd "$t6" && bash scripts/audit.sh 2>&1) || ec=$?
if [ "$ec" -eq 0 ]; then
  pass "T6 untracked file ignored → exit 0"
else
  die "T6 expected exit 0 with untracked PII (got exit=$ec): $output"
fi

# T7. Missing patterns file → exit 2.
t7=$(new_repo t7)
rm "$t7/scripts/lib/pii-patterns.txt"
echo "ok" > "$t7/README.md"
ec=0; output=$(cd "$t7" && git add -A && git commit -q -m fixture && bash scripts/audit.sh 2>&1) || ec=$?
if [ "$ec" -eq 2 ]; then
  pass "T7 missing patterns file → exit 2"
else
  die "T7 expected exit 2 (got exit=$ec): $output"
fi

# T8. Word-boundary check — partial substring of a pattern must not match.
t8=$(new_repo t8)
echo "testpii=variable_name" > "$t8/code.txt"
ec=0; output=$(run_audit "$t8" 2>&1) || ec=$?
if [ "$ec" -eq 0 ]; then
  pass "T8 unrelated substring not flagged"
else
  die "T8 false positive on unrelated substring (exit=$ec): $output"
fi

# T9. Severity field appears in output.
t9=$(new_repo t9)
echo "domain: testpii-domain.invalid" > "$t9/notes.md"
ec=0; output=$(run_audit "$t9" 2>&1) || ec=$?
if [ "$ec" -eq 1 ] && echo "$output" | grep -q "severity:"; then
  pass "T9 severity printed alongside match"
else
  die "T9 severity missing from output (exit=$ec): $output"
fi

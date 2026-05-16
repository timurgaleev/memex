#!/usr/bin/env bash
# tests/init.test.sh — unit tests for scripts/init.sh.
#
# Each test creates a disposable directory with a minimal terraform/
# subdir, runs init.sh in non-interactive mode by piping answers, and
# asserts that the expected files were written with valid content.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INIT_SH="$REPO_ROOT/scripts/init.sh"

PASS=0
FAIL=0
TMPROOT="$(mktemp -d -t init-test.XXXXXX)"
trap 'rm -rf "$TMPROOT"; echo; echo "init.test.sh: PASS=$PASS FAIL=$FAIL"; [ "$FAIL" -eq 0 ]' EXIT

die() { echo "  ✗ $*"; FAIL=$((FAIL + 1)); }
pass() { echo "  ✓ $*"; PASS=$((PASS + 1)); }

# Standard valid answer set, one prompt per line, in the order init.sh asks:
#   AWS_ACCOUNT_ID, AWS_REGION, AWS_PROFILE, DOMAIN, SUBDOMAIN, MEMEX_SUBDOMAIN,
#   GITHUB_OWNER, REPO_NAME, SECRETS_PREFIX, TFSTATE_BUCKET, TFSTATE_REGION,
#   ALARM_EMAIL, SSH_ALLOWED_CIDR, TELEGRAM_BOT_HANDLE, USE_SSH_DEPLOY_KEY
valid_answers() {
  cat <<'EOF'
123456789012
eu-west-1
default
example.com
stack
brain
testowner
test-stack
stack
my-tfstate-bucket
eu-central-1



false
EOF
}

new_workspace() {
  local name="$1"
  local dir="$TMPROOT/$name"
  mkdir -p "$dir/terraform"
  echo "$dir"
}

run_init() {
  # run_init <workspace> [extra_args...]
  local ws="$1"; shift
  (
    cd "$ws" || exit
    INIT_NON_INTERACTIVE=1 INIT_REPO_ROOT="$ws" bash "$INIT_SH" "$@"
  )
}

# ---------------------------------------------------------------------------
echo "== init.sh =="

# T1. Happy path: writes all three files with expected values.
t1=$(new_workspace t1)
ec=0; output=$(valid_answers | run_init "$t1" 2>&1) || ec=$?
if [ "$ec" -eq 0 ] \
   && [ -f "$t1/.env" ] \
   && [ -f "$t1/terraform/terraform.tfvars" ] \
   && [ -f "$t1/terraform/backend.hcl" ]; then
  pass "T1 happy path → 3 files written (exit 0)"
else
  die "T1 happy path failed (exit=$ec). Output: $output"
  ls -la "$t1" "$t1/terraform" 2>/dev/null
fi

# T2. .env contains user-supplied values.
if [ -f "$t1/.env" ] \
   && grep -q '^AWS_ACCOUNT_ID=123456789012$' "$t1/.env" \
   && grep -q '^DOMAIN=example.com$' "$t1/.env" \
   && grep -q '^SUBDOMAIN=stack$' "$t1/.env" \
   && grep -q '^GITHUB_OWNER=testowner$' "$t1/.env" \
   && grep -q '^REPO_URL=https://github.com/testowner/test-stack.git$' "$t1/.env"; then
  pass "T2 .env has correct values"
else
  die "T2 .env content wrong: $(cat "$t1/.env" 2>/dev/null)"
fi

# T3. terraform.tfvars uses HCL syntax with quoted strings + bool literal.
if [ -f "$t1/terraform/terraform.tfvars" ] \
   && grep -q 'aws_region          = "eu-west-1"' "$t1/terraform/terraform.tfvars" \
   && grep -q 'use_ssh_deploy_key  = false' "$t1/terraform/terraform.tfvars"; then
  pass "T3 tfvars HCL syntax correct"
else
  die "T3 tfvars wrong: $(cat "$t1/terraform/terraform.tfvars" 2>/dev/null)"
fi

# T4. backend.hcl has bucket + region + key.
if [ -f "$t1/terraform/backend.hcl" ] \
   && grep -q 'bucket  = "my-tfstate-bucket"' "$t1/terraform/backend.hcl" \
   && grep -q 'region  = "eu-central-1"' "$t1/terraform/backend.hcl" \
   && grep -q 'key     = "test-stack/terraform.tfstate"' "$t1/terraform/backend.hcl"; then
  pass "T4 backend.hcl values correct"
else
  die "T4 backend.hcl wrong: $(cat "$t1/terraform/backend.hcl" 2>/dev/null)"
fi

# T5. Idempotency guard: re-running without --force aborts.
ec=0; output=$(valid_answers | run_init "$t1" 2>&1) || ec=$?
if [ "$ec" -eq 1 ] && echo "$output" | grep -q "already exist"; then
  pass "T5 second run without --force → exit 1"
else
  die "T5 expected exit 1 on second run (got exit=$ec): $output"
fi

# T6. --force overwrites existing files.
ec=0; output=$(valid_answers | run_init "$t1" --force 2>&1) || ec=$?
if [ "$ec" -eq 0 ]; then
  pass "T6 --force re-runs successfully → exit 0"
else
  die "T6 --force should succeed (got exit=$ec): $output"
fi

# T7. Atomic writes leave no .tmp files behind.
leftovers=$(find "$t1" -name "*.XXXXXX*" -o -name ".env.*" 2>/dev/null | grep -cv "^$")
if [ "$leftovers" -eq 0 ]; then
  pass "T7 no temp leftovers from atomic write"
else
  die "T7 found temp leftovers ($leftovers files)"
fi

# T8. Validation rejects bad AWS account ID (non-12-digit) — script exits 1
# in non-interactive mode rather than retry-loop.
t8=$(new_workspace t8)
ec=0; output=$( { printf '%s\n' \
  "abc" \
  "eu-west-1" "default" "example.com" "stack" "brain" \
  "testowner" "test-stack" "stack" "my-tfstate" "eu-central-1" \
  "" "" "" "false" \
  | INIT_NON_INTERACTIVE=1 INIT_REPO_ROOT="$t8" bash "$INIT_SH" 2>&1 ; } ) || ec=$?
if [ "$ec" -eq 1 ] && echo "$output" | grep -qi "12 digits"; then
  pass "T8 invalid AWS account ID → exit 1"
else
  die "T8 expected validation failure (exit=$ec): $output"
fi

# T9. Validation rejects bad domain.
t9=$(new_workspace t9)
ec=0; output=$( { printf '%s\n' \
  "123456789012" "eu-west-1" "default" "no-dot-domain" \
  "stack" "brain" "owner" "name" "stack" "buck" "eu-central-1" \
  "" "" "" "false" \
  | INIT_NON_INTERACTIVE=1 INIT_REPO_ROOT="$t9" bash "$INIT_SH" 2>&1 ; } ) || ec=$?
if [ "$ec" -eq 1 ] && echo "$output" | grep -q "domain"; then
  pass "T9 invalid domain → exit 1"
else
  die "T9 expected domain validation failure (exit=$ec): $output"
fi

# T10. Defaults applied when answer is empty (Enter).
t10=$(new_workspace t10)
ec=0; output=$( { printf '%s\n' \
  "123456789012" \
  "" "" \
  "example.com" \
  "" "" \
  "owner" "" \
  "" "buck" "" \
  "" "" "" "" \
  | INIT_NON_INTERACTIVE=1 INIT_REPO_ROOT="$t10" bash "$INIT_SH" 2>&1 ; } ) || ec=$?
if [ "$ec" -eq 0 ] \
   && grep -q '^AWS_REGION=eu-west-1$' "$t10/.env" \
   && grep -q '^SUBDOMAIN=chat$' "$t10/.env" \
   && grep -q '^MEMEX_SUBDOMAIN=brain$' "$t10/.env" \
   && grep -q '^REPO_NAME=memex$' "$t10/.env" \
   && grep -q '^USE_SSH_DEPLOY_KEY=false$' "$t10/.env"; then
  pass "T10 defaults applied for empty answers"
else
  die "T10 defaults missing (exit=$ec): $(cat "$t10/.env" 2>/dev/null)"
fi

# T11. Optional fields accept empty strings.
if [ -f "$t10/.env" ] \
   && grep -q '^ALARM_EMAIL=$' "$t10/.env" \
   && grep -q '^SSH_ALLOWED_CIDR=$' "$t10/.env" \
   && grep -q '^TELEGRAM_BOT_HANDLE=$' "$t10/.env"; then
  pass "T11 optional fields stay empty"
else
  die "T11 optional fields wrong: $(cat "$t10/.env" 2>/dev/null)"
fi

# T12. Missing terraform/ dir → exit 2.
t12="$TMPROOT/t12"
mkdir -p "$t12"  # no terraform/ subdir
ec=0; output=$(valid_answers | INIT_NON_INTERACTIVE=1 INIT_REPO_ROOT="$t12" bash "$INIT_SH" 2>&1) || ec=$?
if [ "$ec" -eq 2 ] && echo "$output" | grep -q "terraform/"; then
  pass "T12 missing terraform/ dir → exit 2"
else
  die "T12 expected exit 2 (got exit=$ec): $output"
fi

# shellcheck shell=bash
# Shared fixtures for the fetch-secrets / secret-name tests: a fake `aws` CLI
# backed by a directory, and a disposable copy of the scripts under test.
#
# Fake Secrets Manager layout under $STUB_DIR:
#   secrets/<id>          the secret exists; the file holds its current value
#   noversion/<id>        the secret exists but has no AWSCURRENT version
#   deny/<id>             every call on <id> fails; the file holds the error
#                         code (AccessDeniedException, ExpiredTokenException, ...)
#   denyget/<id>          only get-secret-value on <id> fails, same format
#   calls.log             one line per call: `<operation> <secret-id>`
# Ids contain `/`; they are stored with `/` replaced by `__`.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

stub_key() { printf '%s' "${1//\//__}"; }

# write_aws_stub BIN_DIR
write_aws_stub() {
  mkdir -p "$1"
  cat > "$1/aws" <<'STUB'
#!/usr/bin/env bash
set -u
op="" id=""
while [ $# -gt 0 ]; do
  case "$1" in
    describe-secret|get-secret-value|put-secret-value) op="$1" ;;
    --secret-id) shift; id="$1" ;;
  esac
  shift
done
printf '%s %s\n' "$op" "$id" >> "$STUB_DIR/calls.log"
key="${id//\//__}"
fail() {
  local api="$2"
  echo "An error occurred ($1) when calling the ${api} operation: stubbed failure for ${id}" >&2
  exit 254
}
case "$op" in
  describe-secret) api=DescribeSecret ;;
  get-secret-value) api=GetSecretValue ;;
  put-secret-value) api=PutSecretValue ;;
  *) echo "stub aws: unsupported call" >&2; exit 2 ;;
esac
if [ -f "$STUB_DIR/deny/$key" ]; then fail "$(cat "$STUB_DIR/deny/$key")" "$api"; fi
case "$op" in
  describe-secret)
    if [ -f "$STUB_DIR/secrets/$key" ] || [ -f "$STUB_DIR/noversion/$key" ]; then
      printf '{"Name": "%s"}\n' "$id"; exit 0
    fi
    fail ResourceNotFoundException "$api" ;;
  get-secret-value)
    if [ -f "$STUB_DIR/denyget/$key" ]; then fail "$(cat "$STUB_DIR/denyget/$key")" "$api"; fi
    if [ -f "$STUB_DIR/secrets/$key" ]; then cat "$STUB_DIR/secrets/$key"; printf '\n'; exit 0; fi
    fail ResourceNotFoundException "$api" ;;
  put-secret-value)
    if [ -f "$STUB_DIR/secrets/$key" ] || [ -f "$STUB_DIR/noversion/$key" ]; then exit 0; fi
    fail ResourceNotFoundException "$api" ;;
esac
STUB
  chmod +x "$1/aws"
}

# stub_secret ID VALUE ; stub_noversion ID ; stub_deny ID CODE ; stub_denyget ID CODE
stub_secret()    { mkdir -p "$STUB_DIR/secrets";   printf '%s' "$2" > "$STUB_DIR/secrets/$(stub_key "$1")"; }
stub_noversion() { mkdir -p "$STUB_DIR/noversion"; : > "$STUB_DIR/noversion/$(stub_key "$1")"; }
stub_deny()      { mkdir -p "$STUB_DIR/deny";      printf '%s' "$2" > "$STUB_DIR/deny/$(stub_key "$1")"; }
stub_denyget()   { mkdir -p "$STUB_DIR/denyget";   printf '%s' "$2" > "$STUB_DIR/denyget/$(stub_key "$1")"; }

# new_secrets_workspace DIR -> copies fetch-secrets.sh and lib.sh into
# DIR/deploy/secrets/ and the rotation script into DIR/scripts/, and writes a
# minimal DIR/.env. The caller appends to the .env as needed.
new_secrets_workspace() {
  local ws="$1"
  mkdir -p "$ws/deploy/secrets" "$ws/scripts" "$ws/stub/bin"
  cp "$REPO_ROOT/deploy/secrets/fetch-secrets.sh" "$REPO_ROOT/deploy/secrets/lib.sh" "$ws/deploy/secrets/"
  cp "$REPO_ROOT/scripts/rotate-memex-public-bearer.sh" "$REPO_ROOT/scripts/mcp-refresh.sh" "$ws/scripts/"
  printf 'AWS_REGION=eu-west-1\n' > "$ws/.env"
  write_aws_stub "$ws/stub/bin"
}

# run_fetch WS [VAR=value ...] -> runs fetch-secrets.sh in a clean env with
# the stub first on PATH; stdout+stderr go to WS/out.log, the exit code is
# the function's return code.
run_fetch() {
  local ws="$1"; shift
  env -i PATH="$ws/stub/bin:/usr/bin:/bin" HOME="$ws" STUB_DIR="$ws/stub" "$@" \
    bash "$ws/deploy/secrets/fetch-secrets.sh" > "$ws/out.log" 2>&1
}

# file_mode PATH -> octal permission bits (GNU and BSD stat)
file_mode() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }

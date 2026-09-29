#!/usr/bin/env bash
# tests/fetch-secrets.test.sh — deploy/secrets/fetch-secrets.sh against a stub
# `aws` CLI: new-then-old secret names, the unset-prefix default (memex), and
# the two-phase write (a failed run leaves every existing file byte-identical).
# The app file is .secrets/memrain.env with MEMRAIN_ keys; a .secrets/memex.env
# left by a pre-rename release is never written, truncated or deleted.
set -uo pipefail

# shellcheck source=/dev/null
. "$(cd "$(dirname "$0")" && pwd)/lib/secrets-stub.sh"

PASS=0
FAIL=0
TMPROOT="$(mktemp -d -t fetch-secrets-test.XXXXXX)"
finish() {
  rc=$?
  rm -rf "$TMPROOT"
  echo
  echo "fetch-secrets.test.sh: PASS=$PASS FAIL=$FAIL"
  if [ "$FAIL" -ne 0 ]; then exit 1; fi
  exit "$rc"
}
trap finish EXIT

die() { echo "  ✗ $*"; FAIL=$((FAIL + 1)); }
pass() { echo "  ✓ $*"; PASS=$((PASS + 1)); }

N=0
ws_new() {
  N=$((N + 1))
  WS="$TMPROOT/ws$N"
  new_secrets_workspace "$WS"
  APP="$WS/deploy/.secrets/memrain.env"
  TUN="$WS/deploy/.secrets/cloudflared.env"
  LEGACY="$WS/deploy/.secrets/memex.env"
  # Every workspace starts with the pre-rename release's file; the end of
  # this script checks it is byte-identical in all of them.
  mkdir -p "$WS/deploy/.secrets"
  printf 'MEMEX_POSTGRES_URL=postgres://legacy\nMEMEX_PUBLIC_BEARER=legacy-bearer\n' > "$LEGACY"
  chmod 0600 "$LEGACY"
  cp "$LEGACY" "$WS/legacy.before"
}

# Seed the four secrets under PREFIX with NAME-style leaf names.
seed_all() {
  local prefix="$1" brand="$2" tag="$3"
  stub_secret "$prefix/$brand-postgres-url" "postgres://u:p@db/$tag"
  stub_secret "$prefix/$brand-public-bearer" "bearer-$tag"
  stub_secret "$prefix/$brand-internal-token" "internal-$tag"
  stub_secret "$prefix/cloudflared-tunnel-token" "tunnel-$tag"
}

# Previous state: files a good earlier run left behind. Owner-writable by
# default: the tests run unprivileged, and a 0400 file would make any stray
# overwrite fail on EACCES and pass the byte-identical check by accident
# (on the host the script runs as root, where the mode stops nothing).
seed_previous() {
  local mode="${1:-0600}"
  mkdir -p "$WS/deploy/.secrets"
  printf 'MEMRAIN_POSTGRES_URL=postgres://previous\nMEMRAIN_PUBLIC_BEARER=previous-bearer\n' > "$APP"
  printf 'TUNNEL_TOKEN=previous-tunnel\nCLOUDFLARE_TUNNEL_TOKEN=previous-tunnel\n' > "$TUN"
  chmod "$mode" "$APP" "$TUN"
  cp "$APP" "$WS/app.before"
  cp "$TUN" "$WS/tun.before"
}

unchanged() {
  cmp -s "$APP" "$WS/app.before" && cmp -s "$TUN" "$WS/tun.before"
}

no_tmp_left() {
  [ -z "$(find "$WS/deploy/.secrets" -name '*.tmp.*' 2>/dev/null)" ]
}

no_values_in_output() {
  ! grep -Eq 'postgres://u:p@|bearer-(new|old)|internal-(new|old)|tunnel-(new|old)' "$WS/out.log"
}

echo "== fetch-secrets.sh =="

# T1. new names only: every value lands in memrain.env under MEMRAIN_ keys, 0400.
ws_new; export STUB_DIR="$WS/stub"
printf 'SECRETS_PREFIX=stack\n' >> "$WS/.env"
seed_all stack memrain new
if run_fetch "$WS" \
   && grep -qx 'MEMRAIN_POSTGRES_URL=postgres://u:p@db/new' "$APP" \
   && grep -qx 'MEMRAIN_PUBLIC_BEARER=bearer-new' "$APP" \
   && grep -qx 'MEMRAIN_INTERNAL_TOKEN=internal-new' "$APP" \
   && grep -qx 'MEMRAIN_PUBLIC_WRITE=0' "$APP" \
   && grep -qx 'TUNNEL_TOKEN=tunnel-new' "$TUN" \
   && grep -qx 'CLOUDFLARE_TUNNEL_TOKEN=tunnel-new' "$TUN" \
   && [ "$(file_mode "$APP")" = "400" ] && [ "$(file_mode "$TUN")" = "400" ] \
   && ! grep -q '^MEMEX_' "$APP" \
   && no_tmp_left && no_values_in_output; then
  pass "T1 new names only: memrain.env with MEMRAIN_ keys only, 0400"
else
  die "T1 new names only"; cat "$WS/out.log"
fi

# T2. old names only.
ws_new; export STUB_DIR="$WS/stub"
printf 'SECRETS_PREFIX=stack\n' >> "$WS/.env"
seed_all stack memex old
if run_fetch "$WS" \
   && grep -qx 'MEMRAIN_POSTGRES_URL=postgres://u:p@db/old' "$APP" \
   && grep -qx 'MEMRAIN_PUBLIC_BEARER=bearer-old' "$APP" \
   && grep -qx 'MEMRAIN_INTERNAL_TOKEN=internal-old' "$APP" \
   && grep -q 'stack/memex-postgres-url' "$WS/out.log" \
   && no_values_in_output; then
  pass "T2 old names only: legacy secrets used, ids printed"
else
  die "T2 old names only"; cat "$WS/out.log"
fi

# T3. both: the new name wins.
ws_new; export STUB_DIR="$WS/stub"
printf 'SECRETS_PREFIX=stack\n' >> "$WS/.env"
seed_all stack memex old
seed_all stack memrain new
if run_fetch "$WS" \
   && grep -qx 'MEMRAIN_POSTGRES_URL=postgres://u:p@db/new' "$APP" \
   && grep -qx 'MEMRAIN_PUBLIC_BEARER=bearer-new' "$APP" \
   && grep -qx 'MEMRAIN_INTERNAL_TOKEN=internal-new' "$APP"; then
  pass "T3 both names: new wins"
else
  die "T3 both names"; cat "$WS/out.log"
fi

# T4. unset prefix means the legacy `memex` prefix: memex/<new>, then
# memex/<old>, and no other prefix is ever asked.
ws_new; export STUB_DIR="$WS/stub"
stub_secret memex/memex-postgres-url "postgres://u:p@db/old"
expected=$'describe-secret memex/memrain-postgres-url\ndescribe-secret memex/memex-postgres-url'
if run_fetch "$WS" \
   && grep -qx 'MEMRAIN_POSTGRES_URL=postgres://u:p@db/old' "$APP" \
   && [ "$(grep 'postgres-url' "$WS/stub/calls.log" | grep '^describe')" = "$expected" ] \
   && ! grep -q ' memrain/' "$WS/stub/calls.log"; then
  pass "T4 unset prefix: memex prefix, new then old name"
else
  die "T4 unset prefix order"; cat "$WS/stub/calls.log"; cat "$WS/out.log"
fi
# T4b. secrets under a `memrain/` prefix are never picked up without the key.
ws_new; export STUB_DIR="$WS/stub"
seed_all memex memex old
seed_all memrain memrain new
if run_fetch "$WS" && grep -qx 'MEMRAIN_PUBLIC_BEARER=bearer-old' "$APP" \
   && grep -qx 'TUNNEL_TOKEN=tunnel-old' "$TUN" \
   && ! grep -q ' memrain/' "$WS/stub/calls.log"; then
  pass "T4b unset prefix: no cross-prefix probing"
else
  die "T4b unset prefix isolation"; cat "$WS/stub/calls.log"; cat "$WS/out.log"
fi
# T4c. an empty SECRETS_PREFIX counts as unset.
ws_new; export STUB_DIR="$WS/stub"
printf 'SECRETS_PREFIX=\n' >> "$WS/.env"
seed_all memex memrain new
if run_fetch "$WS" && grep -qx 'MEMRAIN_PUBLIC_BEARER=bearer-new' "$APP"; then
  pass "T4c empty prefix: memex prefix, new name first"
else
  die "T4c empty prefix"; cat "$WS/stub/calls.log"; cat "$WS/out.log"
fi
# T4d. AccessDenied on the new name under the default prefix is fatal: it
# never falls through to the old name, and the previous files stay intact.
ws_new; export STUB_DIR="$WS/stub"
seed_all memex memex old
seed_previous
stub_deny memex/memrain-public-bearer AccessDeniedException
ec=0; run_fetch "$WS" || ec=$?
if [ "$ec" -eq 1 ] && unchanged && no_tmp_left \
   && ! grep -q 'memex/memex-public-bearer' "$WS/stub/calls.log"; then
  pass "T4d unset prefix + AccessDenied on the new name: exit 1, no fallback"
else
  die "T4d unset prefix AccessDenied (exit $ec)"; cat "$WS/stub/calls.log"; cat "$WS/out.log"
fi

# T5. R6: a non-NotFound error on each secret in turn, in each error class,
# exits 1 and leaves both files byte-identical with no temp file left, even
# though the secrets before the failing one were fetched.
for code in AccessDeniedException ExpiredTokenException ThrottlingException; do
  for leaf in memrain-postgres-url memrain-public-bearer memrain-internal-token cloudflared-tunnel-token; do
    for how in deny denyget; do
      ws_new; export STUB_DIR="$WS/stub"
      printf 'SECRETS_PREFIX=stack\n' >> "$WS/.env"
      seed_all stack memrain new
      seed_previous
      "stub_$how" "stack/$leaf" "$code"
      ec=0; run_fetch "$WS" || ec=$?
      if [ "$ec" -eq 1 ] && unchanged && no_tmp_left && no_values_in_output; then
        pass "T5 $code ($how) on $leaf: exit 1, files byte-identical"
      else
        die "T5 $code ($how) on $leaf (exit $ec)"; cat "$WS/out.log"
      fi
    done
  done
done

# T6. REQUIRE_POSTGRES (either name) with no URL secret: exit 1, nothing written.
for var in MEMRAIN_REQUIRE_POSTGRES MEMEX_REQUIRE_POSTGRES; do
  ws_new; export STUB_DIR="$WS/stub"
  printf 'SECRETS_PREFIX=stack\n%s=1\n' "$var" >> "$WS/.env"
  stub_secret stack/memrain-public-bearer "bearer-new"
  seed_previous
  ec=0; run_fetch "$WS" || ec=$?
  if [ "$ec" -eq 1 ] && unchanged && no_tmp_left; then
    pass "T6 $var=1 + URL NotFound: exit 1, files unchanged"
  else
    die "T6 $var=1 + URL NotFound (exit $ec)"; cat "$WS/out.log"
  fi
done

# T6b. Without REQUIRE a missing URL is the PGLite dev fallback.
ws_new; export STUB_DIR="$WS/stub"
printf 'SECRETS_PREFIX=stack\n' >> "$WS/.env"
stub_secret stack/memrain-public-bearer "bearer-new"
if run_fetch "$WS" && ! grep -q POSTGRES_URL "$APP" && grep -qx 'MEMRAIN_PUBLIC_BEARER=bearer-new' "$APP"; then
  pass "T6b missing URL without REQUIRE: warn, no URL line"
else
  die "T6b missing URL without REQUIRE"; cat "$WS/out.log"
fi

# T7. URL secret that exists but has no current version: fatal, not missing.
ws_new; export STUB_DIR="$WS/stub"
printf 'SECRETS_PREFIX=stack\n' >> "$WS/.env"
seed_all stack memrain new
rm -f "$WS/stub/secrets/$(stub_key stack/memrain-postgres-url)"
stub_noversion stack/memrain-postgres-url
seed_previous
ec=0; run_fetch "$WS" || ec=$?
if [ "$ec" -eq 1 ] && unchanged; then
  pass "T7 URL secret without a version: exit 1, files unchanged"
else
  die "T7 URL secret without a version (exit $ec)"; cat "$WS/out.log"
fi

# T8. An existing secret with an empty value counts as missing.
ws_new; export STUB_DIR="$WS/stub"
printf 'SECRETS_PREFIX=stack\n' >> "$WS/.env"
seed_all stack memrain new
stub_secret stack/memrain-public-bearer ""
if run_fetch "$WS" && ! grep -q PUBLIC_BEARER "$APP" && grep -qx 'MEMRAIN_POSTGRES_URL=postgres://u:p@db/new' "$APP"; then
  pass "T8 empty bearer value: treated as missing"
else
  die "T8 empty bearer value"; cat "$WS/out.log"
fi

# T9. Tunnel token missing: an existing non-empty cloudflared.env is kept.
for kind in notfound noversion; do
  ws_new; export STUB_DIR="$WS/stub"
  printf 'SECRETS_PREFIX=stack\n' >> "$WS/.env"
  seed_all stack memrain new
  rm -f "$WS/stub/secrets/$(stub_key stack/cloudflared-tunnel-token)"
  [ "$kind" = noversion ] && stub_noversion stack/cloudflared-tunnel-token
  seed_previous
  if run_fetch "$WS" && cmp -s "$TUN" "$WS/tun.before" \
     && grep -q 'WARN: cloudflared tunnel token has no value yet' "$WS/out.log" \
     && grep -qx 'MEMRAIN_POSTGRES_URL=postgres://u:p@db/new' "$APP"; then
    pass "T9 tunnel $kind + existing file: file unchanged, warning printed"
  else
    die "T9 tunnel $kind + existing file"; cat "$WS/out.log"
  fi
done

# T9b. Tunnel token missing on a fresh install: empty 0400 placeholder.
ws_new; export STUB_DIR="$WS/stub"
printf 'SECRETS_PREFIX=stack\n' >> "$WS/.env"
stub_noversion stack/cloudflared-tunnel-token
if run_fetch "$WS" && [ -f "$TUN" ] && [ ! -s "$TUN" ] && [ "$(file_mode "$TUN")" = "400" ]; then
  pass "T9b tunnel missing, no file: empty 0400 placeholder"
else
  die "T9b tunnel placeholder"; cat "$WS/out.log"
fi

# T10. PUBLIC_WRITE reads the new name, then the legacy one.
ws_new; export STUB_DIR="$WS/stub"
printf 'SECRETS_PREFIX=stack\nMEMEX_PUBLIC_WRITE=1\n' >> "$WS/.env"
if run_fetch "$WS" && grep -qx 'MEMRAIN_PUBLIC_WRITE=1' "$APP"; then
  pass "T10a MEMEX_PUBLIC_WRITE=1 honoured"
else
  die "T10a legacy PUBLIC_WRITE"; cat "$WS/out.log"
fi
ws_new; export STUB_DIR="$WS/stub"
printf 'SECRETS_PREFIX=stack\nMEMEX_PUBLIC_WRITE=1\nMEMRAIN_PUBLIC_WRITE=0\n' >> "$WS/.env"
if run_fetch "$WS" && grep -qx 'MEMRAIN_PUBLIC_WRITE=0' "$APP"; then
  pass "T10b MEMRAIN_PUBLIC_WRITE wins over MEMEX_PUBLIC_WRITE"
else
  die "T10b PUBLIC_WRITE precedence"; cat "$WS/out.log"
fi

# T11. A successful run replaces the previous files, read-only ones included.
ws_new; export STUB_DIR="$WS/stub"
printf 'SECRETS_PREFIX=stack\n' >> "$WS/.env"
seed_all stack memrain new
seed_previous 0400
if run_fetch "$WS" && grep -qx 'MEMRAIN_PUBLIC_BEARER=bearer-new' "$APP" \
   && grep -qx 'TUNNEL_TOKEN=tunnel-new' "$TUN" && no_tmp_left; then
  pass "T11 success replaces the previous files"
else
  die "T11 success over previous files"; cat "$WS/out.log"
fi

# T12. The pre-rename .secrets/memex.env is byte-identical (content and mode)
# in every workspace above, after runs that succeeded and runs that failed.
bad=""
for i in $(seq 1 "$N"); do
  w="$TMPROOT/ws$i"
  if ! cmp -s "$w/deploy/.secrets/memex.env" "$w/legacy.before" \
     || [ "$(file_mode "$w/deploy/.secrets/memex.env")" != "600" ]; then
    bad="$bad ws$i"
  fi
done
if [ -z "$bad" ]; then
  pass "T12 .secrets/memex.env untouched in all $N runs"
else
  die "T12 .secrets/memex.env changed in:$bad"
fi

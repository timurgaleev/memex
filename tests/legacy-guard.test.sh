#!/usr/bin/env bash
# tests/legacy-guard.test.sh — deploy/lib/legacy-guard.sh: each guard refuses
# a pre-rename layout (and says how to fix it) and lets a clean or already
# moved one through. `docker` and `mount` are stubbed.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0
FAIL=0
TMPROOT="$(mktemp -d -t legacy-guard-test.XXXXXX)"
finish() {
  rc=$?
  rm -rf "$TMPROOT"
  echo
  echo "legacy-guard.test.sh: PASS=$PASS FAIL=$FAIL"
  if [ "$FAIL" -ne 0 ]; then exit 1; fi
  exit "$rc"
}
trap finish EXIT

die() { echo "  ✗ $*"; FAIL=$((FAIL + 1)); }
pass() { echo "  ✓ $*"; PASS=$((PASS + 1)); }

BIN="$TMPROOT/bin"
mkdir -p "$BIN"
# docker ps prints $STUB_PS (one name per line) when the filter mentions memex;
# STUB_PS_FAIL=1 makes it fail like an unreachable daemon.
cat > "$BIN/docker" <<'STUB'
#!/usr/bin/env bash
[ "${STUB_PS_FAIL:-}" = "1" ] && { echo "Cannot connect to the Docker daemon" >&2; exit 1; }
case "$*" in *memex*) [ -n "${STUB_PS:-}" ] && printf '%s\n' "$STUB_PS" ;; esac
exit 0
STUB
# mount prints the lines in $STUB_MOUNTS.
cat > "$BIN/mount" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "${STUB_MOUNTS:-}"
STUB
chmod +x "$BIN/docker" "$BIN/mount"

# guard FUNC ARGS... -> runs one guard in a clean shell; output in $OUT.
OUT="$TMPROOT/out.log"
guard() {
  env PATH="$BIN:$PATH" bash -c '. "$1"; shift; "$@"' _ "$REPO_ROOT/deploy/lib/legacy-guard.sh" "$@" > "$OUT" 2>&1
}

echo "== legacy-guard.sh =="

# Container.
if guard legacy_guard_container; then pass "container: none running → ok"; else die "container none"; cat "$OUT"; fi
ec=0; STUB_PS=deploy-memex-1 guard legacy_guard_container || ec=$?
if [ "$ec" -eq 1 ] && grep -q 'docker stop deploy-memex-1 && docker rm deploy-memex-1' "$OUT"; then
  pass "container: deploy-memex-1 running → refuse, stop/rm printed"
else
  die "container running (exit $ec)"; cat "$OUT"
fi
ec=0; STUB_PS_FAIL=1 guard legacy_guard_container || ec=$?
if [ "$ec" -eq 1 ]; then pass "container: docker ps fails → refuse"; else die "docker ps failure (exit $ec)"; fi

# Data dir.
D="$TMPROOT/efs1"; mkdir -p "$D/memex"; echo '{}' > "$D/memex/config.json"
ec=0; guard legacy_guard_data_dir "$D" || ec=$?
if [ "$ec" -eq 1 ] && grep -qF "mv '$D/memex' '$D/memrain'" "$OUT"; then
  pass "data dir: memex/config.json without memrain/ → refuse, mv printed"
else
  die "data dir legacy (exit $ec)"; cat "$OUT"
fi
mkdir -p "$D/memrain"
if guard legacy_guard_data_dir "$D"; then pass "data dir: memrain/ present → ok"; else die "data dir moved"; cat "$OUT"; fi
D="$TMPROOT/efs2"; mkdir -p "$D/memex"
if guard legacy_guard_data_dir "$D"; then pass "data dir: memex/ without config.json → ok"; else die "data dir empty legacy"; cat "$OUT"; fi

# Repo checkout.
L="$TMPROOT/opt/memex"; R="$TMPROOT/opt/memrain"; mkdir -p "$L/.git"
ec=0; guard legacy_guard_repo "$R" "$L" || ec=$?
if [ "$ec" -eq 1 ] && grep -qF "mv '$L' '$R'" "$OUT"; then
  pass "repo: legacy checkout without the new dir → refuse, mv printed"
else
  die "repo legacy (exit $ec)"; cat "$OUT"
fi
if guard legacy_guard_repo "$L" "$L"; then pass "repo: REPO_DIR is the legacy path itself → ok"; else die "repo same path"; cat "$OUT"; fi
mkdir -p "$R"
if guard legacy_guard_repo "$R" "$L"; then pass "repo: new dir exists → ok"; else die "repo new exists"; cat "$OUT"; fi

# Mount point.
M="127.0.0.1:/ on /mnt/memex-efs type nfs4 (rw,relatime)"
ec=0; STUB_MOUNTS="$M" guard legacy_guard_mount memrain || ec=$?
if [ "$ec" -eq 1 ] && grep -q '/mnt/memex-efs is still mounted' "$OUT"; then
  pass "mount: /mnt/memex-efs mounted on a memrain install → refuse"
else
  die "mount legacy (exit $ec)"; cat "$OUT"
fi
if STUB_MOUNTS="$M" guard legacy_guard_mount memex; then pass "mount: project memex → ok"; else die "mount project memex"; cat "$OUT"; fi
if STUB_MOUNTS="127.0.0.1:/ on /mnt/memrain-efs type nfs4 (rw)" guard legacy_guard_mount memrain; then
  pass "mount: only the new mount point → ok"
else
  die "mount new only"; cat "$OUT"
fi
if STUB_MOUNTS="127.0.0.1:/ on /mnt/memex-efs-old type nfs4 (rw)" guard legacy_guard_mount memrain; then
  pass "mount: a longer path that starts with the legacy one → ok"
else
  die "mount prefix"; cat "$OUT"
fi

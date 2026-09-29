#!/usr/bin/env bash
# tests/deploy.test.sh — deploy/deploy.sh against stub `docker` and `git`:
# the preflights refuse before anything starts, the data gates stop the app
# before the ingress, maintenance holds the ingress, and the happy path starts
# the app alone and then the whole set without naming a service.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0
FAIL=0
TMPROOT="$(mktemp -d -t deploy-test.XXXXXX)"
finish() {
  rc=$?
  rm -rf "$TMPROOT"
  echo
  echo "deploy.test.sh: PASS=$PASS FAIL=$FAIL"
  if [ "$FAIL" -ne 0 ]; then exit 1; fi
  exit "$rc"
}
trap finish EXIT

die() { echo "  ✗ $*"; FAIL=$((FAIL + 1)); }
pass() { echo "  ✓ $*"; PASS=$((PASS + 1)); }

command -v jq >/dev/null 2>&1 || { echo "deploy.test.sh: jq not installed — skipping"; exit 0; }

# Stub state lives in $WS/stub:
#   pre_running      the app container runs before the deploy
#   legacy_running   a deploy-memex-1 container runs
#   config_fails     `compose config -q` fails
#   health.json      /health body after the build (version is filled in)
#   status.json      `status` output (pre and post deploy alike unless
#                    pre_status.json exists)
#   running_after    services `ps --status running --services` prints
#   calls.log        one line per docker/git call
write_stubs() {
  local bin="$1"
  mkdir -p "$bin"
  cat > "$bin/docker" <<'STUB'
#!/usr/bin/env bash
set -u
S="$STUB_DIR"
printf 'docker %s\n' "$*" >> "$S/calls.log"
case "$1" in
  ps)
    if [ -e "$S/legacy_running" ] && printf '%s' "$*" | grep -q memex; then echo deploy-memex-1; fi
    exit 0 ;;
  inspect)
    case "$*" in
      *State.Running*) if [ -e "$S/pre_running" ] || [ -e "$S/up_done" ]; then echo true; else echo false; fi ;;
      *State.Health.Status*) if [ -e "$S/up_done" ]; then echo healthy; else echo missing; fi ;;
    esac
    exit 0 ;;
  exec)
    case "$*" in
      *"cli.ts status"*)
        # serve holds the PGLite data-dir lock; a second process cannot open it.
        if grep -q '"db":"pglite"' "$S/health.json"; then echo "PgliteLockedError: open in another process" >&2; exit 1; fi
        if [ ! -e "$S/up_done" ] && [ -e "$S/pre_status.json" ]; then cat "$S/pre_status.json"; else cat "$S/status.json"; fi ;;
      *"/health"*) sed "s/@VERSION@/$(cat "$S/version")/" "$S/health.json" ;;
    esac
    exit 0 ;;
  logs) exit 0 ;;
  compose)
    shift
    while [ $# -gt 0 ]; do
      case "$1" in
        --env-file|-f) shift 2 ;;
        *) break ;;
      esac
    done
    case "$1" in
      config)
        if [ "${2:-}" = "-q" ]; then
          if [ -e "$S/config_fails" ]; then echo "service \"caddy\" depends on undefined service \"memex\"" >&2; exit 15; fi
          exit 0
        fi
        if [ "${2:-}" = "--services" ]; then printf 'memrain\ncloudflared\n'; exit 0; fi ;;
      up) case "$*" in *--build*) touch "$S/up_done" ;; esac; exit 0 ;;
      stop) exit 0 ;;
      ps) cat "$S/running_after" 2>/dev/null; exit 0 ;;
    esac
    exit 0 ;;
esac
exit 0
STUB
  cat > "$bin/git" <<'STUB'
#!/usr/bin/env bash
printf 'git %s\n' "$*" >> "$STUB_DIR/calls.log"
cat "$STUB_DIR/version"
STUB
  cat > "$bin/sleep" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
  chmod +x "$bin/docker" "$bin/git" "$bin/sleep"
}

N=0
# ws_new -> a repo-shaped workspace with deploy.sh, the guard library, a .env
# and a healthy postgres brain with 100 pages as the default stub state.
ws_new() {
  N=$((N + 1))
  WS="$TMPROOT/ws$N"
  S="$WS/stub"
  mkdir -p "$WS/deploy/lib" "$WS/deploy/.secrets" "$S/bin"
  cp "$REPO_ROOT/deploy/deploy.sh" "$WS/deploy/"
  cp "$REPO_ROOT/deploy/lib/legacy-guard.sh" "$WS/deploy/lib/"
  printf 'AWS_REGION=eu-west-1\n' > "$WS/.env"
  write_stubs "$S/bin"
  echo v1.0.0 > "$S/version"
  printf '{"ok":true,"db":"postgres","version":"@VERSION@"}\n' > "$S/health.json"
  status_json 100 true 2
  printf 'memrain\ncloudflared\n' > "$S/running_after"
}

# status_json PAGES SELF_ISSUED CLIENTS [FILE]
status_json() {
  printf '{\n  "ok": true,\n  "oauth_self_issued": %s,\n  "oauth_clients_live": %s,\n  "stats": {\n    "documents": 7,\n    "pages": %s\n  }\n}\n' \
    "$2" "$3" "$1" > "$S/${4:-status.json}"
}

run_deploy() {
  (cd "$WS" && env -i PATH="$S/bin:$PATH" HOME="$WS" STUB_DIR="$S" "$@" \
    bash deploy/deploy.sh) > "$WS/out.log" 2>&1
}

calls() { cat "$S/calls.log" 2>/dev/null; }
no_up() { ! calls | grep -q 'compose.* up '; }
no_ingress() { ! calls | grep -q 'compose.* up -d --no-build'; }
stopped() { calls | grep -q 'compose.* stop memrain$'; }

echo "== deploy.sh =="

# 1. A legacy container is running: refuse before anything starts.
ws_new; touch "$S/legacy_running"
ec=0; run_deploy || ec=$?
if [ "$ec" -ne 0 ] && no_up && grep -q 'docker stop deploy-memex-1 && docker rm deploy-memex-1' "$WS/out.log"; then
  pass "legacy container running: exit $ec, no up, stop/rm printed"
else
  die "legacy container (exit $ec)"; cat "$WS/out.log"
fi

# 2. compose config fails on a legacy overlay: hint printed, no stop, no up.
ws_new; touch "$S/config_fails"
printf 'services:\n  caddy:\n    depends_on:\n      memex:\n        condition: service_healthy\n' > "$WS/overlay.yml"
ec=0; run_deploy COMPOSE_FILE=deploy/docker-compose.yml:overlay.yml || ec=$?
if [ "$ec" -eq 1 ] && no_up && ! calls | grep -q ' stop ' \
   && grep -q 'overlay.yml still names the pre-rename service' "$WS/out.log" \
   && grep -q "sed -i 's/" "$WS/out.log" && grep -q 'UPGRADING' "$WS/out.log"; then
  pass "config -q fails: sed hint for the legacy overlay, nothing touched"
else
  die "config -q failure (exit $ec)"; cat "$WS/out.log"
fi

# 3. db=pglite: the app is stopped and the ingress never starts.
ws_new; printf '{"ok":true,"db":"pglite","version":"@VERSION@"}\n' > "$S/health.json"
ec=0; run_deploy || ec=$?
if [ "$ec" -eq 1 ] && stopped && no_ingress; then
  pass "db=pglite: stop memrain, no ingress"
else
  die "db=pglite (exit $ec)"; cat "$WS/out.log"; calls
fi
# ... unless explicitly allowed: status cannot open a PGLite dir next to serve,
# so a running PGLite container is not pre-read and the page gates are skipped.
ws_new; touch "$S/pre_running"; printf '{"ok":true,"db":"pglite","version":"@VERSION@"}\n' > "$S/health.json"
if run_deploy DEPLOY_ALLOW_PGLITE=1 && ! stopped && ! no_ingress \
   && ! calls | grep -q 'cli.ts status' && grep -q 'WARN: db=pglite' "$WS/out.log"; then
  pass "db=pglite with DEPLOY_ALLOW_PGLITE=1: no status call, ingress started"
else
  die "DEPLOY_ALLOW_PGLITE"; cat "$WS/out.log"; calls
fi
# ... but an explicit page floor that cannot be checked fails closed.
ws_new; printf '{"ok":true,"db":"pglite","version":"@VERSION@"}\n' > "$S/health.json"
ec=0; run_deploy DEPLOY_ALLOW_PGLITE=1 DEPLOY_MIN_PAGES=10 || ec=$?
if [ "$ec" -eq 1 ] && stopped && no_ingress && grep -q 'cannot be checked on PGLite' "$WS/out.log"; then
  pass "db=pglite + DEPLOY_MIN_PAGES: stop, no ingress"
else
  die "pglite floor (exit $ec)"; cat "$WS/out.log"
fi

# 4. pages=0, and pages below the running container's count.
ws_new; status_json 0 true 0
ec=0; run_deploy || ec=$?
if [ "$ec" -eq 1 ] && stopped && no_ingress; then
  pass "pages=0: stop, no ingress"
else
  die "pages=0 (exit $ec)"; cat "$WS/out.log"
fi
ws_new; touch "$S/pre_running"; status_json 100 true 0 pre_status.json; status_json 99 true 0
ec=0; run_deploy || ec=$?
if [ "$ec" -eq 1 ] && stopped && no_ingress && grep -q 'fewer than the 100' "$WS/out.log"; then
  pass "pages < pages of the running container: stop, no ingress"
else
  die "pages < pre (exit $ec)"; cat "$WS/out.log"
fi

# 5. No running container: DEPLOY_MIN_PAGES is the floor.
ws_new; status_json 9 true 0
ec=0; run_deploy DEPLOY_MIN_PAGES=10 || ec=$?
if [ "$ec" -eq 1 ] && stopped && no_ingress; then
  pass "no container + DEPLOY_MIN_PAGES=10 + pages=9: stop, no ingress"
else
  die "DEPLOY_MIN_PAGES floor (exit $ec)"; cat "$WS/out.log"
fi
# ... and the larger of the two wins when a container runs.
ws_new; touch "$S/pre_running"; status_json 5 true 0 pre_status.json; status_json 9 true 0
ec=0; run_deploy DEPLOY_MIN_PAGES=10 || ec=$?
if [ "$ec" -eq 1 ] && stopped; then
  pass "running container with fewer pages than DEPLOY_MIN_PAGES: the larger floor wins"
else
  die "max floor (exit $ec)"; cat "$WS/out.log"
fi

# 6. A non-integer DEPLOY_MIN_PAGES fails before anything runs.
for bad in abc -1 1.5 ' 3'; do
  ws_new
  ec=0; run_deploy "DEPLOY_MIN_PAGES=$bad" || ec=$?
  if [ "$ec" -eq 1 ] && no_up && [ ! -s "$S/calls.log" ]; then
    pass "DEPLOY_MIN_PAGES='$bad': exit 1 before any docker call"
  else
    die "DEPLOY_MIN_PAGES='$bad' (exit $ec)"; cat "$WS/out.log"
  fi
done

# 7. OAuth clients exist but self-issued OAuth is off.
ws_new; status_json 100 false 3
ec=0; run_deploy || ec=$?
if [ "$ec" -eq 1 ] && stopped && no_ingress; then
  pass "oauth_self_issued=false with 3 clients: stop, no ingress"
else
  die "oauth gate (exit $ec)"; cat "$WS/out.log"
fi
ws_new; status_json 100 false 0
if run_deploy && ! no_ingress; then
  pass "oauth_self_issued=false with no clients: passes"
else
  die "oauth gate without clients"; cat "$WS/out.log"
fi

# 8. Maintenance: every gate runs, the ingress is held, exit 0.
ws_new; printf '{"ok":true,"db":"postgres","version":"@VERSION@","maintenance":true}\n' > "$S/health.json"
if run_deploy && no_ingress && ! stopped \
   && grep -qx 'HELD: maintenance on; ingress not started' "$WS/out.log" \
   && [ "$(grep -c '^HELD' "$WS/out.log")" -eq 1 ] && ! grep -q '^OK:' "$WS/out.log"; then
  pass "maintenance: HELD line, exit 0, no ingress up"
else
  die "maintenance hold"; cat "$WS/out.log"; calls
fi
# ... a failing gate still fails in maintenance.
ws_new; printf '{"ok":true,"db":"postgres","version":"@VERSION@","maintenance":true}\n' > "$S/health.json"
status_json 0 true 0
ec=0; run_deploy || ec=$?
if [ "$ec" -eq 1 ] && stopped && ! grep -q '^HELD' "$WS/out.log"; then
  pass "maintenance + pages=0: the gate still fails"
else
  die "maintenance gate (exit $ec)"; cat "$WS/out.log"
fi
# ... and the override starts the ingress.
ws_new; printf '{"ok":true,"db":"postgres","version":"@VERSION@","maintenance":true}\n' > "$S/health.json"
if run_deploy DEPLOY_ALLOW_INGRESS_IN_MAINTENANCE=1 && ! no_ingress && ! grep -q '^HELD' "$WS/out.log"; then
  pass "maintenance + DEPLOY_ALLOW_INGRESS_IN_MAINTENANCE=1: ingress up"
else
  die "maintenance override"; cat "$WS/out.log"
fi

# 9. Preflight C: Postgres required but no URL staged.
ws_new; printf 'MEMEX_REQUIRE_POSTGRES=1   # inline comment\n' >> "$WS/.env"
ec=0; run_deploy || ec=$?
if [ "$ec" -eq 1 ] && no_up && grep -q 'fetch-secrets.sh' "$WS/out.log"; then
  pass "REQUIRE_POSTGRES=1 (legacy name) without a staged URL: exit 1, no up"
else
  die "REQUIRE without URL (exit $ec)"; cat "$WS/out.log"
fi
ws_new; printf 'MEMRAIN_REQUIRE_POSTGRES=1\n' >> "$WS/.env"
printf 'MEMRAIN_POSTGRES_URL=postgres://u:p@db/x\n' > "$WS/deploy/.secrets/memrain.env"
if run_deploy && ! no_ingress; then
  pass "REQUIRE_POSTGRES=1 with the URL staged in memrain.env: deploys"
else
  die "REQUIRE with URL"; cat "$WS/out.log"
fi

# 9b. Only the pre-rename memex.env is staged: refuse before anything starts.
ws_new; printf 'MEMEX_PUBLIC_BEARER=x\n' > "$WS/deploy/.secrets/memex.env"
ec=0; run_deploy || ec=$?
if [ "$ec" -eq 1 ] && no_up && grep -q 'memrain.env does not' "$WS/out.log" && grep -q 'fetch-secrets.sh' "$WS/out.log"; then
  pass "legacy memex.env without memrain.env: exit 1, no up"
else
  die "legacy memex.env only (exit $ec)"; cat "$WS/out.log"
fi
ws_new; printf 'MEMEX_PUBLIC_BEARER=x\n' > "$WS/deploy/.secrets/memex.env"
printf 'MEMRAIN_PUBLIC_BEARER=x\n' > "$WS/deploy/.secrets/memrain.env"
if run_deploy && ! no_ingress; then
  pass "memex.env next to memrain.env: deploys"
else
  die "both env files"; cat "$WS/out.log"
fi

# 10. Happy path: the order of the calls and the shape of each.
ws_new; printf 'COMPOSE_FILE=deploy/docker-compose.yml:/etc/memrain/compose.caddy.yml\n' >> "$WS/.env"
if run_deploy; then
  # First occurrence of each step, in the order the steps must run.
  in_order=1 prev=0
  for pat in 'compose.* config -q' '^docker ps ' '^git describe' 'compose.* up -d --build' \
             'State.Health' 'exec deploy-memrain-1 wget' 'cli.ts status' 'compose.* up -d --no-build'; do
    at="$(calls | grep -nE -- "$pat" | head -n 1 | cut -d: -f1)"
    if [ -z "$at" ] || [ "$at" -le "$prev" ]; then in_order=0; echo "    out of order or missing: $pat"; fi
    prev="${at:-$prev}"
  done
  up_app="$(calls | grep 'compose.* up -d --build')"
  up_all="$(calls | grep 'compose.* up -d --no-build')"
  if [ "$in_order" -eq 1 ] \
     && printf '%s' "$up_app" | grep -q -- '-f deploy/docker-compose.yml -f /etc/memrain/compose.caddy.yml' \
     && printf '%s' "$up_app" | grep -q -- 'up -d --build --no-deps memrain$' \
     && printf '%s' "$up_all" | grep -q -- 'up -d --no-build$' \
     && ! calls | grep -q -- '--remove-orphans' \
     && ! calls | grep -qE 'up .*cloudflared' \
     && calls | grep -qx "git describe --tags --match v\[0-9\]\* --always --dirty" \
     && grep -qx 'OK: deploy-memrain-1 healthy, serving v1.0.0, db=postgres, pages=100, ingress up' "$WS/out.log"; then
    pass "happy path: preflights → app alone → gates → ingress; two -f; no orphans flag; no named ingress"
  else
    die "happy path shape"; calls; cat "$WS/out.log"
  fi
else
  die "happy path failed"; cat "$WS/out.log"; calls
fi

# 11. The stamp gate: a container serving another version fails.
ws_new; printf '{"ok":true,"db":"postgres","version":"v0.9.9"}\n' > "$S/health.json"
ec=0; run_deploy || ec=$?
if [ "$ec" -eq 1 ] && no_ingress && grep -q "container serves 'v0.9.9'" "$WS/out.log"; then
  pass "stamp mismatch: exit 1, no ingress"
else
  die "stamp gate (exit $ec)"; cat "$WS/out.log"
fi

# 12. A service that did not come up after the ingress start fails the deploy.
ws_new; printf 'memrain\n' > "$S/running_after"
ec=0; run_deploy || ec=$?
if [ "$ec" -eq 1 ] && grep -q 'not running after the ingress start: cloudflared' "$WS/out.log"; then
  pass "ingress service not running: exit 1"
else
  die "running-services check (exit $ec)"; cat "$WS/out.log"
fi

# 13. A log line printed before the status JSON does not break the gates.
ws_new; { echo '[memrain] note: something on stdout'; cat "$S/status.json"; } > "$S/status.tmp" && mv "$S/status.tmp" "$S/status.json"
if run_deploy && grep -q 'pages=100, ingress up' "$WS/out.log"; then
  pass "status with a log line before the JSON: gates still read it"
else
  die "status prefix line"; cat "$WS/out.log"
fi

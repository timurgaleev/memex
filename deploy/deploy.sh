#!/usr/bin/env bash
# Deploy the memex container from the checkout in /opt/<project>, stamped with
# the version it was built from, and refuse to finish unless the running
# container reports that same stamp back.
#
# Why this exists: the build arg, the Dockerfile ENV, `version.ts` and the
# `/health` payload were wired end to end, but nothing ever supplied the value —
# `MEMEX_VERSION` was absent from the host env, so every image ever built was
# stamped `dev`. A deploy could not be distinguished from a no-op, and the check
# an operator would reach for to tell them apart is the one that was broken.
#
# Run from the repo root on the instance, after `git pull --ff-only`.
set -euo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-deploy/docker-compose.yml}"
ENV_FILE="${ENV_FILE:-.env}"
SERVICE="${SERVICE:-memex}"
CONTAINER="${CONTAINER:-deploy-memex-1}"
HEALTH_TIMEOUT_S="${HEALTH_TIMEOUT_S:-180}"

# The stamp: an exact tag when HEAD is one, else <tag>-<n>-g<sha>, else the sha.
# Deliberately NOT package.json (pinned at 0.1.0) and NOT a hand-passed string.
MEMEX_VERSION="$(git describe --tags --always --dirty)"
export MEMEX_VERSION
echo "==> building ${SERVICE} stamped ${MEMEX_VERSION}"

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --build "$SERVICE"

echo "==> waiting for ${CONTAINER} to report healthy (max ${HEALTH_TIMEOUT_S}s)"
deadline=$((SECONDS + HEALTH_TIMEOUT_S))
while true; do
  status="$(docker inspect "$CONTAINER" --format '{{.State.Health.Status}}' 2>/dev/null || echo missing)"
  [ "$status" = "healthy" ] && break
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "FAIL: ${CONTAINER} is '${status}' after ${HEALTH_TIMEOUT_S}s" >&2
    docker logs --tail 40 "$CONTAINER" >&2 || true
    exit 1
  fi
  sleep 5
done

# The gate. A container that came up healthy but is serving the previous image
# reports the previous stamp — which is exactly the failure a deploy check is
# for, and exactly the one a hardcoded version string cannot catch.
running="$(docker exec "$CONTAINER" wget -qO- http://localhost:18790/health |
  sed -n 's/.*"version":"\([^"]*\)".*/\1/p')"

if [ "$running" != "$MEMEX_VERSION" ]; then
  echo "FAIL: built ${MEMEX_VERSION} but the container serves '${running}'" >&2
  echo "      the running image is not the one just built — investigate before trusting this deploy." >&2
  exit 1
fi

echo "OK: ${CONTAINER} healthy and serving ${running}"

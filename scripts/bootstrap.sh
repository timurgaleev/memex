#!/bin/bash
# bootstrap.sh — runs ONCE per instance via cloud-init user_data (cloud-init
# executes user_data scripts once-per-instance, not per-boot; on a plain
# reboot the stack comes back via docker's restart policies instead).
# Idempotent: safe to re-run any time via SSM:
#   aws s3 cp s3://<scripts-bucket>/scripts/bootstrap.sh /tmp/b.sh && sudo bash /tmp/b.sh
# Fast — ~30s on a cold run, ~2s on a warm one.
#
# Reads its env contract from /etc/stack-env (written by terraform
# user_data). Failing-fast on a missing required value is intentional —
# silent fallbacks would mask wiring mistakes.
set -euo pipefail

# ---------------------------------------------------------------------------
# 0. Load env contract written by cloud-init from terraform vars.
# ---------------------------------------------------------------------------
# shellcheck source=/dev/null
if [ -f /etc/stack-env ]; then
  . /etc/stack-env
fi

: "${STACK_REPO_URL:?STACK_REPO_URL must be set (write it to /etc/stack-env)}"
: "${STACK_EFS_ID:=}"          # optional — skip mount if absent
: "${STACK_PROJECT:=memex}"
: "${STACK_USE_SSH_DEPLOY_KEY:=false}"
: "${STACK_SECRETS_PREFIX:=$STACK_PROJECT}"
: "${STACK_AWS_REGION:=eu-west-1}"
: "${STACK_DOMAIN:=}"
: "${STACK_MEMEX_SUBDOMAIN:=memex}"
: "${STACK_INGRESS_MODE:=cloudflare}"

# ---------------------------------------------------------------------------
# 1. System packages
# ---------------------------------------------------------------------------
dnf install -y docker git amazon-efs-utils jq aws-cli unzip
systemctl enable --now docker

# 1b. Install docker compose v2 plugin (AL2023's docker package doesn't ship it).
# Binary is downloaded over HTTPS but verified against a pinned sha256
# checksum — a tampered GitHub release asset or hijacked DNS would
# otherwise yield a compose binary running as root with full Docker
# socket access. Bump COMPOSE_VERSION + both SHAs together; the canonical
# table lives at https://github.com/docker/compose/releases.
COMPOSE_VERSION="v2.30.3"
COMPOSE_SHA256_aarch64="8fed7b79b8bd1cb0624142f7d723c3cc67ba747c77ed69abbdefdc77a6d416d1"
COMPOSE_SHA256_x86_64="fbb4853d3f2148b0f2f0916f8971c9e500784e4e4949324934fc0b7dc2ed5016"
COMPOSE_PLUGIN_DIR="/usr/libexec/docker/cli-plugins"
COMPOSE_PLUGIN="${COMPOSE_PLUGIN_DIR}/docker-compose"
ARCH_DC=$(uname -m)  # aarch64 or x86_64 — both used in compose release names
case "$ARCH_DC" in
  aarch64) COMPOSE_SHA256="$COMPOSE_SHA256_aarch64" ;;
  x86_64)  COMPOSE_SHA256="$COMPOSE_SHA256_x86_64" ;;
  *) echo "[bootstrap] unsupported arch $ARCH_DC"; exit 1 ;;
esac
if [ ! -x "$COMPOSE_PLUGIN" ] || [ "$($COMPOSE_PLUGIN version --short 2>/dev/null || echo)" != "${COMPOSE_VERSION#v}" ]; then
  echo "[bootstrap] installing docker compose ${COMPOSE_VERSION} (${ARCH_DC})"
  mkdir -p "$COMPOSE_PLUGIN_DIR"
  TMP_COMPOSE="$(mktemp)"
  curl -fsSL "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-${ARCH_DC}" \
    -o "$TMP_COMPOSE"
  if ! echo "${COMPOSE_SHA256}  ${TMP_COMPOSE}" | sha256sum -c -; then
    rm -f "$TMP_COMPOSE"
    echo "[bootstrap] FATAL: docker-compose sha256 mismatch — refusing to install"
    exit 1
  fi
  install -m 0755 "$TMP_COMPOSE" "$COMPOSE_PLUGIN"
  rm -f "$TMP_COMPOSE"
  echo "[bootstrap] docker compose: $($COMPOSE_PLUGIN version --short)"
else
  echo "[bootstrap] docker compose ${COMPOSE_VERSION} already installed"
fi

# ---------------------------------------------------------------------------
# 2. EFS mount (idempotent fstab + retry)
# ---------------------------------------------------------------------------
EFS_MOUNT="/mnt/${STACK_PROJECT}-efs"
EFS_DATA="${EFS_MOUNT}/${STACK_PROJECT}"
EFS_REPO="${EFS_MOUNT}/${STACK_PROJECT}-repo"
mkdir -p "$EFS_MOUNT"

if [ -n "$STACK_EFS_ID" ]; then
  FSTAB_LINE="${STACK_EFS_ID}:/ ${EFS_MOUNT} efs _netdev,tls,iam 0 0"
  grep -qxF "$FSTAB_LINE" /etc/fstab || echo "$FSTAB_LINE" >> /etc/fstab
  for _ in 1 2 3 4 5; do
    mountpoint -q "$EFS_MOUNT" && break
    if mount -t efs -a; then break; else sleep 10; fi
  done
  mountpoint -q "$EFS_MOUNT" || { echo "[bootstrap] EFS mount failed after 5 retries"; exit 1; }
else
  echo "[bootstrap] WARNING: STACK_EFS_ID not set — skipping EFS mount"
fi

# ---------------------------------------------------------------------------
# 3. Seed canonical EFS dirs (idempotent).
# DO NOT use `chown -R` on the data tree — that walks every file on every
# boot over NFS (5-15 min stall on a populated vault). Only chown the dirs
# we seeded; pre-existing content keeps its existing ownership.
# ---------------------------------------------------------------------------
SEEDED=()
for d in vault memex workspace skills credentials; do
  TARGET="${EFS_DATA}/${d}"
  mkdir -p "$TARGET"
  SEEDED+=("$TARGET")
done
chown 1000:1000 "$EFS_DATA" "${SEEDED[@]}" 2>/dev/null || true

# ---------------------------------------------------------------------------
# 4. Clone or update the repo. HTTPS by default (public); SSH only when
#    STACK_USE_SSH_DEPLOY_KEY=true (SSH deploy-key flow).
# ---------------------------------------------------------------------------
REPO_DIR="/opt/${STACK_PROJECT}"
SSH_DIR="/root/.ssh"

git_clone_with_retry() {
  # Retry git clone up to 3 times with 5s backoff — handles transient
  # DNS / TLS hiccups on a fresh boot before the network is fully up.
  local url="$1" dst="$2" tries=0
  while [ "$tries" -lt 3 ]; do
    if git clone "$url" "$dst"; then
      return 0
    fi
    tries=$((tries + 1))
    echo "[bootstrap] git clone failed (try $tries/3) — retrying in 5s"
    sleep 5
  done
  return 1
}

if [ "$STACK_USE_SSH_DEPLOY_KEY" = "true" ]; then
  echo "[bootstrap] SSH deploy-key mode (SSH deploy-key flow)"
  SSH_KEY_FILE="${SSH_DIR}/${STACK_PROJECT}_deploy_key"
  mkdir -p "$SSH_DIR"
  chmod 700 "$SSH_DIR"
  # Fetch (or refresh) the deploy key from Secrets Manager. The key
  # never crosses the chat / log surface — --query+--output text avoids
  # JSON wrapping.
  aws secretsmanager get-secret-value \
    --secret-id "${STACK_SECRETS_PREFIX}/github-deploy-key" \
    --query SecretString --output text \
    --region "$STACK_AWS_REGION" > "$SSH_KEY_FILE"
  chmod 600 "$SSH_KEY_FILE"
  export GIT_SSH_COMMAND="ssh -i $SSH_KEY_FILE -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
else
  echo "[bootstrap] HTTPS clone mode (public repo, no auth required)"
  unset GIT_SSH_COMMAND
fi

if [ -d "${REPO_DIR}/.git" ]; then
  git -C "${REPO_DIR}" pull --ff-only
else
  git_clone_with_retry "$STACK_REPO_URL" "$REPO_DIR" \
    || { echo "[bootstrap] FATAL: git clone failed 3x — check STACK_REPO_URL"; exit 1; }
fi

# ---------------------------------------------------------------------------
# 4b. Code-index seed — memex expects a checkout at ${EFS_REPO} so the
# code-chunkers have files to index. Empty -> "0 indexable files" warning;
# we make it idempotent: clone if absent, pull otherwise.
# ---------------------------------------------------------------------------
if [ -d "${EFS_REPO}/.git" ]; then
  git -C "${EFS_REPO}" pull --ff-only || echo "[bootstrap] WARN: code-index pull failed (continuing)"
else
  git_clone_with_retry "$STACK_REPO_URL" "$EFS_REPO" \
    || echo "[bootstrap] WARN: code-index clone failed — memex will start with empty index"
fi
chown -R 1000:1000 "$EFS_REPO" 2>/dev/null || true

# ---------------------------------------------------------------------------
# 5. Render /opt/<project>/.env from the env contract.
#    Both bash scripts and docker compose (via --env-file) read this file.
# ---------------------------------------------------------------------------
# Only a real domain yields a public origin. Without one, leave it empty so the
# server keeps its request-host fallback instead of advertising "https://sub.".
if [ -n "${STACK_DOMAIN:-}" ]; then
  STACK_PUBLIC_URL="https://${STACK_MEMEX_SUBDOMAIN}.${STACK_DOMAIN}"
else
  STACK_PUBLIC_URL=""
fi

cat > "${REPO_DIR}/.env" <<EOF
# Generated by scripts/bootstrap.sh at boot — overwrites any prior file.
PROJECT=${STACK_PROJECT}
AWS_REGION=${STACK_AWS_REGION}
AWS_PROFILE=default
SECRETS_PREFIX=${STACK_SECRETS_PREFIX}
DOMAIN=${STACK_DOMAIN}
MEMEX_SUBDOMAIN=${STACK_MEMEX_SUBDOMAIN}
MEMEX_HOST=${STACK_MEMEX_SUBDOMAIN}.${STACK_DOMAIN}
# The external origin, needed whole (scheme included) by every absolute URL the
# server emits: the OAuth issuer and the admin magic link. This file is
# rewritten by every bootstrap run, so a hand-added value here does not survive
# the next one. Empty when no domain is configured — the server then falls back
# to the request host rather than advertising a malformed "https://sub." origin.
MEMEX_PUBLIC_URL=${STACK_PUBLIC_URL}
REPO_DIR=${REPO_DIR}
EFS_MOUNT=${EFS_DATA}
EFS_REPO=${EFS_REPO}
MEMEX_PUBLIC_WRITE=${MEMEX_PUBLIC_WRITE:-0}
EOF
chmod 0600 "${REPO_DIR}/.env"

# ---------------------------------------------------------------------------
# 6. Fetch secrets -> .env files for compose
# ---------------------------------------------------------------------------
SECRETS_PREFIX="$STACK_SECRETS_PREFIX" \
  bash "${REPO_DIR}/deploy/secrets/fetch-secrets.sh"

# ---------------------------------------------------------------------------
# 7. Bake AWS profile config so containers inheriting ~/.aws/config can
#    use the EC2 instance metadata service for credentials.
# ---------------------------------------------------------------------------
mkdir -p /home/ec2-user/.aws
cat > /home/ec2-user/.aws/config <<AWSEOF
[default]
region = ${STACK_AWS_REGION}
credential_source = Ec2InstanceMetadata
AWSEOF
# 0644: the telegram-bridge container runs as uid 10001 and bind-mounts
# this file at /home/bridge/.aws/config. The config carries no secret —
# it just points the AWS SDK at IMDS, where actual credentials come
# from the EC2 instance role. World-readable is correct.
chmod 0644 /home/ec2-user/.aws/config

# ---------------------------------------------------------------------------
# 7b. Caddy ingress (ingress_mode = "caddy"): TLS terminates on the instance
# instead of a Cloudflare Tunnel. Caddy runs as a compose override so
# compose owns its lifecycle and network together with memex; the
# cloudflared service is parked behind a profile it never matches.
# ---------------------------------------------------------------------------
COMPOSE_FILES=(-f deploy/docker-compose.yml)
if [ "$STACK_INGRESS_MODE" = "caddy" ]; then
  : "${STACK_DOMAIN:?STACK_DOMAIN is required for the caddy ingress (Caddyfile site address)}"
  INGRESS_HOST="${STACK_MEMEX_SUBDOMAIN}.${STACK_DOMAIN}"
  mkdir -p "/etc/${STACK_PROJECT}" "${EFS_DATA}/caddy-data" "${EFS_DATA}/caddy-config"

  # Site-scope request_header: memex's auth guard keys on Cf-Connecting-Ip
  # being present; setting it at site scope (plus header_up inside the
  # proxy block) keeps auth enforced even if routes are added later.
  # MEMEX_ASSUME_PUBLIC below is the primary control — the headers are
  # belt and braces.
  cat > "/etc/${STACK_PROJECT}/Caddyfile" <<EOF
{
	servers {
		timeouts {
			read_header 10s
			read_body 30s
			idle 2m
		}
	}
}

${INGRESS_HOST} {
	request_header Cf-Connecting-Ip {remote_host}
	header Strict-Transport-Security "max-age=31536000; includeSubDomains"
	reverse_proxy memex:18790 {
		header_up Cf-Connecting-Ip {remote_host}
	}
}
EOF

  cat > "/etc/${STACK_PROJECT}/compose.caddy.yml" <<EOF
# Caddy ingress override (written by bootstrap.sh when ingress_mode=caddy).
# Used as: docker compose -f deploy/docker-compose.yml -f /etc/${STACK_PROJECT}/compose.caddy.yml
services:
  # Stock tunnel ingress parked: a profile it never matches means no plain
  # 'up -d' with these files can start it.
  cloudflared:
    profiles: ["disabled"]
  caddy:
    # Tag pinned to the 2.10 minor; bump intentionally after a smoke test
    # (same policy as the cloudflared pin in deploy/docker-compose.yml).
    image: caddy:2.10
    restart: unless-stopped
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    cap_add:
      - NET_BIND_SERVICE
    read_only: true
    tmpfs:
      - /tmp
    mem_limit: 256m
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"
    volumes:
      - /etc/${STACK_PROJECT}/Caddyfile:/etc/caddy/Caddyfile:ro
      - ${EFS_DATA}/caddy-data:/data
      - ${EFS_DATA}/caddy-config:/config
    networks:
      - internal
    depends_on:
      # started (not healthy): an unhealthy memex must not block the first
      # ACME issuance — Caddy serving 502s is harmless, repeated failed
      # ACME validations burn Let's Encrypt quota.
      memex:
        condition: service_started
    healthcheck:
      test: ["CMD", "caddy", "version"]
      interval: 60s
      timeout: 5s
      retries: 3
EOF
  COMPOSE_FILES+=(-f "/etc/${STACK_PROJECT}/compose.caddy.yml")

  # The auth guard must treat EVERY request as public behind Caddy — without
  # this a request that dodges the header injection is served unauthenticated.
  grep -q '^MEMEX_ASSUME_PUBLIC=' "${REPO_DIR}/.env" \
    || echo "MEMEX_ASSUME_PUBLIC=1" >> "${REPO_DIR}/.env"

  # Best-effort wait for public DNS before the first ACME attempt. Non-fatal —
  # Caddy retries issuance on its own; this just makes the first boot clean.
  for _ in $(seq 1 12); do
    getent hosts "$INGRESS_HOST" >/dev/null 2>&1 && break
    echo "[bootstrap] waiting for DNS ${INGRESS_HOST} ..."
    sleep 10
  done
fi

# ---------------------------------------------------------------------------
# 8. Compose up
# ---------------------------------------------------------------------------
cd "$REPO_DIR"
docker compose --env-file .env "${COMPOSE_FILES[@]}" config -q \
  || { echo "[bootstrap] FATAL: compose files do not validate"; exit 1; }
docker compose --env-file .env "${COMPOSE_FILES[@]}" pull --quiet
docker compose --env-file .env "${COMPOSE_FILES[@]}" up -d --build

echo "[bootstrap] stack up. Status:"
docker compose --env-file .env "${COMPOSE_FILES[@]}" ps

if [ "$STACK_INGRESS_MODE" = "caddy" ]; then
  # Auth smoke test: the public /mcp MUST reject unauthenticated requests.
  # Warn-only — DNS/ACME may still be settling on a first boot.
  AUTH_CODE=$(curl -s -o /dev/null -w '%{http_code}' -m 20 \
    -X POST "https://${INGRESS_HOST}/mcp" -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' || echo 000)
  if [ "$AUTH_CODE" = "401" ] || [ "$AUTH_CODE" = "403" ]; then
    echo "[bootstrap] auth smoke test OK (unauthenticated /mcp -> $AUTH_CODE)"
  else
    echo "[bootstrap] WARNING: unauthenticated /mcp returned $AUTH_CODE (expected 401/403) - VERIFY AUTH BEFORE USE"
  fi
fi

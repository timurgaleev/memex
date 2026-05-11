#!/bin/bash
# bootstrap.sh — runs on every EC2 boot via cloud-init user_data.
# Idempotent: safe to re-run. Fast — ~30s on cold boot, ~2s on warm.
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
: "${STACK_SUBDOMAIN:=stack}"
: "${STACK_MEMEX_SUBDOMAIN:=memex}"

# ---------------------------------------------------------------------------
# 1. System packages
# ---------------------------------------------------------------------------
dnf install -y docker git amazon-efs-utils jq aws-cli unzip
systemctl enable --now docker

# 1b. Install docker compose v2 plugin (AL2023's docker package doesn't ship it).
COMPOSE_VERSION="v2.30.3"
COMPOSE_PLUGIN_DIR="/usr/libexec/docker/cli-plugins"
COMPOSE_PLUGIN="${COMPOSE_PLUGIN_DIR}/docker-compose"
ARCH_DC=$(uname -m)  # aarch64 or x86_64 — both used in compose release names
if [ ! -x "$COMPOSE_PLUGIN" ] || [ "$($COMPOSE_PLUGIN version --short 2>/dev/null || echo)" != "${COMPOSE_VERSION#v}" ]; then
  echo "[bootstrap] installing docker compose ${COMPOSE_VERSION} (${ARCH_DC})"
  mkdir -p "$COMPOSE_PLUGIN_DIR"
  curl -fsSL "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-${ARCH_DC}" \
    -o "$COMPOSE_PLUGIN"
  chmod 0755 "$COMPOSE_PLUGIN"
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
for d in vault memex workspace skills credentials .obsidian-headless-config; do
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
cat > "${REPO_DIR}/.env" <<EOF
# Generated by scripts/bootstrap.sh at boot — overwrites any prior file.
PROJECT=${STACK_PROJECT}
AWS_REGION=${STACK_AWS_REGION}
AWS_PROFILE=default
SECRETS_PREFIX=${STACK_SECRETS_PREFIX}
DOMAIN=${STACK_DOMAIN}
SUBDOMAIN=${STACK_SUBDOMAIN}
MEMEX_SUBDOMAIN=${STACK_MEMEX_SUBDOMAIN}
PUBLIC_HOST=${STACK_SUBDOMAIN}.${STACK_DOMAIN}
MEMEX_HOST=${STACK_MEMEX_SUBDOMAIN}.${STACK_DOMAIN}
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
chmod 0600 /home/ec2-user/.aws/config

# ---------------------------------------------------------------------------
# 8. Compose up
# ---------------------------------------------------------------------------
cd "$REPO_DIR"
docker compose --env-file .env -f deploy/docker-compose.yml pull --quiet
docker compose --env-file .env -f deploy/docker-compose.yml up -d --build

echo "[bootstrap] stack up. Status:"
docker compose --env-file .env -f deploy/docker-compose.yml ps

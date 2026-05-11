#!/bin/bash
# obsidian-sync entrypoint.
# Idempotent boot:
#   1. login if not already logged in (uses email/password/totp_secret from secret)
#   2. if vault not yet linked locally AND secret has vault_id+encryption_password
#      → run `ob sync-setup` non-interactively
#   3. exec `ob sync --continuous`
#   4. fallback: stay alive with a clear "manual sync-setup needed" hint so
#      docker restart policy doesn't burn CPU in a tight loop
set -euo pipefail

VAULT="/vault"
SECRET="/run/secrets/obsidian-sync.json"

# `set -u` blows up on any unset reference; default XDG_CONFIG_HOME if not provided
# (compose sets it, but be tolerant for one-off `docker run` invocations).
: "${XDG_CONFIG_HOME:=/root/.config}"
export XDG_CONFIG_HOME

require_secret() {
  if [ ! -s "$SECRET" ]; then
    echo "[obsidian-sync] FATAL: $SECRET missing or empty — fetch-secrets.sh did not run"
    exit 1
  fi
}

login_if_needed() {
  # `ob login` (no flags) prints status. Match "Logged in as" to skip re-login.
  if ob login 2>&1 | grep -qi "logged in as"; then
    echo "[obsidian-sync] already logged in"
    return 0
  fi

  require_secret
  local email password totp
  email=$(jq -r .email "$SECRET")
  password=$(jq -r .password "$SECRET")
  totp=$(jq -r '.totp_secret // empty' "$SECRET")

  if [ -n "$totp" ]; then
    local mfa
    mfa=$(oathtool --totp -b "$totp")
    ob login --email "$email" --password "$password" --mfa "$mfa"
  else
    ob login --email "$email" --password "$password"
  fi
}

setup_sync_if_needed() {
  # Already linked? sync-list-local prints "<id>  <name>  <local-path>" per row.
  if ob sync-list-local 2>/dev/null | grep -q "$VAULT"; then
    return 0
  fi

  require_secret
  local vault_id encryption_password
  vault_id=$(jq -r '.vault_id // empty' "$SECRET")
  encryption_password=$(jq -r '.encryption_password // empty' "$SECRET")

  if [ -z "$vault_id" ] || [ -z "$encryption_password" ]; then
    echo "[obsidian-sync] secret is missing vault_id or encryption_password — cannot auto-setup."
    return 1
  fi

  echo "[obsidian-sync] linking $VAULT to remote vault $vault_id ..."
  ob sync-setup \
    --vault "$vault_id" \
    --path "$VAULT" \
    --password "$encryption_password" \
    --device-name "openclaw-container"
  echo "[obsidian-sync] sync-setup complete"
}

login_if_needed

if ! setup_sync_if_needed; then
  cat <<EOF
[obsidian-sync] $VAULT is NOT yet linked to a remote vault, and the secret
'openclaw/obsidian-sync' is missing 'vault_id' and/or 'encryption_password'.

To finish setup, either:
  - add those fields to the secret and 'docker compose restart obsidian-sync'
  - or one-time: docker exec -it deploy-obsidian-sync-1 \\
      ob sync-setup --path /vault --vault <id> --password <encryption>

Sleeping. Container will stay up so you can exec into it.
EOF
  exec sleep infinity
fi

echo "[obsidian-sync] starting continuous sync of $VAULT"
exec ob sync --path "$VAULT" --continuous

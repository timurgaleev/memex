# obsidian-sync — bidirectional Obsidian Sync sidecar

> **⚠️ DEPRECATED — will be removed in a future release.**
> The `obsidian-sync` container is on the deprecation path. Future
> releases will remove this sidecar; vault sync will become a
> user-provided concern (e.g. native Obsidian Sync subscription,
> git-based sync, or any other mechanism that keeps the EFS-mounted
> `vault/` tree current).
>
> Existing deployers can continue to use this container until the next
> major release. New deployers: consider whether you need it at all —
> the rest of the stack works without an active vault sync, indexing
> whatever files appear under `${EFS_MOUNT}/vault/` via memex.

Runs `obsidian-headless@0.0.8` inside a `node:22-alpine` container and
keeps the EFS-mounted vault path in sync with a hosted Obsidian Sync
remote vault.

## What it does

- Logs into Obsidian Sync once at startup using credentials from
  the `<secrets_prefix>/obsidian-sync` AWS secret. TOTP supported via
  `oathtool` (subpackage `oath-toolkit-oathtool` on alpine — the
  meta `oath-toolkit` doesn't include the binary).
- If the local vault isn't yet linked to a remote, runs
  `ob sync-setup` non-interactively using `vault_id` +
  `encryption_password` from the secret.
- Otherwise, runs `ob sync --continuous` which streams changes both
  ways indefinitely.

## Files

| File | Purpose |
|---|---|
| `Dockerfile` | `node:22-alpine` + `jq` + `curl` + `bash` + `oath-toolkit` + `oath-toolkit-oathtool` + `obsidian-headless@0.0.8` |
| `entrypoint.sh` | login if needed → setup-sync if needed → `ob sync --continuous` |

## Why this is a separate container

- Sync state (`XDG_CONFIG_HOME/obsidian-headless`) needs persistence
  across container restarts; mounted from EFS at
  `/mnt/<project>-efs/<project>/.obsidian-headless-config/`.
- The vault directory needs `:rw` to be sync'd both ways — separate
  process boundary so a sync glitch can't corrupt the openclaw
  container's read-only vault view.
- The `obsidian-headless` library has its own deps and update cadence
  independent of openclaw.

## Read more

- `OPERATIONS.md` — first-time login, rotate password, manually
  trigger sync, troubleshoot

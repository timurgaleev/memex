# obsidian-sync — Operations

## Restart

```bash
docker compose restart obsidian-sync
sleep 10
docker compose logs --tail 30 obsidian-sync
```

Expect log lines:
- `[obsidian-sync] already logged in` (or first-time login flow)
- `[obsidian-sync] vault /vault linked - starting continuous sync`
- `[obsidian-sync] starting continuous sync of /vault`

If you see `[obsidian-sync] $VAULT is NOT yet linked` followed by
`Sleeping`: the secret is missing `vault_id` or `encryption_password`.

## Rotate the Obsidian Sync password

When the user changes their Obsidian password:

```bash
aws secretsmanager put-secret-value \
  --secret-id <secrets_prefix>/obsidian-sync \
  --secret-string '{"email":"...","password":"NEW","totp_secret":"..."}' \
  --profile <your-profile> --region <your-region>

cd /opt/<project>
bash deploy/secrets/fetch-secrets.sh
docker compose --env-file .env -f deploy/docker-compose.yml restart obsidian-sync
```

The container does NOT need to be re-paired with the remote vault
afterwards — the local `obsidian-headless-config/` retains the
session state on EFS.

## Force a full re-sync from scratch

```bash
docker compose stop obsidian-sync

# Wipe the local headless config
rm -rf /mnt/<project>-efs/<project>/.obsidian-headless-config/*

docker compose start obsidian-sync
```

The entrypoint will re-login, re-link the vault using `vault_id` +
`encryption_password` from the secret, and run a fresh sync. This is
safe — the encrypted vault content lives remotely; local state is
just a cache + crypto handshake material.

## Inspect remote vault catalog

```bash
docker exec deploy-obsidian-sync-1 ob sync-list-remote
```

Lists every vault attached to the user's Obsidian account along with
its UUID. Use this if you need to populate `vault_id` in the secret.

## Manual `ob` commands

```bash
# log status
docker exec deploy-obsidian-sync-1 ob login

# list local vaults
docker exec deploy-obsidian-sync-1 ob sync-list-local

# one-shot sync (rare)
docker exec deploy-obsidian-sync-1 ob sync --path /vault
```

## Failure modes

| Symptom | Cause / fix |
|---|---|
| `oathtool: command not found` | Alpine `oath-toolkit` is meta — Dockerfile must include `oath-toolkit-oathtool` too |
| Crash-looping with exit 127 | Same as above (binary missing) |
| `[obsidian-sync] sleep infinity` | Secret missing `vault_id`/`encryption_password` — populate via Secrets Manager |
| Vault edits don't propagate | Check the cloud isn't paused (Obsidian → Settings → Sync → status). The container is correct; remote may be stalled. |
| Conflict resolution prompts | obsidian-headless writes `*.conflict` files in `vault/`. Resolve manually then re-sync. |

## Cost notes

Obsidian Sync is a paid Obsidian-side service ($10/mo). The container
itself costs only the minor RAM/disk inside the t4g.medium — no
separate AWS charge.

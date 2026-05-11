# openclaw — Operations

## Deploy

```bash
# from your workstation:
git push origin main

# SSM into the EC2:
aws ssm start-session --target <your-instance-id> \
  --profile <your-profile> --region <your-region>

# inside the EC2 (only when using the SSH deploy-key mode):
export GIT_SSH_COMMAND="ssh -i /root/.ssh/<project>_deploy_key \
  -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
cd /opt/<project> && git pull --ff-only
cd deploy && docker compose up -d --build openclaw
sleep 30
docker compose ps openclaw
```

First boot takes ~3 min (plugin-runtime-deps staging). Healthcheck
passes once the gateway port 18789 opens.

## Logs

```bash
docker compose logs --tail 50 openclaw
docker compose logs -f openclaw   # follow
```

## Restart only (no rebuild)

```bash
docker compose restart openclaw
```

## Re-pair web devices

If `workspace/.gateway-token` is rotated or paired devices break:

```bash
# token currently in use:
cat /mnt/<project>-efs/<project>/workspace/.gateway-token

# delete to force regen:
rm /mnt/<project>-efs/<project>/workspace/.gateway-token
docker compose restart openclaw
```

After regeneration, every previously-paired device must re-pair via
the web UI.

## Telegram bot down?

1. `docker compose logs openclaw | grep -i telegram` — look for
   the provider startup line `[telegram] starting provider (...)`.
2. If you see `npm error code ENOENT, syscall spawn git`: rebuild the
   image (Dockerfile must include `git` in the apk install).
3. If the bot starts but doesn't reply: check Bedrock auth.
   `docker exec deploy-openclaw-1 aws bedrock list-foundation-models
   --region <your-region>` should succeed.

## Helper diagnostics

```bash
# inside the container:
docker exec deploy-openclaw-1 /opt/<project>/bin/memex health
docker exec deploy-openclaw-1 /opt/<project>/bin/memex search "your query"
docker exec deploy-openclaw-1 /opt/<project>/bin/ha states
docker exec deploy-openclaw-1 /opt/<project>/bin/gcal today
docker exec deploy-openclaw-1 /opt/<project>/bin/obsidian read /vault/some-note.md
```

## Cron

```bash
docker exec deploy-openclaw-1 openclaw cron list
docker exec deploy-openclaw-1 openclaw cron runs --id <run-id> --limit 5
```

The `morning-briefing` job runs on its configured schedule. If it
doesn't fire, check the EFS `cron/jobs.json` is intact and that the
container clock matches the host clock (both UTC by default).

## Common failure modes

| Symptom | Cause / fix |
|---|---|
| Telegram replies are npm error stack traces | `git` missing in apk install — rebuild |
| `gcal today` returns 400 | OAuth refresh token expired — see `TODO.md` |
| memex `Aborted()` WASM error | Historical PGLite-on-EFS corruption from before the RDS cutover. Should not recur on Postgres. |
| Web UI 502 / 530 | cloudflared sidecar issue — `docker compose restart cloudflared` |
| `[gateway] update available` log | informational; the npm version is pinned intentionally |

## What NOT to do

- `docker compose down` — cuts traffic and forces full rebuild on next
  up. Use `restart` instead.
- `git reset --hard` inside `/opt/<project>` — that's the deploy tree;
  always `git pull` (creates a clean fast-forward).
- Edit any file inside the container at runtime — bind-mount changes
  on EFS work; in-container changes evaporate on rebuild.

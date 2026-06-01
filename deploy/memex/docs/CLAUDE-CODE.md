# Using memex as an MCP server in Claude Code

memex exposes JSON-RPC MCP at `POST /mcp`. Any MCP-compatible client
(Claude Code, Claude Desktop, Cursor, Codex, …) can talk to it. This
doc covers the public-internet route — Cloudflare Tunnel at
`https://brain.<your-domain>/mcp` with bearer auth.

## Tools exposed

| Tool | What it does | Public default |
|---|---|---|
| `search` | Hybrid retrieve (vector + keyword + RRF) | open |
| `backlinks` | Documents that mention an entity | open |
| `stats` | Counts of documents / chunks / embeddings | open |
| `index` | Index a markdown document | gated by `MEMEX_PUBLIC_WRITE` |
| `log_friction` | Record a friction event | gated by `MEMEX_PUBLIC_WRITE` |

The mutating tools are `403`-blocked at the public guard layer
(`src/http/public_guard.ts`) until `MEMEX_PUBLIC_WRITE=1` is set on
the memex container.

## One-time setup

### 1. Enable public write on the EC2

`deploy/secrets/fetch-secrets.sh` writes `MEMEX_PUBLIC_WRITE=1` into
`deploy/.secrets/memex.env` by default. After pulling the latest
commit on the EC2:

```bash
cd /opt/<project>/deploy
./secrets/fetch-secrets.sh
docker restart deploy-memex-1
```

Verify the container picked it up:

```bash
docker exec deploy-memex-1 printenv MEMEX_PUBLIC_WRITE
# expected: 1
```

### 2. Install the daily bearer-rotation timer

The rotation regenerates the public bearer token on its configured
schedule and restarts memex so it validates against the new value. The
token lives in Secrets Manager — pull it on demand (step 3).

```bash
# Run from the repo root on the EC2.
sudo install -m 0755 \
  scripts/rotate-memex-public-bearer.sh \
  /opt/<project>/bin/rotate-memex-public-bearer.sh

sudo install -m 0644 \
  deploy/systemd/memex-rotate-bearer.service \
  /etc/systemd/system/memex-rotate-bearer.service

sudo install -m 0644 \
  deploy/systemd/memex-rotate-bearer.timer \
  /etc/systemd/system/memex-rotate-bearer.timer

sudo mkdir -p /var/log/<project>
sudo systemctl daemon-reload
sudo systemctl enable --now memex-rotate-bearer.timer
```

Verify:

```bash
systemctl status memex-rotate-bearer.timer
# Active: active (waiting); Trigger: <date> HH:MM:SS
```

You can fire a one-off rotation now to confirm it works:

```bash
sudo systemctl start memex-rotate-bearer.service
sudo journalctl -u memex-rotate-bearer.service --since '5 min ago'
```

### 3. Get the current token

Fetch it from Secrets Manager any time:

```bash
AWS_PROFILE=<your-profile> aws secretsmanager get-secret-value \
  --secret-id <secrets_prefix>/memex-public-bearer \
  --region <your-region> \
  --query SecretString --output text
```

### 4. Configure Claude Code

Edit `~/.claude.json` (global) or `.claude.json` (per-project) and
add the MCP server. Claude Code reads on next restart.

```jsonc
{
  "mcpServers": {
    "memex": {
      "type": "http",
      "url": "https://brain.<your-domain>/mcp",
      "headers": {
        "Authorization": "Bearer <token-from-secrets-manager>"
      }
    }
  }
}
```

After restart, Claude Code surfaces the memex read tools under
`memex.*` (`search`, `backlinks`, `stats`, `page_{get,list,versions}`,
`graph_{neighbors,query}`, `entity_{facts,timeline,recall}`,
`jobs_{list,get,logs}`). Write tools are filtered from the public
surface unless `MEMEX_PUBLIC_WRITE=1`.

## Day-to-day flow

When the daily rotation fires it swaps the bearer in Secrets Manager
and restarts memex. Pull the new token (step 3) and update
`~/.claude.json` after `Bearer `, then reload the MCP connection
(`/mcp` slash command in Claude Code).

The *previous* day's token is invalidated by the new
`put-secret-value` (Secrets Manager keeps it as `AWSPREVIOUS` for one
rollback if needed).

## Failure modes

| Symptom | What to check |
|---|---|
| Claude Code reports `tools/list` empty | Token may be stale — fetch live token from Secrets Manager (step 3 above). |
| `index` returns 403 from Claude Code | `MEMEX_PUBLIC_WRITE` not set on the container (step 1 verification). |
| `index` returns 401 | Bearer header malformed or token rotated since last paste. |
| Token seems stale after rotation | `journalctl -u memex-rotate-bearer.service --since '5 min ago'` to confirm the rotation ran; re-fetch from Secrets Manager (step 3). |

## Local-only alternative — SSM port-forward

If you'd rather not expose write on the public internet at all, you
can leave `MEMEX_PUBLIC_WRITE=0` and tunnel directly from your
workstation when you need write access:

```bash
AWS_PROFILE=<your-profile> aws ssm start-session \
  --target <your-instance-id> \
  --region <your-region> \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters '{"host":["memex"],"portNumber":["18790"],"localPortNumber":["18790"]}'
```

While the session runs, point Claude Code at
`http://localhost:18790/mcp` (no `Authorization` header — the
internal Docker bridge has no public exposure, so no bearer is
required). Close the session and write goes back to "blocked from
public, read-only over Cloudflare".

This is the more conservative posture.

## Security notes

- The bearer lives only in Secrets Manager (encrypted at rest) and in
  your local `~/.claude.json`. Each token is short-lived (daily
  rotation), so the blast radius of a leak is bounded to one day.
- Cloudflare Tunnel is the public surface. Ingress logs flow into
  CloudWatch via the cloudflared sidecar. Anomalous request patterns
  show up there.
- The bearer is stored in Secrets Manager (KMS-encrypted); the
  rotation job runs via systemd as root with the EC2's IAM role —
  never commit a token to git or paste it into shared docs.
- To temporarily lock down: `sudo systemctl stop
  memex-rotate-bearer.timer` keeps the current token forever; flip
  the env back to `MEMEX_PUBLIC_WRITE=0` (in `fetch-secrets.sh` or
  manually in `memex.env`) and `docker restart deploy-memex-1` to
  re-block writes.

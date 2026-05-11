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
schedule, restarts memex, and (optionally) delivers the new token via
Telegram.

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

You can fire a one-off rotation now to confirm Telegram delivery
works:

```bash
sudo systemctl start memex-rotate-bearer.service
sudo journalctl -u memex-rotate-bearer.service --since '5 min ago'
```

### 2b. Install the hourly Gmail poll timer

The Gmail recipe ingests new mail into Postgres (signal-detect via
Nova Lite, embed via Titan v2). Production polling runs hourly via a
systemd timer that calls `memex gmail poll` inside the memex
container.

```bash
sudo install -m 0755 \
  scripts/gmail-poll.sh \
  /opt/<project>/bin/gmail-poll.sh

sudo install -m 0644 \
  deploy/systemd/memex-gmail-poll.service \
  /etc/systemd/system/memex-gmail-poll.service

sudo install -m 0644 \
  deploy/systemd/memex-gmail-poll.timer \
  /etc/systemd/system/memex-gmail-poll.timer

sudo systemctl daemon-reload
sudo systemctl enable --now memex-gmail-poll.timer
```

Verify and fire-once as for the rotation timer.

The recipe's own `throttle.preflight` declines during the configured
quiet-hours window, so ticks inside that window return early with
`reason="throttle:quiet-hours"` — no Gmail/Bedrock cost burned during
the morning briefing.

### 3. Get the current token

After the first rotation runs, the token arrives in Telegram. Until
then, fetch it via:

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
        "Authorization": "Bearer <token-from-telegram>"
      }
    }
  }
}
```

After restart, Claude Code surfaces five tools under `memex.*`:
`search`, `backlinks`, `stats`, `index`, `log_friction`.

## Day-to-day flow

When the rotation fires, Telegram pings you (if delivery is
configured) with the new token. Update `~/.claude.json` with the new
token after `Bearer `. Restart Claude Code (or just the MCP
connection — `/mcp` slash command in Claude Code re-loads).

If you're not actively using Claude Code that day, you can ignore the
Telegram message — the *previous* day's token is invalidated by the
new `put-secret-value` (Secrets Manager keeps it as `AWSPREVIOUS` for
one rollback if needed).

## Failure modes

| Symptom | What to check |
|---|---|
| Claude Code reports `tools/list` empty | Token may be stale — fetch live token from Secrets Manager (step 3 above). |
| `index` returns 403 from Claude Code | `MEMEX_PUBLIC_WRITE` not set on the container (step 1 verification). |
| `index` returns 401 | Bearer header malformed or token rotated since last paste. |
| No Telegram message after rotation | `journalctl -u memex-rotate-bearer.service --since '5 min ago'`. The rotation may have run but Telegram delivery failed. |

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

- Telegram messages persist in chat history. If a device with the
  account gets compromised, every historical token shows up. Each
  token is short-lived, so blast radius is bounded — but keep the
  account scoped to trusted devices.
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

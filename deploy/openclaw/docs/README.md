# openclaw — chat agent container

The user-facing surface of the stack. Wraps `npm openclaw@2026.4.29`
inside a `node:22-alpine` container; serves the gateway on
`127.0.0.1:18789`; reaches the public via the cloudflared sidecar.

## What it does

- Runs `openclaw gateway` with `bind=lan` and token-based auth (web
  paired devices and the Telegram bot use the same token).
- Hosts the chat skills the user invokes: `briefing`, `calendar`,
  `frontmatter-guard`, `homeassistant`, `idea-capture`, `obsidian`,
  `signal-detect`, `soul-audit`, `memex`. Skills are mounted
  read-only from EFS at `/home/openclaw/.openclaw/skills/`.
- Owns the four per-user identity files in `~/.openclaw/`:
  `SOUL.md`, `USER.md`, `ACCESS_POLICY.md`, `HEARTBEAT.md` (seeded
  by `memex init` at the memex side; openclaw reads them).
- Talks to **memex** at `http://memex:18790` (Docker DNS) for
  search / index / backlinks / friction logging via the MCP transport.
- Runs the morning-briefing cron on its configured schedule via the
  `cron/` EFS bind mount.

## Files

| File | Purpose |
|---|---|
| `Dockerfile` | `node:22-alpine` + `aws-cli` + `git` + `python3` + `bash` + `jq` |
| `entrypoint.sh` | generates a random gateway-auth token (persisted on EFS), patches `config.template.json` with the Telegram bot token + token, exports `BRAIN_URL=http://memex:18790`, exec's `openclaw gateway` |
| `config.template.json` | base config; `botToken` and `gateway.auth.token` are filled at boot from secrets |
| `helpers/gcal` | Python — Google Calendar CLI (uses `<secrets_prefix>/google-calendar` secret) |
| `helpers/ha` | Bash — Home Assistant REST API CLI (uses `<secrets_prefix>/home-assistant-token` secret) |
| `helpers/obsidian` | Bash — Obsidian helper (talks to obsidian-sync container) |
| `helpers/memex` | Bash — thin client for `http://memex:18790` (search/index/backlinks/health/log_friction) |

`helpers/*` are mounted into the container at `/opt/<project>/bin/<name>`
so the agent can shell out to them.

## Read more

- `ARCHITECTURE.md` — container layout, mounts, network, integration with memex
- `OPERATIONS.md` — deploy, restart, view logs, troubleshoot Telegram / web

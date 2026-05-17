# telegram-bridge

Standalone two-way Telegram surface for the memex stack. Long-polls
the Telegram Bot API, routes slash-commands to the existing
`gcal` / `ha` helpers, and answers free text with a RAG pipeline
(`memex /search` for retrieval, Bedrock Nova Lite for synthesis).

The bridge is independent of `openclaw` — the bot keeps working even
if the chat-agent container is down, restarting, or stuck on a paired
device approval.

## Configuration

| Env var | Required | Default | Purpose |
|---|---|---|---|
| `AWS_REGION` | yes | — | Bedrock + Secrets Manager region. |
| `MEMEX_BRIDGE_ALLOWED_CHAT_IDS` | yes | — | Comma-separated numeric Telegram chat ids that may use the bot. |
| `SECRETS_PREFIX` | no | `memex` | Namespace for Secrets Manager reads inside the helpers. |
| `MEMEX_URL` | no | `http://memex:18790` | Where to POST `/search`. |
| `MEMEX_BRIDGE_LLM_MODEL` | no | `global.amazon.nova-2-lite-v1:0` | Bedrock model id for RAG synthesis. |
| `MEMEX_BRIDGE_MAX_HITS` | no | `5` | Top-k retrieval before reranking + synthesis. |
| `MEMEX_BRIDGE_LLM_DISABLE` | no | unset | Set to `1` to skip Bedrock entirely (retrieval-only replies). |
| `MEMEX_BRIDGE_STATE_DIR` | no | `/var/lib/memex-bridge` | Where `state.json` (last update id) lives. |
| `MEMEX_BRIDGE_HELPER_DIR` | no | `/opt/memex/bin` | Where to find the `gcal` / `ha` CLIs. |
| `TELEGRAM_BOT_TOKEN_FILE` | no | `/run/secrets/telegram-bot-token.txt` | Bearer source — populated by `deploy/secrets/fetch-secrets.sh`. |

## Commands

| Command | What it does |
|---|---|
| `/today`, `/tomorrow`, `/week` | Calls `gcal <subcmd>` and replies with the events. |
| `/weather` | Calls `ha states weather` for the home weather entity. |
| `/search <query>` | Hybrid retrieval over the vault — returns top hits with excerpts. |
| `/ask <query>` (or any non-`/` text) | RAG: retrieves top-k hits and synthesises a short answer via Bedrock. |
| `/health` | Probes `memex /health` and reports liveness + database backend. |
| `/help`, `/start` | Help text. |

## Coexistence with openclaw

Telegram only allows one consumer of `getUpdates` per bot token. If
`openclaw` is *also* configured for the same bot, one of the two
loses with `409 Conflict`. The bridge handles 409 with capped
exponential backoff (5s → 120s) so a misconfigured deployment doesn't
hammer the API, but for steady-state operation pick one owner:

* **bridge owns the bot** (recommended) — the systemd timer that
  starts this container plus the bridge are the only consumers.
  Drop the `channels.telegram` block from
  `deploy/openclaw/config.template.json` and rebuild openclaw.
* **openclaw owns the bot** — disable the bridge service in
  `docker-compose.yml` (`profiles: ["legacy"]`) and re-enable
  openclaw's Telegram channel.

## Operating

```bash
# rebuild + restart
docker compose --env-file .env -f deploy/docker-compose.yml up -d --build telegram-bridge

# logs
docker compose --env-file .env -f deploy/docker-compose.yml logs -f telegram-bridge

# liveness from the container
docker exec deploy-telegram-bridge-1 cat /var/lib/memex-bridge/state.json
```

## Failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| Bridge starts, exits with `FATAL: bot token missing` | `deploy/.secrets/telegram-bot-token.txt` not written | run `bash deploy/secrets/fetch-secrets.sh` on the host |
| Bridge logs `409 Conflict — another consumer holds this bot` | openclaw is also long-polling | drop the openclaw telegram channel or disable the bridge |
| Bot replies "no matches in your notes" to everything | `memex` container down or empty | `docker compose ps memex` + `/health` |
| Bot replies "(no output)" to `/today` | `gcal` helper not authenticated | re-run `scripts/gcal-oauth-bootstrap.sh` from the operator's laptop |
| Bot replies with retrieval list but no synthesis | Bedrock invoke failed (IAM, model id, quota) | check `docker logs deploy-telegram-bridge-1 \| grep bedrock` |

# telegram-bridge

The chat handler for the memex stack. A thin Python 3 daemon (stdlib
only, no pip) that long-polls the Telegram Bot API, routes slash
commands to the helper CLIs (`gcal`, `ha`), and answers free text with
a RAG pipeline (memex MCP `tools/call name=search` for retrieval,
Bedrock Claude Haiku 4.5 via Converse for synthesis).

The bridge owns the chat path end-to-end. There is no agent framework
in the middle — the entire flow is `Telegram → bridge dispatch → (helpers
or MCP+Bedrock) → reply`.

## Configuration

| Env var | Required | Default | Purpose |
|---|---|---|---|
| `AWS_REGION` | yes | — | Bedrock + Secrets Manager region. |
| `MEMEX_BRIDGE_ALLOWED_CHAT_IDS` | yes | — | Comma-separated numeric Telegram chat ids that may use the bot. |
| `SECRETS_PREFIX` | no | `memex` | Namespace for Secrets Manager reads inside the helpers. |
| `MEMEX_URL` | no | `http://memex:18790` | Memex MCP endpoint (`/mcp` is appended automatically). |
| `MEMEX_BRIDGE_LLM_MODEL` | no | `eu.anthropic.claude-haiku-4-5-20251001-v1:0` | Bedrock model id for RAG synthesis. |
| `MEMEX_BRIDGE_MAX_HITS` | no | `5` | Top-k retrieval before synthesis. |
| `MEMEX_BRIDGE_LLM_DISABLE` | no | unset | Set to `1` to skip Bedrock entirely (retrieval-only replies). |
| `MEMEX_BRIDGE_STATE_DIR` | no | `/var/lib/memex-bridge` | Where `state.json` (last update id) lives. |
| `MEMEX_BRIDGE_HELPER_DIR` | no | `/opt/memex/bin` | Where to find the `gcal` / `ha` CLIs. |
| `TELEGRAM_BOT_TOKEN_FILE` | no | `/run/secrets/telegram-bot-token.txt` | Bot token source — populated by `deploy/secrets/fetch-secrets.sh`. |
| `MEMEX_BRIDGE_BEARER_FILE` | no | `/run/secrets/memex-public-bearer.txt` | Memex MCP bearer source — populated by `deploy/secrets/fetch-secrets.sh`. |

## Commands

| Command | What it does |
|---|---|
| `/today`, `/tomorrow`, `/week` | Calls `gcal <subcmd>` and replies with the events. |
| `/weather` | Calls `ha states weather` for the home weather entity. |
| `/search <query>` | Hybrid retrieval over memex — returns top hits with excerpts (no LLM). |
| `/ask <query>` (or any non-`/` text) | RAG: retrieves top-k hits and synthesises a short answer via Bedrock. |
| `/health` | Probes `memex /health` and reports liveness + database backend. |
| `/help`, `/start` | Help text — the same menu shown above. |

## Allowlist behaviour

Telegram bots are discoverable by username, so anyone can message
`@<your-bot>` once they know it exists. The bridge refuses every chat
id that is not on `MEMEX_BRIDGE_ALLOWED_CHAT_IDS` and sends at most
**one** polite refusal per unknown id (the `RefusalGate` caps memory +
Telegram-quota burn under enumeration attacks).

To find your own chat id, message the bot once before allowlisting:
the bridge logs `ignoring message from unallowed chat id <N>` at INFO
on the first refusal per id.

## Prompt-injection defences

Notes retrieved from memex are untrusted input. The bridge:

- Wraps every chunk in `<note id="…">…</note>` and the user question in
  `<user_question>…</user_question>` so the system prompt knows what to
  trust.
- Pre-scrubs literal `<note>`, `<system>`, `<assistant>`, `<user>`,
  `[INST]`, `</s>` and similar role tokens from chunk text by
  replacing the angle brackets with safe glyphs (`⟨`/`⟩` and `⟦`/`⟧`),
  so a poisoned note cannot fake a closing tag and inject prose.
- Strips zero-width / NUL / BOM characters before scrubbing so a tag
  hidden by `<n​ote>` still resolves the same way.
- Wraps every URL the LLM emits in backticks (`_defang_urls`) so
  Telegram's auto-linker doesn't make a hallucinated phishing URL
  tappable.

## Memex MCP wiring

Every call into memex goes through the JSON-RPC endpoint at
`POST /mcp` with `Authorization: Bearer <public-bearer>`. The bearer
lives in `/run/secrets/memex-public-bearer.txt` (mode `0444`,
sibling-readable inside the `.secrets/` dir) and is loaded once at
startup by `serve()`. The `memex-rotate-bearer.timer` systemd unit
restarts this container after each daily rotation so the bridge picks
up the new value; a sub-second 401 window exists between memex's
restart and the bridge's restart, which self-heals on the next
message.

```python
# main.py — search_memex (simplified)
body = {
  "jsonrpc": "2.0", "id": 1,
  "method": "tools/call",
  "params": {"name": "search", "arguments": {"q": query, "k": k}},
}
headers = {
  "Content-Type": "application/json",
  "Accept": "application/json, text/event-stream",
  "Authorization": f"Bearer {bearer}",
}
# POST → unwrap result.content[0].text → JSON parse → hits[]
```

## Operating

```bash
# rebuild + restart
docker compose --env-file .env -f deploy/docker-compose.yml up -d --build telegram-bridge

# logs
docker compose --env-file .env -f deploy/docker-compose.yml logs -f telegram-bridge

# liveness from the container
docker exec deploy-telegram-bridge-1 cat /var/lib/memex-bridge/state.json

# MCP smoke from inside the bridge (proves the bearer + path + RPC envelope)
docker exec deploy-telegram-bridge-1 sh -c '
  BEARER=$(cat /run/secrets/memex-public-bearer.txt)
  curl -fsS -X POST http://memex:18790/mcp \
    -H "Authorization: Bearer $BEARER" -H "Content-Type: application/json" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"search\",\"arguments\":{\"q\":\"hello\",\"k\":1}}}"
'
```

## Failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| Bridge starts, exits with `FATAL: bot token missing` | `deploy/.secrets/telegram-bot-token.txt` not written | run `bash deploy/secrets/fetch-secrets.sh` on the host |
| Bridge starts, exits with `FATAL: bot token file missing at /run/secrets/memex-public-bearer.txt` | bearer not provisioned in Secrets Manager (fresh install) | `terraform apply` creates the random_password resource; then re-run `fetch-secrets.sh` |
| Bot replies "no matches in your notes" to everything | `memex` container down, RDS unreachable, or bearer stale | `docker compose ps memex`, hit `/health`, restart the bridge |
| Bot replies "(no output)" to `/today` | `gcal` helper not authenticated | re-run `scripts/gcal-oauth-bootstrap.sh` from the operator's laptop |
| Bot replies with retrieval list but no synthesis | Bedrock invoke failed (IAM, model id, quota) | check `docker logs deploy-telegram-bridge-1 \| grep bedrock` |
| Bridge logs `409 Conflict` from Telegram | another `getUpdates` consumer holds the same bot token | exactly one consumer per token; if a stray instance exists, kill it |

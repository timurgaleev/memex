# morning-briefing — archived 2026-05-22

This directory holds the daily 07:00 Europe/Berlin Telegram briefing that
ran on EC2 before the openclaw chat agent was removed from the stack.
The files are preserved (not deleted) so a future re-implementation can
reuse the systemd plumbing, the formatting, and the helper-call patterns.

## Why it stopped

The script shells into `deploy-openclaw-1` via `docker exec` to drive the
embedded-agent skill that composed the briefing. With openclaw removed
(see the 2026-05-22 architectural pivot — the telegram-bridge container
now owns the chat path end-to-end), `docker exec deploy-openclaw-1 …`
exits 1 and the briefing never delivers.

## How to revive

The replacement plan should:

1. Move composition from the openclaw embedded agent → a small Python /
   bash script that runs on the host and calls the helper CLIs at
   `/opt/memex/bin/` (`ha states weather`, `gcal today`, `gmail latest`,
   etc.) directly — same way the telegram-bridge does in `main.py`.
2. Compose the message text on the host. Optionally call Bedrock
   Converse (Claude Haiku 4.5) for prose synthesis — same model the
   bridge uses; the existing IAM role grants `bedrock:InvokeModel` on
   the EU inference profile.
3. POST the result to `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`
   with `chat_id=${MEMEX_BRIEFING_CHAT_ID}` and the bot token fetched
   from Secrets Manager (`<secrets_prefix>/telegram-bot-token`).
4. Drop the `MEMEX_BRIEFING_CONTAINER` env var entirely.
5. Re-stage the systemd units under `deploy/systemd/` (timer + service)
   and add the matching `tests/test_systemd_units.py` discovery to pick
   them up.

## File inventory

- `morning-briefing.sh` — the old composer. Reference value: the
  fallback / error-handling pattern is good (every helper invocation
  is wrapped so a single failure becomes `"—"`/`"unknown"` instead of
  killing the whole pipeline). Reuse that scaffolding.
- `memex-morning-briefing.service` — oneshot ExecStart pointing at the
  script. Stayed at `User=root` because helpers fetch their own creds
  via the EC2 IAM role.
- `memex-morning-briefing.timer` — `OnCalendar=*-*-* 07:00:00`,
  `Persistent=true`, `Unit=memex-morning-briefing.service`.

## Original architectural decisions worth remembering

- `set -uo pipefail` (no `-e`): a failing helper must not kill the whole
  briefing. Each step does its own error wrapping so the script's
  overall exit code reflects only the final Telegram delivery.
- The `.env` source pattern: only `KEY=value` lines, never full `.`
  sourcing — group-writable `.env` would be root privilege escalation.
- Helper credentials all come from Secrets Manager via the EC2 IAM
  role; the briefing script itself only needs `AWS_REGION` +
  `SECRETS_PREFIX` + `MEMEX_BRIEFING_CHAT_ID`.

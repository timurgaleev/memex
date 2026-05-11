---
title: telegram-history
description: Recover prior context from past Telegram conversations by searching openclaw's session memory. Use when user references something said earlier "in chat" — Telegram itself has no history API exposed to the bot.
tags: [memory, telegram]
---

# telegram-history — Reach Back Into Past Chats

The Telegram Bot API gives the bot **no history access** — it only
sees messages sent live while the bot is running, plus the long-poll
offset. There's no "show me what we said yesterday" call.

What we DO have:

1. **openclaw session memory** at `<efs>/<project>/workspace/memory/` —
   per-session journal entries that openclaw writes after meaningful
   exchanges. Indexed by memex at `/memory`.
2. **Cron run history** at `<efs>/<project>/cron/runs/` — full transcripts
   of every cron-triggered run (morning briefing, etc.).
3. **Delivery queue** at `<efs>/<project>/delivery-queue/` — outbound
   messages the bot couldn't deliver immediately.

## How to find past content

```bash
# Search session memory by topic:
/opt/<project>/bin/memex search "<keyword from past chat>"

# Constrain to memory only (when sources filter is wired):
/opt/<project>/bin/memex search "..." --sources session-memory
```

Or via MCP: `tools/call name=search arguments={ q: "...", k: 5 }`.

## When the user asks about something specific

- *"What did I say about X yesterday?"* — search memex for X with
  small `k`, then check the matched chunk's `sourcePath`. If it's
  `/memory/...`, that's a session-memory hit; serve the content.
- *"Find that message about Y"* — same. If memex finds nothing,
  the session journal didn't catch it (not every TG message
  becomes a journal entry — only signal-detect-positive ones).
- *"How did we resolve Z?"* — cross-reference memex hits AND the
  vault directly. Resolutions usually become vault notes.

## What this skill is NOT

- Not a literal Telegram message archive — those don't exist
  on our side. Don't promise *"I'll find your exact message from
  3pm Tuesday"* — you can't.
- Not for Telegram-platform actions (bot config, group settings) —
  those happen via @BotFather, not us.

## When you can't find what they want

Say so directly: *"I don't have that in session memory. Can you
paste the relevant bit?"*. **Don't fabricate** content from past
chats — log a `log_friction` event with kind `search-miss` and
`extra: { skill: "telegram-history" }` so `memex friction
propose-fix` can group the miss with this skill.

## Future work

Literal Telegram message ingestion is deferred — it would require the
chat agent to persist raw message bodies. Until then, session memory
is the substitute.

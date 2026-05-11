# Morning Briefing — Format & Sources

Use this skill to construct a daily morning briefing for the operator.
Triggered by the `morning-briefing` cron (target=isolated, delivery via
Telegram to the configured chat id — see `<secrets_prefix>/telegram-bot-token`
for the bot, and the cron config for the chat target). The cron runs in
a fresh isolated session, so be explicit about everything the briefing
needs.

---

## Output structure

Render as plain Telegram-friendly text, no markdown headings. Order
matters — most-actionable first:

1. **Date / weather** — one line with the date and a short forecast. Use
   the HA helper for live readings; fall back to a forecast service only
   if HA is unreachable.
2. **Today's calendar** — `gcal today` output. If empty, say "no
   calendar events today" — do not fabricate.
3. **Home status** — pulled via `ha`:
   - any open windows / doors → list
   - any low-battery sensors (< 30%) → list
   - thermostats currently heating / cooling → list room + setpoint
   - if everything is normal, say "home is quiet"
4. **Task surface** — top 3 inbox items modified in the last 24 h, OR
   pinned items in the operator's task note if it exists. Pull via
   `obsidian search` and the `memex` skill — prefer brain hits over greps
   because the brain ranks by relevance.
5. **Yesterday's session crumbs** — single sentence about what was
   discussed in the prior chat session, sourced from
   `workspace/memory/<date>*.md`. Skip if nothing meaningful.

Keep total under ~250 words. Telegram clips long messages.

---

## Tools to use

```bash
/opt/<project>/bin/ha states
/opt/<project>/bin/ha get /api/states/sensor.outdoor_temp
/opt/<project>/bin/gcal today
/opt/<project>/bin/memex search "today briefing context" 5
/opt/<project>/bin/obsidian read <path-in-vault>
```

---

## Hard rules

- **Scope guard.** Only include the categories above. Do not pull in
  unrelated content (work tickets, code searches, etc.) — those belong
  to other sessions.
- **No fabricated facts.** If a tool fails, say so explicitly: `"could
  not reach home assistant"` is better than guessing.
- **Don't repeat yesterday's briefing.** If `memex search` returns
  yesterday's briefing as a hit, skip it.
- **Quiet hours respected.** The cron schedule enforces the morning
  slot; do not extend the briefing beyond what's actionable that
  morning.

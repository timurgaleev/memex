---
title: soul-audit
description: Read SOUL.md / USER.md / ACCESS_POLICY.md / HEARTBEAT.md before any major task; align voice + scope with what's there
tags: [soul, audit]
---

# soul-audit — Stay grounded between sessions

Before tackling anything that needs personal calibration (writing on
behalf of the user, designing UX, deciding scope), read the four
"soul" files in `~/.memex/` (paths inside the EFS mount on the
deployed stack):

- `SOUL.md` — agent identity (voice, values, hard constraints)
- `USER.md` — user profile (background, working style, current focus)
- `ACCESS_POLICY.md` — who's allowed which capabilities through which
  channel
- `HEARTBEAT.md` — operational state (last cycle, stale counts, open
  friction, pending tasks)

These are seeded by `memex init` from `templates/*.md.template` and
maintained by the user (and / or the agent) over time. They live
locally, never in the synced vault, never indexed by `/index`.

## When to consult

| Trigger | Files |
|---|---|
| New session start | SOUL + USER (read once, internalise) |
| Drafting a chat reply | SOUL (voice) + USER (preferences) |
| Choosing what tool to call | ACCESS_POLICY (capability check) |
| Reporting health / status | HEARTBEAT (numbers come from here) |
| Deciding "should I do X" | SOUL (hard constraints) |

## When to update

- Promote a learned preference into USER ("user prefers terse replies")
  rather than carrying it across only via memory.
- Append to HEARTBEAT after each cycle so the morning briefing has
  fresh numbers.
- Edit SOUL only when the agent's mandate genuinely shifts (rare).

---
title: task-prep
description: Before tackling a task, gather context — read SOUL/USER/HEARTBEAT, search the brain for related history, surface relevant constraints. Run BEFORE doing the work, not after.
tags: [tasks, planning]
---

# task-prep — Get Ready Before Doing

When the user gives you a non-trivial task, slow down for one round
trip: pull the context that probably matters before you start
typing code or writing prose.

## What to consult, in order

1. **SOUL.md** at `~/.memex/SOUL.md` — voice, values, hard constraints
2. **USER.md** at `~/.memex/USER.md` — current focus, tools, habits
3. **ACCESS_POLICY.md** at `~/.memex/ACCESS_POLICY.md` — am I allowed
   to do what's being asked through this channel?
4. **HEARTBEAT.md** at `~/.memex/HEARTBEAT.md` — open friction,
   pending operator tasks, last cycle timestamps
5. **Brain search** for the topic — `memex search "..."` to surface
   any prior decisions, related notes, recurring themes
6. **TODO.md** at the repo root — is this task already deferred or
   conflicting with something explicitly punted?

## When to skip

- Single-shot questions ("what time is it") — answer directly.
- Pure-mechanics commands ("rerun the build") — answer directly.
- Anything where prep would take longer than the task itself.

For everything else **prep is cheap and saves you from misaligned
output**. The user has already taken the time to build the brain;
use it.

## How to convey what you found

When prep surfaces relevant context, lead with it briefly:

> Per `USER.md`, you're focused on infra hardening this week, and
> the brain has 3 prior notes about memex SIGKILL handling. With
> that in mind, here's the change…

Don't dump the whole context — distill to the 1-2 facts that change
your approach.

## What this skill is NOT

- Not the actual work — it's the read-pass before the work.
- Not stalling — if prep doesn't reveal anything useful, say so and
  proceed in 1-2 sentences.
- Not a substitute for asking the user a clarifying question when
  one is genuinely needed.

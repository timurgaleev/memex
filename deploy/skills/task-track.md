---
title: task-track
description: Use openclaw's cron + delivery-queue to surface "what's open" across sessions. Append to HEARTBEAT.md when a task is done; mark in-flight items so the next session knows where to pick up.
tags: [tasks, ops]
---

# task-track — Make Work Resumable

The user works in many short sessions. Without explicit tracking,
context vanishes and the next session re-derives the same plan.
This skill keeps state outside the chat.

## State lives in three places

| Where | What |
|---|---|
| `<efs>/<project>/cron/jobs.json` | scheduled recurring tasks (morning briefing, weekly retro etc.) |
| `<efs>/<project>/delivery-queue/` | undelivered notifications from finished cron runs |
| `<efs>/<project>/HEARTBEAT.md` | human-edited "open friction" + "pending operator tasks" sections |

## When you start a task

- Read `HEARTBEAT.md` § Pending operator tasks — is this already there?
- If yes, mark "in-flight YYYY-MM-DD HH:MM <tz>" inline.
- If no, decide whether it's worth tracking. Trivial one-shots aren't.

## When you finish a task

- Strike the line in `HEARTBEAT.md` (markdown `~~strike~~`) or remove it.
- Add a short bullet under § Last check noting what shipped.
- If the task uncovered new follow-ups, add them to the same section.

## Use cron for recurring obligations

- Don't manually re-check things that should fire on schedule. Add a
  cron job via the chat agent's cron interface.
- Cron jobs live on EFS, persist across instance replacement.
- Check existing schedule via the chat agent's cron-list command.

## What this skill is NOT

- Not a Linear / Jira replacement — single-user, low-volume tasks.
- Not for granular sub-task tracking inside a single session — use
  TodoWrite for that.
- Not where decisions live — those go to the vault directly.

## When you suspect drift

If the user mentions a task you don't see in HEARTBEAT or cron,
ask *"is this in HEARTBEAT or should I add it?"*. Beats silently
re-deriving.

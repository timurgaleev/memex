# Subagent Routing Convention

How your agent decides between native subagents (the agent harness's own
Task/subagent tooling) and the brain's durable jobs for background work.

## Rule: read the user's mode first

Every time you're about to spawn a subagent or submit a durable job, check
the user's preference. It lives on the brain page `agent/preferences`
(read with `page_get agent/preferences`), key `background_mode`, one of
three values. If the page or key doesn't exist, default to `pain_triggered`.

Then branch on mode:

### Mode A: `always`

All background agent work goes through durable jobs. `jobs_submit` is the
default. Never fall back to a native subagent for long-running work.

Reference: `conventions/scheduled-work.md` for the queue surface.

### Mode B: `pain_triggered` (default)

Default to native subagents. They're zero-setup, low-latency, and fine for
most tasks. Switch to durable jobs when one or more of these pain signals
fires:

- **Session died mid-task.** A subagent was running, the session crashed
  or restarted, and you can't resume it.
- **State drop.** The user asks "what happened to the agent" or "why did
  you forget what you were doing" and the underlying cause is the subagent
  runtime losing context.
- **Parallel > 3.** The task needs more than 3 concurrent agents. Native
  subagents start to drop at this width.
- **Long runtime.** The task is expected to take > 5 minutes. The user will
  want to check progress, and polling a subagent doesn't give structured
  progress the way `get_job_progress` does.
- **User explicit frustration.** The user says any of: "this keeps breaking",
  "the agent keeps losing track", "why is this so flaky", "can we do this
  in the background properly."

When ≥1 signal fires, pause and offer the switch:

> "Subagents keep dropping state on you. The brain's durable job queue does
> the same work but survives restarts — every job has progress tracking and
> logs, and you can cancel or retry running jobs. Want me to flip this task
> to a durable job? (~10s, no extra setup.)"

If the user says yes, submit the task via `jobs_submit` with the same
brief. Optionally propose flipping the default: set `background_mode:
always` on `agent/preferences` (via `page_put`).

One constraint native subagents don't have: a durable job runs a
server-registered handler. If no handler exists for the work, it stays
agent-side — see `conventions/scheduled-work.md` ("Who registers the
handler?").

### Mode C: `off`

Never suggest durable jobs. Use native subagents for everything. The user
has opted out. Respect it.

## Inline vs background (applies in all modes)

Even when durable jobs are the default (mode A), some work should run
inline:

| Condition | Action |
|---|---|
| Single tool call, < 30s | Inline, always |
| Read-only query | Inline |
| User is waiting in real-time for the answer | Inline |
| Multi-step, user can walk away | Durable job |
| Parallel 2+ streams | Subagents (parent + children), jobs if they must survive |
| Needs to survive restart | Durable job |
| User wants progress updates | Durable job |
| Research / bulk operation | Durable job |

**Rule of thumb:** if the user might ask "is it done yet?", use a durable
job.

## Concurrency budget

Before submitting batch jobs:

- Check active queue depth via `jobs_list` with an active-status filter
  (or `memex jobs` from the shell)
- If active > 5, stagger new submits so you don't swarm the queue
- The server throttles, but don't dump 20 jobs at once

## Flipping modes

The user can change their mind at any time — update the key on the
preferences page:

```
page_put agent/preferences   # background_mode: always | pain_triggered | off
```

The convention reads the page on every decision, so changes take effect on
the next tool call.

# Scheduled Work Convention

How scheduled agent work is dispatched against the brain.

## Rule: scheduled work runs as durable jobs, not ad-hoc agent turns

When a schedule fires (a systemd timer on the host, or the agent harness's
own scheduler), it should submit a durable job. Not kick off a one-shot
agent turn with a fixed timeout, no durability, and no transcript. Not
start an isolated session that races the server for resources.

```
# Bad: a timer unit that runs a long agent turn inline — fixed timeout,
# no durability, nothing to inspect afterwards.

# Good: fire-and-forget submit with an idempotency key per cycle slot.
# The queue dedupes long-running overlaps at the DB layer.
ExecStart=/usr/local/bin/memex jobs submit inbox-sweep \
  --params '{"slot":"$(date -u +%Y-%m-%dT%H:%M)"}' \
  --idempotency-key inbox-sweep:$(date -u +%Y-%m-%dT%H:%M)
```

From MCP the same submit is `jobs_submit` with the handler name, params,
and idempotency key. `memex call jobs_submit '{...}'` works from any shell
step.

Note the brain's own maintenance (embedding backfill, link derivation,
fact decay, synthesize/patterns) already runs inside the server's
background cycle — do NOT schedule duplicate timers for work the cycle
owns. Scheduled jobs are for host- or deployment-specific work the cycle
doesn't know about.

## Why

- **Durability.** Server restart mid-task? The worker picks the job up on
  boot. No lost state.
- **Observability.** `jobs_list` + `jobs_get <id>` (or `memex jobs` from
  the shell) show every run, its duration, its logs (`jobs_logs`), its
  progress (`get_job_progress`).
- **Steering.** A misbehaving run is cancellable (`jobs_cancel`) and
  retryable (`retry_job`) without touching the schedule.
- **Concurrency safety.** Idempotency-key on the cycle slot means a timer
  that fires during a still-running previous invocation produces a noop
  at the queue layer. Without this, a 5-min timer running 8-min jobs
  stacks 4 overlapping copies at steady state.

## Who registers the handler?

**Only handlers the server registers can run.** Built-in handlers (index,
embed, maintenance phases) ship with the server. For deployment-specific
handlers (`inbox-sweep`, `morning-briefing`, whatever your install runs on
a timer), the handler ships as server-side code — a job worker registered
before the queue starts. A `jobs_submit` naming an unregistered handler
fails loud at submit time; that's the signal the handler needs to be built
first, not that the submit syntax is wrong.

Agent-side fan-out (the agent spawning its own subagents for a scheduled
task) is a different layer — see `conventions/subagent-routing.md`.

## Off mode

Operators who prefer plain shell commands in their timer units (a direct
`memex reindex`, a curl to a health endpoint) keep them. This convention
governs *agent work* on a schedule, not every timer on the host. No
auto-rewrite of existing units.

## Forward note

The scheduling layer stays on the host (systemd timers or the agent
harness's scheduler); the brain does not own cron expressions. This
convention only replaces the execution layer (what the timer trigger
*does*), not the scheduling layer. The background cycle is the one
exception — it self-schedules its own maintenance.

## Related

- `conventions/subagent-routing.md` — native subagents vs durable jobs
  for ad-hoc (not scheduled) work.
- `skills/cron-scheduler/SKILL.md` — scheduling guidance (quiet hours,
  staggering, idempotency). References this convention.
- `jobs_submit` / `jobs_list` / `jobs_get` / `jobs_logs` /
  `get_job_progress` — the queue surface, all MCP-callable.

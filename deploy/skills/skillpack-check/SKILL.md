---
name: skillpack-check
version: 2.0.0
description: |
  Produce an agent-readable health verdict for the brain install from the
  doctor report (`run_doctor` over MCP, `memex doctor` on the host), plus the
  status and per-source rollups, so a host agent (a morning-briefing run, any
  scheduled check) can see at a glance whether the brain needs attention.

  Use when the user asks "is the brain healthy?", when a timer fires a morning
  check, or proactively when something seems off (jobs not running, brain
  not updating, background cycle silent).
triggers:
  - "is the brain healthy"
  - "brain health"
  - "check the brain"
  - "is the brain working"
  - "health check"
tools:
  - run_doctor
  - get_status_snapshot
  - source_health
mutating: false
---

# Skillpack Check

## Contract

The verdict comes from the doctor. Over MCP, call `run_doctor` (operator
only, read-only, no LLM). On the host, `memex doctor` prints the same report
as JSON and exits `0` when healthy, `1` when any check failed.

The report carries:

- **`ok`** (bool): true when no check failed.
- **`status`**: the overall verdict.
- **`checks`** (array): each check with `name`, `category`, `status`
  (`ok` / `warn` / `fail`) and a `detail` line; a failing detail often names
  the fix.
- **`summary.ranked_failures`**: the failures, most urgent first — read these
  before anything else.

Add `get_status_snapshot` for the one-glance rollup (counts, cache, jobs) and
`source_health` when you need to know which source stopped updating.

## When to run

- **Daily timer** (e.g. a systemd timer feeding the morning briefing): run
  `memex doctor` and look only at the exit code; surface a one-liner in the
  briefing when it is non-zero. No JSON noise in happy-path briefings.
- **On demand**: `run_doctor` (or `memex doctor`) for the full report when
  debugging.
- **In a CI pipeline**: same pattern — exit code gates, JSON is the evidence.

## What to do with the output

### Happy path (`ok: true`)

Surface a one-line summary only if asked. Nothing else.

### Action needed (`ok: false`)

Walk `summary.ranked_failures` in order. For each failure, quote the check
name and detail. When the detail names a command, offer to run it — do not
run commands the report does not point at. The usual fixes by failure:

- `memex embed` — embedding coverage has fallen behind. Idempotent; it
  backfills only what is missing.
- `memex reindex` — drift between pages and the search index.
- `memex cycle` — background maintenance is overdue (the server's own cycle
  normally handles this; a manual run catches it up).
- `memex apply-migrations` — schema migrations are pending.

A read-only plan of what the doctor would enqueue for each failing check is
`memex doctor --remediation-plan`; nothing runs until the operator asks.

### The doctor itself failed

If `run_doctor` errors or `memex doctor` crashes, treat it as urgent — a
crashed doctor is worse than a failing check because nothing is known. Check:

1. `memex version` exits 0 on the host
2. The server answers: `memex status` (or the `whoami` tool over MCP)

## Anti-Patterns

- ❌ Mailing or messaging the full JSON from a timer — report the exit code
  and the ranked failures only.
- ❌ Ignoring a doctor crash.
- ❌ Running on every chat turn. Once per hour (or on user request) is plenty.
- ❌ Treating warnings as failures. Only `fail` needs action; `warn` is
  informational.

## Output Format

The skill itself writes nothing; it reports the verdict to the user (or to
the agent's briefing pipeline). One-line summary first, then the ranked
failures with their fix commands, then (only if relevant) the full JSON.

## Related

- `get_status_snapshot` / `memex status` — the one-glance status view.
- `source_health` — per-source ingest state.
- `skills/briefing` — the briefing skill that consumes the one-line summary.

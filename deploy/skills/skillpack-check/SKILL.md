---
name: skillpack-check
version: 1.0.0
description: |
  Run `memex skillpack check` to produce an agent-readable JSON health report
  for the brain install. Wraps `memex doctor` + the embedding/source status
  rollup so a host agent (a morning-briefing run, any scheduled check) can see
  at a glance whether the brain needs attention.

  Use when the user asks "is the brain healthy?", when a timer fires a morning
  check, or proactively when something seems off (jobs not running, brain
  not updating, background cycle silent).
triggers:
  - "skillpack check"
  - "is the brain healthy"
  - "brain health"
  - "check the brain"
  - "is the brain working"
tools:
  - run_doctor
  - get_status_snapshot
  - source_health
mutating: false
---

# Skillpack Check

## Contract

Running `memex skillpack check` returns a JSON report with:

- **`healthy`** (bool): true if no action needed.
- **`summary`** (string): one-line summary safe to quote in a briefing.
- **`actions`** (string[]): every remediation command. If non-empty, run them.
- **`doctor`**: full `memex doctor --fast --json` output (brain/ops/meta checks).
- **`coverage`**: embedded/unembedded chunk counts + per-source health from
  the source rollup.

Exit code:
- `0` — healthy, nothing to do.
- `1` — action needed. Read `actions[]` and execute.
- `2` — could not determine (binary crash or missing subcommand). Investigate.

From MCP, the same signal is available without shell access: `run_doctor`
for the check detail, `get_status_snapshot` for the one-glance rollup,
`source_health` for per-source ingest state.

## When to run

- **Daily timer** (e.g. a systemd timer feeding the morning briefing):
  `memex skillpack check --quiet`. Exit code alone tells you if anything is
  wrong; surface a one-liner in the briefing only when exit != 0. No JSON
  noise in happy-path briefings.
- **On demand**: `memex skillpack check` for the full JSON when debugging.
- **In a CI pipeline**: same pattern — exit code gates, JSON is the evidence.

## What to do with the output

### Happy path (`healthy: true`)

Surface the summary in the agent's output only if asked. Nothing else.

### Action needed (`healthy: false`)

The `actions[]` array contains the commands to run, in order. Execute them:

```bash
for cmd in $(echo "$REPORT" | jq -r '.actions[]'); do
  eval "$cmd"
done
```

Common `actions[]` entries and what they mean:

- `memex embed` — Embedding coverage has fallen behind (unembedded chunks
  exist). Run it (it's idempotent); it backfills only what's missing.
- `memex reindex` — Index drift between pages and the search index.
- `memex cycle` — Background maintenance is overdue (the server's own cycle
  normally handles this; a manual run catches it up).
- Free-text action (no `Run:` prefix in the source message) — agent judgment
  needed. Quote it in the report for the user.

### Determine failure (`exit 2`)

Treat as urgent. Probably means the memex binary is missing from `$PATH` or
a required subcommand crashed. Check:

1. `which memex` returns a path
2. `memex --version` exits 0
3. The server answers: `memex status` (or the `whoami` tool over MCP)

## Output format

```json
{
  "version": "1.0.0",
  "ts": "2026-04-18T12:34:56.789Z",
  "healthy": false,
  "summary": "brain needs attention: 1 action(s) — memex embed",
  "actions": ["memex embed"],
  "doctor": {
    "exit_code": 1,
    "checks": [
      { "name": "embed_coverage", "status": "fail", "message": "EMBEDDING COVERAGE LOW (unembedded chunks present). Run: memex embed" }
    ]
  },
  "coverage": {
    "chunks_total": 1307,
    "chunks_embedded": 528,
    "sources": [{ "source": "memory", "status": "ok" }]
  }
}
```

## Anti-Patterns

- ❌ Running without `--quiet` in a timer that mails or messages its output —
  you'll get the full JSON blob in every daily briefing. Use `--quiet` in
  scheduled runs.
- ❌ Ignoring exit code 2. A crashed doctor is worse than a failing check
  because you don't even know what's wrong.
- ❌ Running on every chat turn. Once per hour (or on user request) is plenty.
- ❌ Treating warnings as failures. Only `fail` status needs action;
  `warn` is informational.

## Output Format

The skill itself doesn't write files; it reports the CLI output verbatim to
the user (or to the agent's briefing pipeline). One-line summary first,
then the action list, then (only if relevant) the full JSON for debugging.

## Related

- `memex doctor` — the underlying DB + config check. skillpack-check
  composes this. (`run_doctor` over MCP.)
- `memex status` / `get_status_snapshot` — the one-glance status view.
- `source_health` — per-source ingest state, for pinpointing which source
  stopped updating.
- `skills/briefing` — the briefing skill that consumes the one-line summary.

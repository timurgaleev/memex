---
name: minion-orchestrator
version: 1.0.0
description: |
  Unified background-work skill for durable server-side jobs of the kinds the
  brain registers, and for agent-side subagent orchestration. Use when:
  submitting a durable job, checking progress, cancelling/retrying running
  work, parallel fan-out through the agent's own subagents. One durable,
  observable queue interface plus the agent's own fan-out.
triggers:
  - "jobs submit"
  - "submit a job"
  - "spawn agent"
  - "background task"
  - "run in background"
  - "check on agent"
  - "agent progress"
  - "what's running"
  - "cancel job"
  - "retry job"
  - "stop agent"
  - "parallel tasks"
  - "fan out"
  - "do these in parallel"
tools:
  - jobs_submit
  - jobs_get
  - jobs_list
  - jobs_cancel
  - jobs_logs
  - retry_job
  - get_job_progress
mutating: true
---

# Minion Orchestrator

## Contract

"Minions" here means durable background work. memex ships a Postgres-native
durable job queue for observable server-side work; agent-side reasoning
fan-out uses the agent harness's own subagents (e.g. the Claude Code Task
tool). This single skill handles both lanes:
- Durable server jobs of a registered kind (`jobs_submit` / `memex jobs submit`)
- LLM subagent work (the agent's own subagent runtime)

When to route to the durable queue: work that must survive restarts, be
observable across sessions, or run without the agent staying attached.
The default policy is pain-triggered: use the agent's native subagents
first, reach for durable jobs when a specific pain signal fires (restart
loss, long runtime, needs later inspection).

Guarantees (durable lane):
- Jobs survive server restart (Postgres-backed)
- Every job has structured progress and per-job logs
- Jobs can be cancelled at any time, and retried after failure
- Progress is queryable without loading the full job record

Not guaranteed: mid-flight steering, pause/resume. The queue is
cancel-and-resubmit — if a job's direction is wrong, `jobs_cancel` it and
submit a corrected one.

## Route the Request: Server Job vs Subagent

| Condition | Action |
|---|---|
| User asks to run an arbitrary shell command in the background | Not a queue job — the queue runs registered kinds only; the operator runs it on the host |
| User asks for reindex / embed backfill / maintenance sweep | The corresponding `memex` CLI command on the host (`memex reindex`, `memex embed`, `memex cycle`), or the doctor's remediation plan |
| User asks for research/reasoning/iterative agent work | Agent-side subagent (harness Task tool) |
| User asks to cancel/retry running work | `jobs_cancel` / `retry_job` |
| Single simple operation under ~30s | Consider inline execution first |
| Needs restart durability/observability | Submit as a durable job |
| Parallel work (2+ streams) | Agent-side subagent fan-out; each child reads/writes the brain over MCP |

If intent is ambiguous, ask one clarification:
"Do you want a deterministic server job, or agent-side LLM work?"

## Server Jobs (Registered Kinds)

The queue runs only job kinds the server knows: the built-in
`chronicle_extract`, `ingest_capture`, `remediation` and `page_mirror`, plus
any handler the server registers at start. A submit naming any other kind is
refused with the list of known kinds — there is no generic shell or script
job, and none should be invented.

Recurring work belongs to the host, not the queue: cron-style scheduling is
done with systemd timers on the host (operator-side), and the brain's own
background `cycle` already runs routine maintenance (embedding backfill,
cache hygiene, decay). Don't submit a job for something the cycle already
does — check `get_status_snapshot` first.

### Submit

Over MCP:

```
jobs_submit {"kind":"<registered kind>","payload":{...}}
```

From the operator shell:

```
memex jobs submit <kind> --payload '<json>'
```

Pass an `idempotency_key` for recurring workloads so a repeat submit does not
create a duplicate; `priority`, `max_retries` and `not_before` tune the run.

### Monitor (agents or operator)

These operations are MCP-callable and safe for agent use:

```
jobs_list   {"status":"running"}
jobs_get    {"id":ID}
get_job_progress {"id":ID}
jobs_logs   {"id":ID}
```

Check structured result fields (exit status, log tails, attempts, timings)
from `jobs_get`. Use `memex jobs stats` (CLI) for the queue counts,
and `retry_job` to re-run a failed job.

### Control (MCP-callable)

```
jobs_cancel {"id":ID}
retry_job   {"id":ID}
```

Cancellation is a hard stop; there is no pause. To change a running job's
parameters, cancel and resubmit with corrected params.

## Subagent Work (LLM Orchestration)

Use for open-ended reasoning, tool-using research, and fan-out synthesis.

memex is a retrieval brain, not a chat agent — it does not run an LLM
reasoning loop server-side. Subagent orchestration is the AGENT's job:
spawn subagents with your harness's own runtime (e.g. the Claude Code
Task tool), and give each one a self-contained brief. Each subagent
reaches the brain over MCP exactly like you do.

### Phase 1: Spawn

- Write each child a self-contained prompt: the question, the brain tools
  to use (`search`, `page_get`, `backlinks`, `traverse_graph`,
  `entity_facts`, ...), and where to file results (`page_put` under
  `reports/` or the relevant entity page).
- Scope each child's tool use narrowly — read tools for research
  children, `page_put` only for the child that files the result.
- For parallel work (N entities, N sources), fan out N children plus one
  aggregation step that runs AFTER every child returns and synthesizes
  the combined result into a single brain page.

### Phase 2: Monitor

Your harness reports child progress. For server-side jobs running
alongside, poll lightly:

```
jobs_list {"status":"running"}     # what's running server-side?
jobs_get  {"id":ID}                # full details + result
get_job_progress {"id":ID}         # structured progress snapshot
jobs_logs {"id":ID}                # log tail
```

Progress includes: step count, message, timings, last state transition.

### Phase 3: Redirect

Durable jobs cannot be steered mid-flight. To redirect:
- Agent-side subagents: your harness's own steering (or wait, then
  re-brief a fresh child with the correction).
- Server jobs: `jobs_cancel`, then resubmit with corrected params.

### Phase 4: Lifecycle

```
jobs_cancel {"id":ID}              # hard stop
retry_job   {"id":ID}              # re-run a failed/completed job
```

All lifecycle ops are MCP-callable.

### Phase 5: Review Results

```
jobs_get  {"id":ID}                # result + timings
jobs_logs {"id":ID}                # full log
```

For subagent fan-out, the deliverable is the filed brain page — verify it
with `page_get` before reporting completion.

## Output Format

When reporting job status to the user:

```
Job #ID (name) — status
Progress: step/total — last action
Runtime: Xs
Attempts: N
```

When reporting completion:

```
Job #ID completed in Xs
Result: <summary>
```

When reporting fan-out status (children via the agent harness):

```
Fan-out: N children
  Acme — done, filed reports/acme-research
  Beta — running, on step 3/5
  Gamma — failed, re-briefing
Server jobs alongside: #ID (reindex) — active
```

## Anti-Patterns

- Don't spawn a background job for a single search query (use `search` directly)
- Don't fire-and-forget without checking results (`jobs_get` or `page_get` the deliverable)
- Don't spawn > 5 concurrent subagents without checking `get_status_snapshot` first
- Don't submit a job for maintenance the background cycle already covers
- Don't poll `jobs_get` in a tight loop (use `get_job_progress` for lightweight checks)

## Tools Used

- Submit a background job — `jobs_submit` (MCP; registered kinds only)
- Get job details — `jobs_get` (MCP)
- List jobs with filters — `jobs_list` (MCP)
- Cancel a job — `jobs_cancel` (MCP)
- Retry a job — `retry_job` (MCP)
- Get structured progress — `get_job_progress` (MCP)
- Read job logs — `jobs_logs` (MCP)
- Queue counts — `memex jobs stats` (CLI)

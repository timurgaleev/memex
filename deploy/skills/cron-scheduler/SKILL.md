---
name: cron-scheduler
version: 1.0.0
description: |
  Schedule management with staggering, quiet hours, and wake-up override.
  Validates schedules, prevents collisions, and gates delivery during quiet hours.
triggers:
  - "schedule a job"
  - "cron"
  - "quiet hours"
  - "what jobs are running"
tools:
  - search
  - page_get
  - page_put
  - jobs_submit
  - jobs_list
  - sources_list
mutating: true
---

# Cron Scheduler

> **Convention:** See conventions/test-before-bulk.md (via `get_skill conventions/test-before-bulk`) — test every scheduled job on 3-5 items first.

## Contract

This skill guarantees:
- Schedule staggering: max 1 job per 5-minute slot, no collisions
- Quiet hours gating: timezone-aware, with user-awake override
- Thin job prompts: jobs say "Read skills/X/SKILL.md and run it" (no inline 3000-word prompts)
- Idempotency: jobs can run twice without duplicate side effects
- Results saved as brain pages: `reports/{job-name}/{YYYY-MM-DD-HHMM}.md` (via `page_put`)

## Phases

1. **Define job.** Name, schedule (cron expression), skill to run, timeout.
2. **Validate schedule.** Check no collision with existing jobs (5-minute offset rule).
   - Slots: :05, :10, :15, :20, :25, :30, :35, :40, :45, :50
   - If collision detected, suggest the next available slot
3. **Check quiet hours.** Default: 11 PM - 8 AM local time.
   - Override: user-awake flag (if the operator is active, quiet hours suspended)
   - During quiet hours: save output to a held queue (a brain page under `reports/held/`)
   - Morning contact releases the backlog
4. **Register with host scheduler.** Systemd timers on the host, the agent
   harness's own scheduler, or crontab. **Each registered entry should
   execute server-side work via durable jobs (`jobs_submit`), not an
   inline agent turn** — submit with an idempotency key derived from the
   schedule slot, then check completion with `jobs_get`/`jobs_logs`. See
   conventions/scheduled-work.md (via `get_skill conventions/scheduled-work`)
   for the rewrite pattern. Note the brain's own background cycle already
   runs routine maintenance — do not schedule a job that duplicates it.
5. **Write thin prompt.** Job prompt is one line: "Read skills/{name}/SKILL.md and run it."

## Idempotency Requirement

Every scheduled job MUST be idempotent:
- Running the same job twice produces the same result (no duplicate pages, no duplicate timeline entries)
- Use a checkpoint state page (`reports/{job-name}/_checkpoint.md`) to track progress and resume interrupted runs
- Check for existing output (`page_get`) before creating new output

## Output Format

Job configuration saved. Report: "Job '{name}' scheduled at {cron expression}. Next run: {time}."

## Indexing: one consolidated entry, not per-corpus entries

Pages are DB-canonical, so there is no "sync" to schedule — the only
recurring corpus work is (re)indexing the read-only note corpus (the
`memory` source, check it with `sources_list` / `source_health`).
Use one consolidated entry instead of N per-directory entries:

**Preferred (consolidated)**:

```cron
*/30 * * * * memex reindex
```

One line covers the whole corpus and auto-picks-up new note directories
without a crontab edit. Mind the concurrency budget: keep parallel
indexing waves under your Postgres `max_connections` setting.

**Avoid (legacy)**: separate per-directory `memex index <path>` entries
staggered by 5 minutes. They require manual deconfliction every time a
new directory appears, and a slow directory can race a fast one on the
index lock — the per-directory pattern gets none of the parallelism a
consolidated reindex actually delivers.

`memex doctor` (or the `run_doctor` tool) surfaces indexing-health
checks; consult it before adding any new indexing entry.

## Anti-Patterns

- Scheduling jobs at the same minute (:00 for everything)
- Inline 3000-word prompts in scheduled jobs (use skill file references)
- Running scheduled jobs without testing on 3-5 items first
- Jobs that produce different output on re-run (not idempotent)
- Sending notifications during quiet hours (save to held queue instead)
- Separate per-directory `memex index` entries when one `memex reindex`
  line would replace them and auto-pick-up future directories
- Scheduling maintenance the brain's background cycle already performs

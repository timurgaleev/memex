# TODO — memex-stack

Forward-looking work that is intentionally deferred. Items already
shipped live in [`CHANGELOG.md`](./CHANGELOG.md); items rejected as
out-of-scope live under "NOT in scope" in the design doc that
introduces them.

---

## Operator post-install steps

Things `make init` + `terraform apply` + `bootstrap.sh` do NOT
automate today. Run these once after the first deploy:

- **Install the host-side bearer-rotation timer:**
  ```bash
  sudo install -m 644 deploy/systemd/memex-rotate-bearer.{service,timer} \
                       /etc/systemd/system/
  sudo install -d /var/log/memex
  sudo systemctl daemon-reload
  sudo systemctl enable --now memex-rotate-bearer.timer
  ```
  Verify with `systemctl list-timers memex-* --all`.

These steps are documented to be folded into `bootstrap.sh` in a
future release.

---

## Operator-only follow-ups (cannot be automated remotely)

- **Realign terraform state with renamed `memex-*` addresses.** Local
  `moved.tf` (gitignored historical scaffold) reduces the diff, but
  the plan still wants to *replace* the EFS and EC2 security groups
  in place — that recreates the SGs and risks momentary loss of EFS
  mount + EC2 traffic. Apply ONLY during a planned maintenance window
  and AFTER confirming the SG-replacement is safe in your environment.
  Live config is already functionally correct; this is cosmetics on
  the terraform state. While in the window, also audit whether
  `var.subdomain` (the legacy chat-UI slot, still consumed by
  `compute.tf` bootstrap) can be dropped — the chat UI is gone; the
  public MCP brain is served via `memex_subdomain`.
- **Reconcile the 2026-06-05 out-of-band changes into terraform state.**
  Two terraform-managed resources were changed live via the AWS CLI
  ahead of a proper apply (they already match the committed v1.2.10
  code, but the S3 state still lists them):
  1. the `993` / `587` Gmail egress rules were revoked from the live
     EC2 security group;
  2. the orphaned `memex/gateway-token` secret was scheduled for
     deletion (30-day recovery window, restore-able until ~2026-07-05).
  The next `terraform apply` from the ops dir refreshes and drops both
  from state with **no live change**. Per CLAUDE.md the S3 state is the
  single source of truth and infra changes go through terraform — this
  was a one-off the apply now cleans up; don't repeat the CLI shortcut.

---

## Defence-in-depth hardening (deferred)

- **Public-ingress read redaction — COMPLETE.** All body-bearing /
  free-text read paths now redact on public ingress: `search` /
  `page_get` / `page_list` / `page_versions` (v1.2.0), `entity_facts` /
  `entity_timeline` / `entity_recall` (v1.2.9, 2026-06-01), and
  `backlinks` + `jobs_get` / `jobs_list` / `jobs_logs` (v1.2.9,
  2026-06-05). **Decision (2026-06-05): `graph_neighbors` /
  `graph_query` edge `type` STAYS public.** Rationale: the public
  bearer is single-holder (the operator's own MCP client) and rotated
  daily; slugs are already public; the edge `type` is a constrained
  enum (`KNOWN_LINK_TYPES`), not free-text note content; and it is core
  to graph-recall utility. Redacting it would cripple legitimate use
  for negligible marginal risk. No code change — behavior is
  intentional and now documented. Residual closed.

- **Jobs DAG: align FK delete behaviour between `jobs.parent_job_id`
  and the `job_children` / `child_done_inbox` tables.** Today
  `parent_job_id REFERENCES jobs(id) ON DELETE SET NULL` keeps the
  child row alive (with NULL parent) when the parent is purged, but
  `job_children` and `child_done_inbox` both `ON DELETE CASCADE` —
  the edge tables vanish while the child's `parent_job_id` column
  goes to NULL. `listChildren()` / `drainDoneInbox()` then see zero
  rows even though the children still exist. We have no
  job-delete endpoint exposed today so this is theoretical, but
  before we add one we either (a) make all three FKs CASCADE
  (purging a parent purges the subtree) or (b) explicitly reject
  deleting a parent that has children. Flagged in the migration
  comment of `019_jobs_dag.sql`.

- **Jobs DAG: inbox-during-cancel race.** `writeChildDoneInbox` runs
  with `engine.query` (its own implicit txn), `cancelJob` runs with
  `engine.transaction`. A child completing concurrently with a
  cascade-cancel BFS sees a non-snapshot view: a freshly inserted
  pending child added after the frontier read is missed by cancel,
  while its `writeChildDoneInbox` lands as an orphan pointing at a
  job whose status is by then `cancelled`. Mitigation today: the
  parent's drain logic should ignore inbox rows whose `parent.status`
  is terminal. Long-term fix: read the frontier with `FOR UPDATE` or
  switch the cancel txn to `SERIALIZABLE` isolation. PGLite supports
  `SERIALIZABLE` so we can prove it locally before shipping to RDS.

- **A.5 ledger: future supervisor must bind pending tool rows to a
  worker.** `subagent_tool_executions` records `status = 'pending'`
  rows BEFORE the tool runs, so a crash-recovery sweep can pick
  them up. The supervisor that lands in a future phase MUST bind
  each pending row to a `supervisor_run_id`/`worker_id` and only
  the originating worker may retry it; cross-worker pending rows
  must be `skipped`, NOT re-executed. Without this, anyone who can
  write a pending row (internal-token-gated today) causes the next
  sweep to invoke the named `tool_name` with their forged `input`
  -- a stored command injection into the agent loop. Flagged in
  the doc comment of `beginToolExecution`.

- **A.5 ledger: enforce internal-token-only when A.6 wires MCP.**
  `subagent_messages.content` carries the raw Bedrock Converse
  payload (system prompts, tool inputs with OAuth/Bearer tokens),
  `subagent_tool_executions.input/output/error` carry arbitrary
  tool payloads, `hot_memory.fact` is the unfiltered observation
  stream keyed by predictable slugs (`people/<name>`). A.6's
  forthcoming `subagent_messages`/`subagent_tool_executions`/
  `hot_list` MCP tools MUST go in the WRITE-tools allowlist
  (`FORBIDDEN_MCP_TOOLS_FROM_PUBLIC`) so the public-bearer never
  reaches them. If a public projection is ever needed it must
  drop `content` / `input` / `output` / `error` at the SQL layer,
  not the serializer, and return `404` uniformly on miss to
  prevent entity-existence enumeration. Documented inline in
  `core/hot_memory.ts` and `core/subagent_ledger.ts` headers.

---

## Brain capability roadmap (phased, deferred)

A long-horizon plan to grow memex's retrieval brain. memex stays **brain-only**
— a retrieval service over MCP — and the agent that drives it is the MCP client
(Claude Code). So this roadmap is about making the brain **sharper at returning
context**, not about turning it into an agent.

**Phases P0–P9 are brain-internal** (single `/health` + `/mcp` surface,
retrieval-only, no agent loop). **The near-term target is P0 → P1 → P2**
(data-model substrate + retrieval-quality core), optionally P3 (durable jobs)
and P6 (eval gate).

A second tier of capabilities from the broader landscape — public auth/HTTP,
LLM synthesis, an in-brain agent loop, multimodal/voice, self-upgrade
automation — is **explicitly out of scope**: it would rebuild what the MCP
client already provides. Listed at the end only so the boundary is on record.

Build list (brain-internal):

- **P0 — Schema cache substrate.** `pages.generation` + page-generation clock +
  triggers (cache-invalidation substrate); `tags` / `raw_data` / `config` /
  `ingest_log` tables; provenance columns on `pages`/`sources`/`links`. Pure
  DDL; live-RDS index migrations use `CONCURRENTLY`.
- **P1 — Chunk/code-metadata schema + FTS.** Expand chunks with code metadata +
  per-chunk `search_vector`; code-edge graph tables; `timeline_entries`;
  weighted page/chunk TSVECTOR triggers.
- **P2 — Retrieval quality core** *(highest value)*. Intent-weighted RRF,
  post-fusion salience/recency/graph signals, contextual retrieval, a
  cross-encoder reranker abstraction, a semantic query cache keyed off the P0
  generation clock, and token-budget enforcement.
- **P3 — Durable job system.** Supervisor (PID + DB lock + wedge detection),
  child-worker isolation, parent→child DAG fan-in, idempotency, timeout/cancel,
  budget + rate-lease metering, `pg_notify` job events. Prereq for any fan-out.
- **P4 — Cycle expansion.** Grow the maintenance cycle with the non-LLM phases:
  lint, backlinks-materialize, git sync, facts reconcile, symbol-edge resolve,
  hard purge, weight recompute, schema-suggest.
- **P5 — Enrichment primitives (LLM-free).** Entity-slug resolution, gazetteer
  auto-linking, NER typed-link inference, meeting→timeline extraction,
  completeness scoring, facts-fence format.
- **P6 — Eval gate.** nDCG/Jaccard + qrels + baselines + a CI correctness gate
  on retrieval quality (turns capture/replay into a real regression guard).
- **P7 — Skill catalog over MCP.** Frontmatter parser, trigger-index,
  `list_skills`/`get_skill`, resolver validation, skillpack installer.
- **P8 — Ops hardening.** Doctor category taxonomy + cause-ranking, quarantine
  markers, audit-writer JSONL trail, destructive-guard (soft-delete/restore),
  source-health metrics.
- **P9 — MCP/CLI parity.** Request-param redaction for logging, JSON-shaped MCP
  errors, type-enum validation, and the convenience CLI surface (page CRUD,
  graph traversal, cache/status dashboards).

Out of scope (rebuilds what the MCP client already does — recorded only to
mark the boundary, not planned work):

- HTTP/OAuth public auth surface + remote MCP federation.
- In-brain AI gateway + LLM enrichment pipeline (passive ingest recipes).
- In-brain agent layer (think pipeline, context engine, subagent runtime).
- Multimodal/voice/files + the 1024→1536 embedding upgrade.
- Self-optimization / self-upgrade / automation daemons.

Recommended start: **P0 → P1 → P2**. Each phase is one `/ship` batch
(local gates → push → SSM deploy → live verify → tag).

---

## Revival projects

These are intentionally archived. Pick them up if and when you want
the capability back.

_None currently — the Telegram/chat and life-integration capabilities
were intentionally removed; memex is a brain reached over MCP only._

---

## OSS scaffold polish

- Multi-arch CI matrix (amd64 + arm64) — currently arm64-only because
  the default `var.instance_type` is `t4g.medium`. Track in an issue;
  not a 1.0 blocker.
- GHCR image publishing for the `memex` container — today the image is
  built on the EC2 host on every deploy. Issue first to agree on tag
  scheme + release cadence.
- GitHub Pages docs site — `ARCHITECTURE.md` + `deploy/*/docs/` would
  render as a small Docusaurus / mkdocs site. Out of scope until
  there's a second deployer.
- Standalone `memex` npm publish — split the brain out of the stack
  if demand for it standalone materializes.

---

## How to add a TODO

Open an issue using the `Feature / enhancement` template. PRs are
welcome but please open the issue first so we can agree on shape.

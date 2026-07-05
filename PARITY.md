# PARITY.md — adaptation worklog (single source of truth)

Persistent worklog so nothing is lost across context compression. Goal:
**adapt memex to match the behaviour of the reference implementation**,
faithfully — no invented concepts, every change traced to a reference subsystem.
(The reference is referred to ONLY as "the reference implementation" — never by
name, per the repo name-ban.)

## ⭐ SCOPE CHANGE 2026-06-22/23 — FULL parity (no longer brain-only)

The operator reversed the brain-only north-star (informed, each risky fork
confirmed): memex now pursues **full behavioural parity with the reference** —
LLM synthesis, code-graph, push-context, advisor/skillpack, and OAuth are all
**IN scope**. The "OUT-of-scope / brain-only" notes lower in this file are
SUPERSEDED for those items. Deferred (operator): brain federation + embedding
1024→1536 (need infra/provider not yet provisioned).

### Parity-program waves
| Wave | What | Release | Status |
|---|---|---|---|
| (pre) | graph-signals retrieval stage (earlier missed gap) | v1.10.0 | LIVE |
| 1 | 13 deterministic MCP tools (links/insights/facts/identity/purge/query) | v1.11.0 | LIVE |
| 2 | code-graph activation (index auto-detect + code_callers/code_callees) | v1.12.0 | LIVE |
| 3 | push-context (volunteer_context + `memex watch` + events log, mig 044) | v1.13.0 | LIVE |
| 4 | advisor + list_brain_skillpack | v1.14.0 | LIVE |
| 5 | **LLM synthesis** (atoms/concepts/takes/grade/calibration, own `synth_*` namespace, mig 045; opt-in/default-OFF) + list_concepts/list_takes/get_calibration_profile | v1.15.0 | **PUSHED, deploy pending SSO** |
| 6 | **OAuth/JWT bearer app-layer** (default-OFF, public-scope-only, WebCrypto, no new dep) | v1.16.0 | **PUSHED, deploy pending SSO** |

55 MCP tools (pre-Wave-6; Wave 6 adds no tool). Migrations →045. Waves 5–6 are
committed to `main` but await `aws sso login` → SSM deploy + verify + tag (the
SSO session expired mid-session). Synthesis writes ONLY to `synth_*` (source
notes sacrosanct); OAuth is inert until the operator enables it + wires public
ingress via terraform (ops dir) + decides tenancy. See agent memory
`session-handoff-2026-06-23-parity-waves` for the morning deploy steps.

---

## Deliberate deviations (security-motivated, keep)
- `auth permissions <name> set-takes-holders` MERGES into the permissions
  JSONB instead of the reference's wholesale replace. Replacing would silently
  drop an operator-set `permissions.source_id` tenant grant and floor the
  token to the empty `default` source; the merge preserves it. The update also
  targets only non-revoked rows.

## Operating rules (do not drift)
- Find the answer in the reference; do not invent. Adapt to memex's stack
  (Bun + Postgres/PGLite, `documents`/`chunks`/`embeddings` + `pages`).
- Brain-only: NO LLM synthesis, NO agent loop, NO OAuth/HTTP, NO voice — those
  are out of scope by the operator's north-star (Claude Code is the agent).
- Ship via the repo loop: local suite green → push → SSM deploy → live verify →
  tag + release. Migrations are additive/idempotent.
- Do NOT rebuild items marked MOOT below — they were triaged out with evidence.

## DONE — genuine behavioural parity (this session, all live + verified)
| Release | What | Reference subsystem adapted |
|---|---|---|
| v1.3.54/55 | **page→search bridge**: `page_put`/`page_append` chunk+embed the body into the search store (`page://<slug>`), `page_delete` drops it, `mirror-pages` cycle phase reconciles. THE real gap — pages were written but unsearchable. | page→content-chunk indexing |
| v1.4.0 | **soft-delete + archive + quarantine + search visibility filter + purge phase** (migration 040). Hidden docs excluded from both retrieval arms. | visibility clause + destructive-guard + purge |
| v1.4.1 | **`lint` as a cycle phase** (read-only frontmatter audit). | lint cycle phase |
| v1.10.0 | **`graph-signals` retrieval stage** (opt-in, default OFF): adjacency hub boost (×1.05) + cross-source boost (×1.10, dormant single-source) + session diversification (×0.95). Slug-keyed `links` SQL, one representative per page, fail-open. Found by the 2026-06-22 v0.42.52 re-comparison — **a real ranking gap (reference v0.40.4) earlier passes had missed**, not a delta item. | `search/graph-signals.ts` post-fusion stage |

## DONE but INERT / scale-out for THIS brain (built this session; harmless, additive, reviewed — left in place, NOT rebuilt)
- **v1.5.0 resolve_symbol_edges** (mig 041) — code call-graph resolution. Per the
  operator's 2026-06-13 triage this is **MOOT for a ~0-code-chunk markdown
  corpus** (the entity-mention call-graph already answers callers/callees). It
  is inert here (no code chunks to resolve). Do NOT extend it.
- **v1.6.0/v1.6.1 durable-jobs worker_lock + heartbeat** (mig 042) — single-
  active-worker election + status surfacing. Per the 2026-06-13 triage the
  durable-jobs supervisor is **mostly MOOT** — `core/jobs/*` already has atomic
  SKIP-LOCKED claim + lock_until lease + stall/wedge requeue + **DAG fan-in** +
  backoff + quiet-hours; the only remainder was scale-out, which is moot on a
  single EC2 with one container. Harmless (one worker always acquires). Do NOT
  build "durable-jobs part 3+" — DAG fan-in already exists.

## MOOT / DEFERRED — do NOT rebuild (operator's documented decisions)
- code_edges / resolve_symbol_edges re-model — MOOT (markdown corpus). [done-but-inert above]
- durable-jobs supervisor scale-out — MOOT (single EC2). [done-but-inert above]
- tree-sitter language coverage (~33 grammars) — DEFERRED (~0 value on markdown).
- LLM/agent layer (synthesize/atoms/takes/calibration/think/voice/OAuth) — OUT (brain-only north-star).
- embedding 1024→1536 — OUT (would need a non-Bedrock provider; violates the Bedrock-only rule).
- pages→content_chunks single-table MERGE — SKIP (no functional gain; the bridge already makes pages searchable).
- backlinks-materialize phase — REDUNDANT (link edges are written at ingest).

## REMAINING genuine gaps vs the reference (from the 2026-06-22 comparison)
Verified missing + deterministic + valuable for this brain. Build in priority order.

PARITY (no gap): cycle phases (13, all deterministic equivalents present);
read-side links (graph_neighbors covers get_links/backlinks); aliases (mig034) +
slug-canonicalization (mig033) wired; autocut deliberately rejected (return-policy.ts).

| # | Gap | What | Size | Status |
|---|-----|------|------|--------|
| 1 | **page_restore** | undelete a soft-deleted page. | S | **DONE v1.7.0** |
| 2 | **page_revert** | roll a page body back to a `page_versions` snapshot. | M | **DONE v1.7.0** |
| 3 | traverse_graph | recursive N-hop graph walk (depth-capped CTE); memex `graph_query`/`graph_neighbors` are 1-hop only. | M | **DONE v1.8.0** |
| 4 | relational_recall | deterministic relational query → seed entity → typed-edge fan-out (standalone tool, NOT wired into hybrid hot path). | L | **DONE v1.9.0** |
| 5 | resolve_slugs | fuzzy partial-string → canonical slugs (pg_trgm). | S | **DONE v1.9.0** |
| 6 | get_chunks | return a page's/document's ordered content chunks. | S | **DONE v1.9.0** |
| 7 | tag ops (add/remove/get_tags) | first-class page tags over the `tags` table. | S | **DONE v1.9.0** |

## 2026-06-22 re-comparison vs reference v0.42.52 (10 new releases: v0.42.43→52)
Reference advanced from v0.42.42 (prior baseline) to v0.42.52. Exhaustive
re-triage (10-agent workflow: 6 delta subsystems + 4 full cross-checks of
search / cycle+jobs / pages+facts+graph / MCP-tool surface), then operator
verification of every "GAP" the agents raised. Outcome:

| Reference delta theme | Verdict |
|---|---|
| push-based context / retrieval-reflex / volunteer / watch (v0.42.43) | OUT — agent-facing (Claude Code IS the agent) |
| brain-resident skillpacks + proactive advisor (v0.42.47) | OUT — agent skill-distribution + operator nagging |
| git durability / federated reads / sync-delta cost estimator (v0.42.45/46/48/51) | OUT — sync/federation (operator: future, not now) |
| autopilot dead-job storm / supervisor wedge / minions reliability (v0.42.52) | MOOT — multi-worker scale-out; memex is single in-process worker (atomic claim + stall-requeue + worker-lock + heartbeat already) |
| DB-contention pacing for backfills (v0.42.49) | DEFERRED — default-off no-op on a single small brain; low value, revisit if the corpus/concurrency grows |
| op_checkpoints array-constraint / generation-clock sequence | N/A — memex has no op_checkpoints; clock contention is a non-issue at single-node scale |
| **graph-signals (v0.40.4, predates the baseline)** | **GAP → shipped v1.10.0** — the one real, deterministic, brain-internal retrieval feature memex genuinely lacked |
| 24 "missing" MCP tools the agents listed | mostly OUT (LLM/takes, federation, schema-packs, multimodal, file/raw-data substrate) or already present in memex (`stats`, `page_versions`, `page_revert`, `backlinks`, `graph_neighbors`, `entity_recall`, orphans CLI) — no genuine valuable deterministic read tool missing |

**PARITY COMPLETE (brain-only scope).** After closing graph-signals, every
identified deterministic, brain-internal, valuable gap vs the reference is shipped.
The remaining reference surface is OUT-of-scope (LLM/agent layer, push-context,
skillpacks/advisor, git-sync/federation), MOOT (scale-out, code-graph on a
markdown corpus), provider-conflicting (embedding dim), or deferred-low-value
(backfill pacing).

## State
- This session: 1 release — **v1.10.0** (graph-signals).
- Prior sessions: v1.3.54→v1.9.0 (page bridge, soft-delete/visibility, lint,
  resolve_symbol_edges, durable-jobs lock, page_restore/revert, traverse_graph,
  get_chunks/resolve_slugs/tags/relational_recall).
- All live on the EC2, healthy. Migrations through 042. Cycle = 13 phases.
  graph-signals adds no migration and no MCP tool (opt-in ranking stage only).
- `make audit` PII:0, `make scrub-audit` HIGH:0.

---

## 2026-06-25 — CORRECTION to "PARITY COMPLETE" + tenancy program start

A fresh, code-grounded re-audit (9-agent workflow reading reference + memex
source directly, distrusting the docs) found the earlier "PARITY COMPLETE"
verdict **overclaimed**. It held for the *deterministic brain-only* subset, but
real, previously-unrecorded gaps exist:

**Genuinely-missing small items (auto / low-risk), not in any prior list:**
- `graph-signals` floor-ratio gate is a **no-op** — `hybrid.ts` never computes
  the `floorThreshold` that `graph-signals.ts` accepts, so every metadata boost
  is ungated.
- `page_aliases` (mig 034) exists but the **alias-hop / alias-resolved boost is
  never wired** into `hybridSearch` — the main named-entity synonym gap.
- No **bounded query-embed deadline** (a stalled embed provider hangs search
  instead of failing over to keyword).
- `content_flag` never stamped on results; **Retry-After** absent on 429;
  `chunker_version` never written; `embed_skip` frontmatter unsupported;
  `LINK_EXTRACTOR_VERSION` staleness watermark absent.
- Cycle has **no concurrency lock** → two overlapping cycles double Bedrock cost.

These are tracked in `TODO.md` (retrieval/resilience backlog).

**The real headline — multi-tenancy is NET-NEW, not a parity gap.** The
reference is itself single-holder-by-default but ships the building blocks
(`oauth_clients/tokens/codes`, `source_id` on every content row, `scope.ts`,
`oauth-provider.ts`, an admin SPA). memex deliberately skipped all of it
(0 tenancy columns across 45 migrations, verified). Company multi-user is a
faithful **port** of that model — now started: `docs/tenancy.md` (design +
must-fix checklist), `src/core/scope.ts`, migration `046_oauth.sql`.
Invasive `source_id` data-model migration is gated behind the checklist and a
live-deploy decision.

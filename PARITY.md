# PARITY.md — adaptation worklog (single source of truth)

Persistent worklog so nothing is lost across context compression. Goal:
**adapt memex to match the behaviour of the reference implementation**,
brain-internal, faithfully — no invented concepts, every change traced to a
reference subsystem. (The reference is referred to ONLY as "the reference
implementation" — never by name, per the repo name-ban.)

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
| 3 | traverse_graph | recursive N-hop graph walk (depth-capped CTE); memex `graph_query`/`graph_neighbors` are 1-hop only. | M | TODO |
| 4 | relational-recall arm | 4th RRF arm: NL relational query → seed entity → typed-edge fan-out → ranked candidates. | L | TODO |
| 5 | resolve_slugs | fuzzy partial-string → canonical slugs (link/type-ahead foundation). | S | TODO |
| 6 | get_chunks | return a page's ordered content chunks (citation/re-embed access). | S | TODO |
| 7 | tag ops (add/remove/get_tag) | mutate/read the dormant `tags` table (mig023) as a first-class axis. LOW value (frontmatter already covers most). | S | TODO (low) |

## State
- 7 releases this session: v1.3.54, v1.3.55, v1.4.0, v1.4.1, v1.5.0, v1.6.0, v1.6.1.
- All live on the EC2, healthy. Migrations through 042. Cycle = 13 phases.
- Full Bun suite green (1108/0). `make audit` PII:0, `make scrub-audit` HIGH:0.

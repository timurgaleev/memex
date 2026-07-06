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
- Takes-fence `kind` vocabulary is WIDER than the reference's
  (fact/take/bet/hunch + prediction/judgment): memex's LLM-propose path was
  already writing prediction/judgment into synth_takes before the fence port,
  so the fence parser accepts one merged namespace instead of breaking
  existing rows.
- `entity_facts`/fact recall floor EVERY scoped principal (public ingress or a
  tenant token carrying a read set) to `visibility='world'` and deny
  `include_forgotten`; only the operator path reads private/tombstoned rows.
- Remote authenticated principals whose credential carries no takes-holder
  allow-list are floored to `['world']` (the reference applies the same
  fail-safe at its transport layer).
- `synth_takes.holder` DEFAULT + mig-091 backfill = `'world'`, NOT the
  reference's `'brain'`-for-AI convention. memex retrofits the holder onto
  pre-existing MACHINE-proposed takes that were world-visible (unfiltered)
  before the column existed; the operator reads them daily through a REMOTE
  client (claude.ai / ChatGPT), which the holder floor caps to `['world']`.
  Backfilling to `'brain'` would retroactively hide the operator's entire live
  take history from their own primary client — a regression, not a privacy
  win. So machine-proposed takes stay `'world'` (consensus CANDIDATES for the
  human to grade) and only fence-authored takes the operator marks otherwise
  carry a non-world holder — the genuinely-private rows the floor gates. Not a
  divergence from a reference STEP (the reference authored takes with explicit
  holders from day one and never backfilled machine takes). **OPEN taste call
  for operator ratification** — the stricter alternative is `'brain'` backfill
  + grant `claude-web`/`timur-chatgpt` `takes_holders=['*']`.
- `rate_limited` request-log rows are best-effort (sink-gated), NOT
  force-written per rejection — a hammering client must not convert every 429
  into a guaranteed DB INSERT.

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

---

## 2026-07-05 — SEARCH-cluster parity batch (accepted deviations recorded)

Ranking parity ported into `core/search/*` (compiled-truth ×2 boost via the new
`page-truth://` mirror, zero-LLM query taxonomy, k/weight RRF math, exact-match
/ alias-resolved / mattering-salience / recency-boost stages, full arm-SQL
curation tier map + default hard-excludes with temporal bypass, dedup cap 2 +
0.6 type-diversity, full-window rerank head + rerank-failure audit + 5s
timeout, full knobs-hash in the query-cache signature). Two deviations are
DELIBERATE and accepted:

- **Default-OFF cost posture (mode bundles).** `MEMEX_SEARCH_MODE` now ships
  the reference's `conservative`/`balanced`/`tokenmax` bundles, but memex
  **defaults to `conservative`**, and memex's `conservative` equals the
  historical all-OFF defaults (no rerank / graph / relational / cosine, no
  token cap) — the reference defaults to `balanced` (rerank + graph +
  relational + contextual ON, 12000-token cap). Rationale: memex pays per
  Bedrock call out of the operator's pocket; every paid stage stays one env
  away (`MEMEX_SEARCH_MODE=balanced`) instead of on-by-default. LLM query
  expansion follows the same posture: default OFF everywhere except
  `tokenmax` (the reference measured negligible lift; kill-switch
  `MEMEX_QUERY_EXPANSION=0/1`).
- **Chunk FTS stays `to_tsvector('simple', …)` — no English stemming.** The
  reference uses `'english'` (stemming: "running" matches "run"). memex's
  corpus is deliberately multilingual (Russian + English prose in one store);
  the `english` config would stem English while mangling nothing-but-ASCII
  tokenization for Russian text and change the matched set corpus-wide, and a
  language-split tsvector is not worth the migration + full re-vector today.
  `'simple'` keeps exact-lexeme matching that behaves identically for both
  languages; the vector arm carries the semantic slack. The reference's other
  FTS half (symbol identity at weight 'A') already landed in migration 030/032
  (`symbol_name` + `parent_symbol_path`). Revisit only with a per-language
  column or a `russian`+`english` double-vector design.

---

## 2026-07-06 — MCP-surface stage-2 batch (accepted deviations recorded)

The MCP surface caught up to the reference's op set: `think` is remote-exposed
(save/take persistence honored for the operator only, like the reference's
remote-caller block), `query` is rebuilt as the flagship full-control retrieval
op (expand / detail / salience / recency / offset / mode / adaptive_return —
the old weighted-RRF refinement survives behind the legacy `refine` param),
read-param parity landed (page_list tag/sort/include_deleted, page_get
fuzzy/include_deleted, search offset+mode, list_takes / volunteer_context /
find_trajectory / find_contradictions / find_experts / get_recent_salience
filters), the stage-1 core work is reachable (fact_supersessions + entity_facts
lifecycle filters, extract_facts persist, put/get_raw_data, retry_job /
get_job_progress), operator wrappers exist (sources_list, sources_status,
get_status_snapshot, run_doctor), and paid ops (`think`, `extract_facts`)
enforce `oauth_clients.budget_usd_per_day` fail-closed through the
mcp_spend_log/mcp_spend_reservations ledger. Deviations that are DELIBERATE
and accepted:

- **`get_recent_transcripts` stays remote-exposed.** The reference marks it
  `localOnly` (rejected for every remote caller at tool-list AND handler). In
  memex the op is (a) forbidden on the PUBLIC bearer path
  (`FORBIDDEN_MCP_TOOLS_FROM_PUBLIC`) and (b) tenant-scoped for OAuth tokens —
  a scoped client only ever sees its own sources' transcripts. memex's remote
  OAuth clients are the operator's own devices (claude.ai), so the extra
  local-only fence would only break the primary consumer. Audits should stop
  re-flagging this: the exposure is intentional, scoped, and public-blocked.
- **`purge_deleted_pages` is now operator-only** (reference: `admin` +
  `localOnly`). Previously any write-scoped tenant token could hard-delete its
  own soft-deleted pages remotely; it now sits in `OPERATOR_ONLY_TOOLS` next
  to the jobs/advisor surface, and stays public-forbidden.
- **`think` cost posture.** The reference runs think wherever a model resolves;
  memex keeps the core `MEMEX_THINK=1` gate (default OFF, budget-tracked), so
  the remote op returns `{ran:false, reason}` until the operator opts in.

## 2026-07-06 — full recompare + Wave 1/1.5/2-kickoff

A fresh whole-surface recompare (12-dimension agent workflow + adversarial
verify) drove three releases:

- **v1.82.0 (parity-restoring, NOT deviations):** the indexer now strips the
  `## Takes` fence before chunking like the reference's `chunkText` (operator
  takes, incl. holder-scoped rows the read-path caps at `world`, no longer leak
  into search chunks); untrusted callers can no longer plant gate-owned
  frontmatter markers (`quarantine`/`content_flag`/`embed_skip`) — a `remote`
  trust flag strips them before the content-sanity gate on the MCP `index`
  inline path and the remote/public `page_put`/`page_append` mirror; the
  `merge` (entity-merge) CLI command is wired into dispatch.
- **v1.83.0 (correctness + historical purge):** `MARKDOWN_CHUNKER_VERSION` 1→2
  and `reconcilePageMirrors` re-mirrors pages whose search doc is below the
  current chunker version. This closes a latent gap — the vault rechunk-sweep
  reads `source_path` off disk, so DB `page://` mirrors never re-chunked on any
  chunker change. Drained on prod; verified 0 chunks carry the takes marker.
- **v1.84.0 (Wave 2, now AT parity):** MCP `search` default `k` 5→20 to match
  the reference's hybrid-search return width (autocut/adaptive-return still
  trims the confident cluster). No longer a divergence.

Accepted deviation recorded:

- **Semantic query-cache arm default OFF.** memex ships the reference's 0.92
  similarity / 3600s-TTL constants and the mig-065 bucket_key/query_embedding
  columns, but the similar-query cache path stays dark by default (only
  byte-identical queries hit) — consistent with memex's blanket default-OFF
  cost posture (operator decision, 2026-07-06). Byte-identical caching and all
  ranking parity are unaffected.

## 2026-07-06 — Wave-2 core batch (accepted deviations recorded)

CLI `version`/`--version`, cross-entity `entity_facts` (optional `entity_slug`),
`takes_scorecard`/`takes_calibration` holder+window filters, per-migration
`statement_timeout`, and a bulk-write connection-retry primitive landed. Three
adaptations are DELIBERATE deviations from the reference:

- **Takes `since`/`until` window `generated_at`, not the reference's per-take
  `since_date`.** memex has no belief-as-of date column on a take, so the
  scorecard's date window filters when the take was SYNTHESIZED. Same UX intent;
  do not add a `since_date` column (it would be NULL on every machine-derived
  take and buy nothing).
- **Takes `domain` stays an exact-match TEXT column, not the reference's
  page-slug `domain_prefix` LIKE.** memex's `domain` is a scalar column on the
  take with no pages/slug join, so exact match is the faithful adaptation.
- **Facts-fence `## Facts` block is stripped whole from search chunks; the
  reference keeps `visibility='world'` rows searchable.** memex's fence parser
  carries no `visibility` field (visibility lives only on the `entity_facts` DB
  row, mig 085), so keeping world rows searchable would require a markdown-format
  change AND re-adds fact content to the harder-to-audit search index — the
  exposure memex deliberately keeps out. World facts remain reachable via
  `entity_facts` (world-only for scoped readers) and the new cross-entity recall.
  Deliberate SKIP; the read API is the sanctioned path.

The rerank candidate window (`MEMEX_RERANK_WINDOW`, default 30), the PG
pool/statement-timeout env knobs (`MEMEX_PG_POOL_MAX` /
`MEMEX_PG_STATEMENT_TIMEOUT_MS`), and the four ops doctor probes shipped in
v1.85.0/v1.86.0 already close their respective reference gaps — no deviation.

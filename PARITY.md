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

## 2026-07-07 — Wave-4 DB-table pass (all deviations / deferrals, no code)

A recompare of the reference's receipt/cache tables found none worth porting as
schema — building them would cargo-cult the reference's own dead or diverged
state. Recorded deviations:

- **`drift_decisions` — not ported.** The reference's apply-trail table is
  unconsumed dead schema; its own drift phase is still the v0.28 report-only
  scaffold (no `INSERT`/`SELECT` on the table anywhere in its `src/`). memex's
  drift phase matches that ACTUAL behavior (writes a `drift-reports/<date>`
  page, no table), not the reference's unbuilt aspiration.
- **Calibration `(source_id, holder)` scoping — not ported.** Already decided in
  mig 060: memex scopes calibration by `source_id` only, being single-holder
  per tenant. `synth_takes.holder` (mig 091) is for take-visibility fencing, not
  calibration cohorts. Revisit only if a tenant gains multiple distinct holders.
- **`code_traversal_cache` — not ported.** Pure latency memoization of
  `code_blast`/`code_flow` BFS walks with nontrivial xmin-snapshot correctness
  machinery; memex's uncached `code-walk.ts` already works — no functional gain
  at current scale.
- **`conversation_parser_llm_cache` — moot.** memex's conversation parser is
  deterministic regex-only (no LLM call), so there is nothing to cache.
- **`think_ab_results` — deferred.** Backs a `think --ab` baseline-vs-calibrated
  comparison harness memex has no counterpart for; a table without the feature
  is pointless. Revisit if calibration-augmented answers need measured A/B
  validation.

### Deferred REAL gap (not a deviation)
- **Page/timeline content is not keyword/FTS-searchable.** memex FTS runs only
  over `chunks.search_vector`; `pages` (compiled_truth + markdown_body) and
  `timeline_events` text are reachable only by exact-slug lookup or graph walk,
  never by `search`/`recall`. Genuine blind spot for synthesis-written page
  content. Building it = a `pages.search_vector` (weighted title/truth/body/
  timeline) PLUS a new arm wired into `hybrid.ts` — MEDIUM-HIGH risk (live
  ranking). Tracked in TODO.md for its own focused spec, not this batch.

## 2026-07-07 — Waves 5-7 disposition (18-agent recompare) + OOM fix

**OOM incident:** the `lint` cycle phase load-all of the full `frontmatter`
column (18-30 MB voicenote/gcal docs → ~3.4 GB RSS > 3000m cap → cgroup OOM →
restart) is the overnight downtime. Fixed by projecting only the 4 linted fields
(mirrors extract.ts). Not a parity item — a memex-specific regression.

**BUILT (Bedrock-only adaptations of the reference behavior):**
- **Unified model-tier resolver** (`resolve-model.ts`) + opt-in `deep`/Opus tier
  — ported the reference's routing SEAM, NOT its 6-tier config-table/alias/
  subagent machinery (dead schema on an Anthropic-only stack).
- **LLM gateway** (`gateway.ts`) — per-process inflight cap + isAvailable + SDK
  retry/timeout in the client factory. The reference's 138 KB multi-provider
  gateway (capability classification, stop-reason, provider recipes) is NOT
  ported — memex has one provider and one choke point already.

**SKIP / DEFER (verified against ACTUAL code both sides):**
- **page/timeline FTS — SKIP.** Premise was false: memex mirrors page body +
  compiled_truth into the unified chunk index (`page-index.ts`), so pages are
  ALREADY keyword+vector searchable with the ×2 truth-chunk fusion boost. A
  separate `pages.search_vector` (reference schema.sql:811) would duplicate
  content and skew RRF. (Supersedes the earlier "deferred real gap" note — that
  was a shallower agent's stale premise.) Sub-gap: `timeline_events.event` text
  isn't mirrored — DEFER (short, carries source_chunk_id back to a searchable
  chunk, reachable via entity_timeline).
- **features-scan — SKIP.** memex's `advisor` MCP tool already surfaces
  usage/unused-feature guidance under a different name.
- **self-update — SKIP.** Deploy-model deviation: memex ships via docker/SSM, not
  `bun install -g`; the upgrade/heartbeat family is moot.
- **eval-takes-quality — SKIP.** Redundant with the shipped calibration/Brier
  scorecard; a separate offline judge eval adds no signal at current scale.
- **retrieval-reflex — SKIP.** Push-context is OUT (Claude Code IS the agent);
  volunteer_context already covers the pull path.
- **jobs-follow — DEFER.** The reference's `jobs watch` dashboard reads minion/
  budget schema memex lacks (cargo-cult); single-job follow is a `watch -n2
  memex jobs progress <id>` away. Marginal DX, no data gap.
- **backfill-runner — DEFER.** A unified keyset+checkpoint registry over memex's
  already-working scattered backfills — DX consolidation, no capability gap.
- **frontmatter-tooling — DEFER.** Vault-workflow (synthesize/install-hook/
  reindex-frontmatter); memex is server-ingest, `lint --fix` covers the writable
  subset.
- **op-registry-cli — DEFER.** Pure DX (`memex call <tool>` already reaches every
  op); auto-exposing ops as first-class CLI commands is a convenience, not lost
  capability.
- **eval-longmemeval — DEFER (ASK).** ~1000-line research/publication harness;
  worth a dedicated session + operator sign-off, not a batch item.
- **sense-connectors — DEFER (ASK).** email/calendar/x-to-brain collectors +
  integrations CLI — a real feature (memex has the jobs substrate, zero
  collectors). Build the scaffold + one collector deliberately, operator's call
  on which source first.

**Still BUILD, pending the deploy pipeline (SSO):** eval-contradiction (thin read
surface), eval-conversation-parser (cheap pure-fn eval), publish (single-page
HTML export — adds a `marked` dep), brainstorm+lsd (paid slice; data-research
DEFERred).

## 2026-07-07 (session 2) — backlog closure + housekeeping

Fresh audit run against the FROZEN reference (dir untouched since 2026-06-26, still
v0.42.53 — the same baseline waves 5-7 already 18-agent-compared). No new reference
surface to chase; a full re-compare only reproduces the settled verdicts above.
Focus was verification + cleanup, not new porting.

**Backlog closed — the three "still BUILD" items re-verified against ACTUAL code
both sides and dispositioned:**
- **eval-conversation-parser → SKIP.** The parser itself is ported and live
  (`core/conversation-parser.ts`); the reference's `eval.ts` fixture-recall scorer
  is a dev-only quality harness with zero consumer on a 3-user brain. Not built.
- **publish → SKIP.** Reference `commands/publish.ts` inlines `marked` as a runtime
  dep to emit an AES-encrypted single-page HTML share. memex's `commands/export.ts`
  already covers md/JSON dumps; no user needs public-HTML sharing. Adding a runtime
  dep for it fails the laziness test.
- **brainstorm + lsd → ASK (operator-gated).** Absent entirely in memex. Paid Sonnet
  slice (`core/brainstorm/` orchestrator + judges + domain-bank + `brainstorm`/`lsd`
  CLI + a doctor check). ASK-scope: needs an explicit operator "build it" before any
  work, like every paid slice.

A CLI-command diff (reference ~30 commands absent from memex's CLI) confirmed **no
hidden 4th gap**: each absent command is either surfaced as an MCP tool instead
(`whoknows`→`find_experts`, `founder`→`takes_scorecard`, recall/query/anomalies/
advisor/graph-query/forget all live MCP tools) or an already-dispositioned deviation.

**Housekeeping (no behavioral change):**
- **Red test fixed** — `tests/facts_decay.test.ts` "forces decay OFF on the public
  bearer path" seeded facts at the column default `visibility='private'` then expected
  them visible on the public path; the mig-085 world-visibility floor (a deliberate
  deviation, top of this file) correctly hid them. Test now seeds `'world'` to match
  its real intent (decay OFF on public, ON internally). 23/23 green.
- **Dead code removed** — `src/core/output/transcript.ts` (30-line empty-interface
  stub, "friction adds real persistence", 0 importers in src OR tests, superseded by
  `transcripts-read.ts`/`subagent_ledger.ts`/`eval-capture.ts`). Deleted.
- **Stale worktrees pruned** — three `wf/b2-*` throwaway workflow branches
  (cycle-lock / embed-deadline / retry-after) whose features already shipped on main
  via different commits (mig 050 + `db-lock.ts`, `embedQueryBounded`, `Retry-After`).

**Surfaced + dispositioned (operator, 2026-07-07): KEEP — may be re-adopted /
reference-aligned:**
- `src/core/throttle.ts` (200 L, full test suite) — 0 src callers; superseded by the
  v1.90 LLM-gateway inflight cap. Orphaned-but-tested. KEPT.
- `src/core/concurrency.ts` (`Semaphore`, 53 L) — 0 src callers; its header comment
  falsely claimed "used by the file sweep". KEPT; the **stale doc comment is fixed**
  to state it is currently unwired (gateway covers the concurrency ceiling) and kept
  as a generic primitive for embed-batch gating.
- Staged/deferred-but-kept (mirror reference structure, wired later): `nudge.ts`
  (mig-074, default-OFF), `subagent_ledger.ts`, `recipe-state.ts` (mig-013),
  `chunkers/semantic.ts` (documented placeholder).

**brainstorm+lsd disposition (operator, 2026-07-07): SKIP for now** — stays in the
backlog as an ASK item. Paid Sonnet feature, 3-user brain, no interactive-brainstorm
demand; revive on an explicit operator "build it".

## 2026-07-07 (session 2) — FULL line-level recompare (16-subsystem workflow)

Operator directed a fresh exhaustive line-by-line compare regardless of the frozen
reference. A 17-agent workflow (one high-effort agent per subsystem reading BOTH
trees + adversarial re-audit of the 2 security cells + synthesis) confirmed
**brain-core behavioral parity** and surfaced a short, real actionable list. This
run was worth it — it found genuine gaps the doc-driven passes had not itemized.

**VERDICT: at parity for the deterministic brain-core; memex ahead on tenancy
(RLS+grants), durable jobs/DAG, host-survival (OOM-hardening), 6-stage slug canon,
real take-evidence retrieval (reference ships a placeholder stub), page-mirror
self-heal, per-row embedding provenance.** Behind only on operational hardening +
one telemetry-scrub gap + one facts-completeness miss (all below).

### BUILT this session (clean, additive, tested — shipped)
- **eval-scrub JWT/Bearer masking** (`eval-capture-scrub.ts`). The PII scrubber
  masked email/IBAN/CC/phone/IP but NOT JWT / Bearer tokens; on a bearer-authed
  system a token pasted into a query landed unmasked in `eval_candidates`. Ported
  the reference's two regexes (`[token]` placeholder, bearer-before-jwt order).
  Test: 24/24. Reference `core/eval-capture-scrub.ts:30-104`.
- **Typed-claim extractor fields** (`facts-extract.ts`). The LLM turn-extractor
  omitted metric/value/unit/period, so conversation-extracted facts always landed
  with NULL `claim_*` even though `addFact` (mig070 columns), the fence, and
  trajectory/drift all consume them. Added the 4 fields to the prompt + parser +
  the `writeExtractedFacts`→`addFact` thread (additive; non-quantitative facts pass
  all-null, behavior-neutral). Test: 11/11. Reference `core/facts/extract.ts:101`.

### DEVIATIONS RESOLVED 2026-07-08 — operator: "match the reference, don't ask"
The operator's standing rule is match the reference for every such question. Both
of the surfaced deviations below are now CLOSED to match the reference (v1.96.0):
- **A — public `stats`/`jobs_list`/`jobs_get`/`jobs_logs` → NOW FORBIDDEN from the
  public bearer.** The reference marks all four `admin` (`operations.ts:2160`
  get_stats, `:3021` get_job). Added to `FORBIDDEN_MCP_TOOLS_FROM_PUBLIC`; the two
  tests that encoded the old "public-allowed" deviation were flipped to assert
  rejection. The public bearer no longer sees whole-brain counts or the job queue.
- **B — notability write policy: ported the reference's `notabilityFilter`.**
  `writeExtractedFacts` gained `notabilityFilter?: 'all' | 'high-only'` (reference
  `facts/backstop.ts:62/305/325`). memex DEFAULTS to `'all'` (keep every fact) —
  which is exactly the reference's default for every surface: the reference only
  passes `'high-only'` on its file-vault SYNC path, and memex (DB-canonical) has
  no such path. So memex's keep-all already matched the reference; the port adds
  the exact knob for parity + a future bulk surface. Behavior-neutral by default.
- **C — `source_grants` federation: no change (already matches).** The reference
  is single-holder-by-default (each tenant reads only its own source); memex's
  `source_grants=0` is the same siloed default. Cross-tenant read stays an
  explicit opt-in the operator enables per grant.

### (historical) DEVIATIONS surfaced 2026-07-07 — since resolved above
- **`stats` + `jobs_list`/`jobs_get`/`jobs_logs` reachable from the public bearer.**
  The reference marks all four `admin`. In memex they are NOT in
  `FORBIDDEN_MCP_TOOLS_FROM_PUBLIC` and rely on `OPERATOR_ONLY_TOOLS`, which only
  gates OAuth-tenant callers (`authInfo` present) — the static public bearer is
  `authInfo===undefined`, so they are reachable. This is DELIBERATE: explicit tests
  assert it (`public_guard.test.ts:180` stats→false, `:200` "allows jobs reads") and
  jobs reads are redacted to metadata (`mcp_backlinks_jobs_redaction.test.ts`).
  `stats` leaks whole-brain COUNTS unredacted (low sensitivity). A prior public_guard
  edit to forbid all four was REVERTED — flipping a tested public-API behavior would
  break a thin-client status reader. **OPEN operator call: keep the deviation (thin-
  client status) or match the reference (forbid + rewrite the 2 tests)?**
- **Notability keep-all on the facts write path.** The reference's `notabilityFilter
  ='high-only'` drops LOW facts + defers MEDIUM. memex writes every extracted fact
  with its notability recorded (ranks by it, never drops). For a "remember
  everything" second brain, keep-all is arguably BETTER — dropping the operator's
  LOW facts is lossy. Left as a deliberate deviation, NOT ported.

### Actionable gaps NOT built — ranked, deferred to a careful session (see TODO.md)
These touch the live migration / HNSW / DB machinery — real risk on prod RDS, so
NOT rushed into this batch:
1. **`CREATE INDEX CONCURRENTLY` in the migration runner** (M) — memex always wraps
   every migration in `engine.transaction()` (`migrate.ts:180`), so it can never
   build an index concurrently; every index migration takes a blocking lock on live
   RDS. Add a `transaction:false` escape hatch. Reference `core/migrate.ts:29`.
2. **HNSW index lifecycle manager** (M/L, depends on #1) — atomic rebuild via
   CONCURRENTLY+RENAME, zombie-index sweep, build monitor. memex has only the static
   `CREATE INDEX` in mig 001; an interrupted build (OOM history) can leave an invalid
   index that silently degrades the vector arm. Reference `core/vector-index.ts:63`.
3. **schema-verify drift detection** (M) — compare live RDS schema vs migrations,
   surface `MigrationDriftError`. Reference `core/schema-verify.ts:1`.
4. **frontmatter→typed-edge mapping coverage** (S) — add related_to/see_also/
   investors mappings to `typed-links.ts` FIELD_MAPPINGS (default-OFF, low risk).
5. **auth-info.ts dead `resolveRequestedScope`/`sourceScopeOpts`** (LOW) — 0 call
   sites; delete or wire + add a regression test that no read tool honors a
   caller-supplied `source_id` (latent IDOR trap if a future handler adds the param).
Lower-value/skip: cross-slug dedup (memex ingest isn't overlapping vault roots),
background-work drain (PGLite-only; prod is RDS), runtime budget cap, import-checkpoint.

## 2026-07-09 — independent 7-cluster re-sweep (frozen reference)

A fresh independent audit (7-agent workflow, one high-effort agent per subsystem
cluster reading BOTH trees, each surfaced gap adversarially refuted) against the
still-frozen reference (v0.42.53). Four clusters at parity; three gaps survived
refutation. Two were parity-restoring fixes (shipped); one is a recorded
deliberate deviation.

**SHIPPED (parity-restoring, match the reference):**
- **`extract_facts` now `scope:"write"`.** The op declared no `scope`, so the
  per-op scope gate (`dispatch.ts:388`) defaulted it to `read` — a read-scoped
  OAuth tenant could invoke the paid Bedrock preview path (persist was already
  write-gated inline; the preview extractor was not). The reference marks the
  whole op write (`operations.ts` mutating:true, scope:'write'). Adding
  `scope:"write"` folds it into the derived `WRITE_SCOPED_TOOLS` and the per-op
  gate, so a read token is rejected before the paid call. Operator path
  (`authInfo===undefined`) and the public bearer (already in
  `FORBIDDEN_MCP_TOOLS_FROM_PUBLIC`) are unaffected. Prod-safe: the op is
  default-OFF (`MEMEX_FACTS_EXTRACTION`). Golden roster test updated.
- **`notifications/initialized` → HTTP 204.** memex returned a JSON-RPC -32601
  method-not-found for the standard MCP post-`initialize` notification (a
  no-`id` request); tolerated by claude.ai/ChatGPT but non-conformant. Now
  acknowledged with an empty 204, matching the reference
  (`http-transport.ts:361`). Intercepted in `makeMcpHandler` after parse,
  single (non-batch) only. Test added.

**SHIPPED (parity-restoring) — migration-runner retry.** The reference retries a
migration 3× on a statement-timeout (57014) / retryable connection error
(5/15/45s backoff) and, on final failure, surfaces the blocking
idle-in-transaction PID with a paste-ready `pg_terminate_backend()` hint
(`core/migrate.ts` runMigrationSQLWithRetry / getIdleBlockers, matcher in
`core/retry-matcher.ts`). Ported faithfully, adapted to memex's file-based
runner: `getIdleBlockers`, `MigrationRetryExhausted`, and `applyOneWithRetry`
now wrap memex's bundled `engine.transaction()` (SET LOCAL lock_timeout +
statement_timeout + SQL + bookkeeping INSERT). A rolled-back attempt records
nothing, so a retry re-runs atomically. `isStatementTimeoutError` added to
`core/retry.ts` (the migration path retries 57014; the bulk-write
`isRetryableConnError` still doesn't). NO conflict with memex's fail-fast
`lock_timeout` stance — the reference also leaves lock_timeout (55P03)
non-retryable in migrations; only statement_timeout + connection reset retry.
Backoff collapsible via `MEMEX_MIGRATE_BACKOFF_MS` for tests. Superseded the
earlier "keep fail-fast, don't port" call after the operator reaffirmed strict
reference parity (match the reference, don't deviate). The `transaction:false`
CONCURRENTLY escape hatch stays DEFERRED — memex has no migration that uses
CONCURRENTLY (index rebuilds run out-of-band via the `hnsw` CLI), so porting it
would be dead code (the one adapt-to-stack exception).

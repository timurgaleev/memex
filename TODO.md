# TODO — memex-stack

Forward-looking work that is intentionally deferred. Items already
shipped live in [`CHANGELOG.md`](./CHANGELOG.md); items rejected as
out-of-scope live under "NOT in scope" in the design doc that
introduces them.

---

## Parity gap backlog (vs the reference, 2026-06-09)

Source: a full subsystem-by-subsystem diff of this brain against the
reference retrieval implementation. memex stays **brain-only** — the
agent/LLM-synthesis/auth/voice/self-upgrade half is deferred (north-star
gated), recorded below but not planned. Capabilities are described
generically (no upstream names).

### Mis-adaptations to verify (highest priority — we adopted it but diverged)
- [x] **Per-prefix recency decay** (retrieval, high) — DONE (already shipped;
  TODO was stale). `core/search/recency.ts` has `DEFAULT_RECENCY_DECAY`
  (prefix→half-life map: `concepts/`=evergreen, `daily/`=14d, …),
  `parseRecencyDecayEnv` (`MEMEX_RECENCY_DECAY` override, fails loud),
  `resolveRecencyConfig` (longest-prefix-match), `recencyMultiplierForPath`.
  Wired into `hybrid.ts` (memoized `getRecencyDecayMap()`, applied per-hit at
  the recency step) and folded into the query-cache ranking signature. Paths
  matching no prefix use the original uniform default (120d/0.6) — backward
  compatible.
- [x] **Two-layer cache invalidation** (retrieval, high) — DONE (migration 031).
  Adds a per-document `documents.generation` counter + a
  `query_cache.doc_generations` `{doc_id: generation}` snapshot. Layer 1 = the
  existing global-clock bookmark; Layer 2 = when the clock advanced, serve iff
  every referenced document still exists with an unchanged generation. A write
  to an UNRELATED doc no longer evicts the query. Empty snapshots rely on
  Layer 1 only (CDX-6 parity). A shared `cacheFreshClause` drives read/prune/
  stats. ALL ranking-relevant document writers now bump generation + clock so
  Layer 2 stays sound: `indexer-tx` (content/frontmatter, folded into the
  UPSERT), `frontmatter-inference` (salience), `sources.backfillDocumentSources`
  (source-boost + scope); `memex embed` re-embeds without a generation bump so
  it `clearCache()`s outright. putCachedQuery only persists when the live clock
  still equals the stamped clock (mid-search-write race guard). Accepted
  tradeoff (faithful to the reference): a doc NOT in the result set that becomes
  relevant doesn't invalidate until a referenced doc changes. Reviewed by
  ai-engineer + code-reviewer + codex (codex caught the mid-search race + the
  two non-indexer writers; ai-engineer independently caught the same writers).
- [x] **Link provenance columns** (schema, high) — DONE v1.3.9 (migration
  029). NOTE: the columns already existed as bare nullable stubs from
  migration 024 (`context`, `link_kind`, `origin_page_id`, `origin_field`,
  `resolution_type`) — the original backlog claim that `links` was "missing"
  them was wrong (caught by the codex review). 029 HARDENS the stubs:
  `context` NOT NULL DEFAULT '' (+ backfill); CHECKs on `link_kind`
  (plain/typed_ner) + `resolution_type` (qualified/unqualified); renames the
  mis-named `origin_page_id` → `origin_slug` (slug-keyed model, soft ref).
  `addLink` validates + sticky-preserves them. No public surface (graph reads
  don't project them + allowlist excludes them). NER UNIQUE-coexistence
  (`link_kind` in the unique key) intentionally deferred to the NER increment
  below — nothing writes `typed_ner` yet, so no collision today.
- [x] **`parent_symbol_path` is scalar TEXT, should be `TEXT[]`** (chunkers,
  medium) — DONE v1.3.8 (commit 39755ec, migration 028). Chunker emits the
  full ancestor chain outermost-first; indexer writes `TEXT[]`; migration 028
  is catalog-guarded (re-run-safe — codex caught the nesting hazard) and
  casts existing scalars to 1-element arrays in place. Live-verified on RDS:
  column `data_type=ARRAY/_text`, 102 rows cast, sample `[["Worker"]]`.
  Deeper chains fill in on reindex.
- [ ] **Slug-based page-type inference** (enrichment, high) — we type pages
  only explicitly at PUT; the reference infers type from path prefixes.
- [x] **Tool defs hardcoded, not generated** (mcp, high) — DONE v1.3.18.
  All 25 tool `inputSchema`s now DERIVE from one `OPERATIONS` contract
  (`mcp/operations.ts`: `ParamDef` + `paramDefToSchema` + `operationInputSchema`);
  `tool_defs.ts` is `OPERATIONS.map(...)`. A snapshot-equivalence test
  (`tests/tool_defs_contract.test.ts` vs `fixtures/tool_defs.snapshot.json`)
  pins the generated output to the original hand-written defs — proven
  zero-behavior change. Unblocks the derived param-validation item below.
- [x] **Param validation inline, not derived** (mcp, high) — DONE.
  `validateParams(op, params)` in `mcp/operations.ts` enforces declared
  type/enum/min-max for present params (throws `OperationError('invalid_params')`);
  wired as a pre-dispatch check in `dispatch.ts`. Required-presence stays with
  the handlers; unknown params not rejected. Safe by construction (client derives
  params from the same contract → a per-op parity test proves no well-formed call
  is rejected). One tightening: `object` params reject arrays. security-engineer
  SHIP + code-reviewer CLEAN + codex. FOLLOW-UP (deferred): the redundant inline
  `k`/`token_budget`/`limit` range guards in the handlers are now belt-and-
  suspenders — fold them out once validateParams is trusted (still cover the
  CLI-direct call path).
- [x] **`search` CLI lacks diagnostics** (cli, high) — DONE (`search modes`).
  `commands/search-modes.ts`: read-only dump of the active ranking knobs
  (resolved value + default + `MEMEX_*` env per knob) + intent taxonomy + the
  ranking signature. Sources every value from the live getters (no drift),
  no storage/search, doubles as a config validator (fails loud on a bad env).
  code-reviewer CLEAN. `stats` not added (overlaps `status`/`cache stats`);
  `tune` deliberately omitted (a runtime mutation — env vars are the tuning
  surface, and `search modes` shows their effect).
- [ ] **BaseCyclePhase + warn-state result envelope** (cycle, medium) — our
  phases are unstructured fns with `{ok:boolean}`; adopt a base class
  (source-scope + budget + uniform errors) and an `ok/warn/fail` envelope.
- [x] **OperationError shape** (mcp, medium) — DONE. `core/operation-error.ts`:
  `OperationError {code, message, suggestion?, docs?}` → `toEnvelope(isPublic)`
  (public WITHHOLDS the free-text `message`, keeps code + static suggestion/docs;
  internal keeps all). Dispatch catch renders it; raw exceptions stay on the
  fully-redacted `publicSafeErrorMessage` path. 4 validation sites migrated
  (search q/k/token_budget + unknown-tool). security-engineer SHIP (message-drop
  is a structural control, no enumeration/XSS) + code-reviewer CLEAN.
  PARTIAL MIGRATION (deferred): the other ~26 `errResult(string)` sites still
  emit plain strings — the envelope/string duality is intentional for now;
  migrate the rest opt-in if a full structured surface is wanted.
- [x] **RateLimiter LRU+TTL bounds** (mcp, medium) — DONE. The limiter already
  had a `maxKeys` cap + idle (fully-refilled) sweep + separate public/internal
  limiters, so the catastrophic leak was already bounded. The real residual was
  that at the cap it FAILED CLOSED (locked out new legit keys under a
  distinct-IP flood). Now it LRU-evicts the least-recently-used bucket to admit
  a new key (never fail-closed), plus a `ttlMs` (15 min) stale sweep alongside
  the idle sweep. `src/mcp/rate_limit.ts`. security-engineer SHIP (net
  improvement, self-healing, no amplification) + code-reviewer CLEAN (TTL test
  isolation tightened). The "separate pre-auth IP / post-auth token limiters"
  part already exists (public vs internal RateLimiter instances).
- [ ] **Structured OperationContext** (mcp, medium) — centralize
  `buildOperationContext()` instead of ad-hoc per-call options.
- [ ] **Qrels format** (eval, medium) — ours is path-centric; the reference
  is slug-centric (`query_id`, `relevant_slugs`, `embedding_dim`). Add an
  adapter before reusing reference qrels.
- [ ] **`link_kind` UNIQUE-coexistence** (enrichment, medium) — the column
  itself landed in migration 029 (v1.3.9); the remaining piece is widening
  the `links` UNIQUE key (today `(source_slug, target_slug, type)`) to include
  `link_kind` (+ `origin_slug`) so a plain body mention and a typed-NER edge
  between the same pair coexist instead of UPSERT-colliding. Do as part of the
  NER-link increment, before anything writes `typed_ner`.

### Integrate now (brain-only, safe, in-scope) — prioritized

#### From the 2026-06-12 reference comparison (reference advanced 03ffc6e → ecd6ae8)
- [x] **Well-form lone UTF-16 surrogates before `::jsonb` (ingest, HIGH)** —
  DONE v1.3.34 (`core/well-form.ts`; applied at indexer-tx frontmatter +
  frontmatter-inference + pages compiled_truth; lone surrogate→U+FFFD + NUL
  dropped, valid pairs kept; integration proof test; code-reviewer CLEAN).
  Original note kept below for context.
- [ ] (context) the reference shipped `v0.42.40.0` fixing exactly this: a text window
  sliced by raw UTF-16 index (their `excerpt()` link-context) can leave an
  UNPAIRED surrogate half; serialized into JSONB, Postgres rejects it at the
  `::jsonb` cast and ABORTS THE WHOLE INSERT — and if a staleness bookmark only
  advances on a clean finish, the job wedges. memex shares the class: it has NO
  surrogate sanitization anywhere (`grep -r surrogate src` → empty) and writes
  `frontmatter` via `$4::jsonb` (indexer-tx.ts:94-106, `JSON.stringify(doc.frontmatter)`).
  A markdown doc whose frontmatter (or any jsonb-stored sliced text — link
  `context` mig 029, etc.) carries a lone surrogate (truncated emoji / bad
  encoding) would fail to index. FIX: a `wellFormForJsonb(s)` helper —
  `s.toWellFormed()` (lone surrogate → U+FFFD; Bun supports it) AND strip
  `U+0000` (Postgres jsonb rejects NUL too, which toWellFormed does NOT remove)
  — applied at every jsonb-write site (start with frontmatter in indexer-tx; audit
  link `context`, any other `::jsonb`). Test: index a doc with a lone surrogate +
  a NUL in frontmatter → succeeds, value sanitized. Small, safe, additive, real
  production-bug fix. DO THIS FIRST next session.
- The reference's other new commit, `v0.42.39.0 Retrieval Reflex` (teach the
  agent when/what to retrieve), is AGENT-LAYER (north-star, out of brain-only
  scope — the agent is Claude Code). Not planned. `v0.42.37.0` jobs stale-lock
  reap was already assessed N/A (infra memex doesn't run).

#### From the 2026-06-10 reference comparison (4-agent subsystem diff)
- [x] **Evidence + create_safety stamping** (retrieval, high) — DONE v1.3.19.
  `core/search/evidence.ts`; arm-membership adaptation (reference's cosine
  floors are incompatible with memex's RRF score). Pure-additive, no reorder.
- [x] **Title-phrase boost** (retrieval, high) — DONE v1.3.20.
  `core/search/title-match.ts`: post-fusion multiplier (`MEMEX_TITLE_BOOST`,
  default 1.25) when the query is a contiguous phrase in the page title; feeds
  evidence's `exact_title_match` (arm-independent, exists at any rank). ALSO
  tightened v1.3.19 evidence: `high_vector_match`→`exists` now gated on a top
  rank band (`RANK_BAND=3`) so a common token's both-arms coincidence outside
  the head reads `keyword_exact`/`probable`, not a false `exists` — the band
  (vs rank-0-only, codex HIGH) protects a legit page at rank 1–2. Query-cache
  key folds in `RANKING_VERSION` + the live boost factor so a ranking/env change
  re-keys the cache (codex MEDIUM). reviews: ai-engineer + code-reviewer CLEAN
  (no CRIT/HIGH); codex caught both the rank-0 over-tightening and the cache-key
  staleness — both fixed.
- [x] **Multi-layer dedup** (retrieval, med) — DONE v1.3.25 (Jaccard near-dup
  layer). `dedupByTextSimilarity` in `core/search/dedup.ts`: additive stage
  after per-doc dedup, drops a hit with word-set Jaccard > `MEMEX_NEARDUP_JACCARD`
  (0.85) vs a higher-ranked kept hit; min-12-token floor protects short distinct
  chunks; applied AFTER rerank (so rerank decides which twin survives — ai-eng
  HIGH); skipped for `exact` intent; threshold folded into the cache ranking
  signature. Type-diversity + compiled-truth layers NOT ported (no page-type
  taxonomy / no LLM cycle in memex). ai-engineer + code-reviewer reviewed (HIGH
  rerank-placement + MEDIUM short-chunk-floor both fixed). codex hung (7×).
  Type-diversity sub-layer stays DEFERRED — memex has no page-type taxonomy
  (single vault), so it would be a no-op or harmful; revisit only if a real
  type axis appears.
- [x] **Adaptive return-sizing** (retrieval, med) — DONE v1.3.22.
  `core/search/return-policy.ts` + `SearchOptions.adaptiveReturn` (per-call,
  default-OFF). single-answer intents (factual/exact)→entityMax(2), broad
  (topic/howto/personal)→otherMax(6), minKeep failsafe; a cap not a cliff
  (autocut stays rejected). Applied as the FINAL return-view, after the cache
  write + eval-capture, so it never poisons the cache or shrinks the eval
  window. ai-engineer + code-reviewer CLEAN (ai-engineer MEDIUM: onCapture saw
  capped ids → moved cap after capture; howto-wide is a documented judgment
  call). codex hung (unavailable).
- [x] **`sanitizeQueryForPrompt`/`sanitizeExpansionOutput`** (security, med) —
  DONE v1.3.21. Both sides of the Nova-Lite query-expansion call sanitized
  (`core/search/expansion.ts`): input neutralized (cap/fence/tag/leading-
  injection-preamble strip + warn), output validated (control-char strip /
  cap / dedupe / count cap). Defense-in-depth — variants only become tsquery
  terms. security-engineer + code-reviewer CLEAN (1 MEDIUM log-only fix:
  all-keyword query → empty → warn + skip). codex hung (unavailable today).
- [x] **Embedding backfill CLI (`memex embed`)** (retrieval, high) — DONE.
  Addresses the live ~40% embed-coverage finding: re-embeds non-code chunks
  missing an `embeddings` row (invisible to the vector arm). `core/embed-backfill.ts`
  + `commands/embed.ts` + `--limit`/`--dry-run`; idempotent (`IS NULL` anti-join
  + `ON CONFLICT DO NOTHING`); code chunks excluded (matches source-health's
  `embeddable`); model id sourced from `DEFAULT_MODEL_ID` (no drift). ai-engineer
  + code-reviewer CLEAN (model-id-from-config + `--limit` Number-parse fixes
  applied). The actual live re-embed is operator-triggered (Bedrock cost).
  FOLLOW-UP (deferred): a small concurrency pool (3–5) would cut wall-time ~4×
  for a large unattended backfill; serial is fine for the one-shot today.
- [x] **Weighted chunk `search_vector` + trigger + GIN** (schema, high) — DONE
  (migration 030). Weight A = symbol identity that EXISTS in memex
  (`symbol_name` + `parent_symbol_path`, populated by 027/028); B = body. The
  reference's `doc_comment`/`symbol_name_qualified` weight-A inputs don't exist
  here yet (separate items) — fold them in when they land. A BEFORE
  INSERT/UPDATE trigger (NOT a generated column: `array_to_string` of the scope
  array is not immutable); existing rows backfilled in the migration. keyword.ts
  swapped off `ts` onto `search_vector`; config stays `simple` so markdown
  matched-set + order are unchanged (RRF is rank-based; D→B is a uniform scale).
  ai-engineer + code-reviewer reviewed (ai-eng HIGH: order-preservation depends
  on the flagless `ts_rank_cd` call → guardrail comment added; MEDIUM: code-chunk
  scope match is a recall change → wording tightened; code-reviewer all-PASS).
- [ ] **Contract-derived `validateParams(op, params)`** (mcp, high) — now that
  the OPERATIONS contract exists (v1.3.18), enforce enum/min/max the schema
  already advertises. BEHAVIOR-CHANGING (rejects params handlers currently
  accept) → keep the manual guards, snapshot parity, ship as a deliberate pass.
- [ ] **`OperationError {error,message,suggestion?,docs?}`** (mcp, med) —
  structured error envelope; migrate handlers opt-in, keep the string wrapper.
- [x] **Facts-fence parser/renderer** (cycle, med, LLM-free) — DONE.
  `core/facts-fence.ts` (parse/render/strip) + `core/fence-shared.ts` (generic
  table-row primitives, faithful port). `| # | claim | confidence | source |`,
  strikethrough=inactive, memex-namespaced markers. Pure, INERT until
  `extract_facts`. Adapted to memex's simpler fact model (entity_facts);
  reference's kind/visibility/notability/typed-claim columns NOT ported. Escape
  pair is a true round-trip inverse (char-scanner split + backslash escape;
  code-reviewer caught the trailing-backslash gap → fixed). code-reviewer CLEAN.

- [ ] **Graph read redaction on public** (high) — SHIPPING THIS INCREMENT:
  strip provenance (`source_chunk_id`/`written_at`/confidence) from
  `graph_neighbors`/`graph_query` on the public bearer; keep slugs+type
  (the 2026-06-05 decision). Closes the triple-confirmed relationship-dump
  leak.
- [x] **Chunk weighted FTS** (high) — DONE (migration 030; see the weighted
  `search_vector` item above). Weight A = `symbol_name` + `parent_symbol_path`,
  B = chunk text; `doc_comment`/`symbol_name_qualified` fold in when added.
- [ ] **`symbol_name_qualified` column** (high) — stable edge-resolution key;
  extend migration 027, weight A in FTS.
- [ ] **doc_comment chunk column** (medium) — capture JSDoc/docstring for
  FTS weight-A.
- [ ] **Entity slug canonicalization** (high) — 4-stage LLM-free resolver
  (exact → trgm fuzzy → prefix-expansion by connection_count → slugify).
- [ ] **Gazetteer auto-link mentions** (high) — entity-typed page gazetteer +
  maximal-munch body scan with self/cross-source guards + first-mention
  dedup (today only explicit `[[Foo]]`).
- [ ] **Slug/page alias resolution** (medium) — `slug_aliases` + `page_aliases`
  so renamed pages still resolve wikilinks.
- [x] **IR metric suite** (high) — already present in `core/search/metrics.ts`
  (precisionAtK/recallAtK/MRR/ndcgAtK/jaccardAtK/top1Stable/binaryGrades) +
  `metrics.test.ts`. The old "today only hit/rank/MRR" note was stale.
- [x] **Hermetic CI correctness gate — HYBRID** (high) — DONE v1.3.23.
  `tests/retrieval_quality_hybrid.test.ts` gates the FULL vector+keyword+RRF
  path with env-overridable floors (hit/MRR/nDCG), via a deterministic
  basis-vector embedder (`tests/det-embed.ts`, FNV-1a BoW + a small synonym
  table so the vector arm carries a keyword-blind query) injected through the
  new test-only `SearchOptions.embedQuery` seam. Complements the pre-existing
  keyword-only gate (`retrieval_quality.test.ts`). ai-engineer + quality-guard
  CLEAN (their MEDIUM "gate would pass with a broken vector arm" fixed by the
  synonym-bridge probe). codex unavailable.
- [x] **Query-family harness expansion** (med) — DONE.
  `tests/retrieval_quality_families.test.ts`: named families (`body_term`
  control, `alias_synonym`, `multi_chunk_dilution`) with per-family Hit@3 gates
  over the hermetic hybrid path. alias_synonym carries a differential probe
  (keyword arm alone provably fails it → true vector-arm sentinel);
  multi_chunk_dilution competes a focused chunk against a partial-match
  distractor. quality-guard + ai-engineer reviewed (HIGH "could pass with a
  dead vector arm" → fixed with the differential probe; MEDIUM body-overlap +
  weak-dilution → both hardened). The `title-substring` family was intentionally
  dropped: the title boost only re-ranks already-retrieved hits (title isn't in
  the chunk vector/FTS), so a clean non-flaky title-only family needs more
  scaffolding than it's worth — the v1.3.20 title-match unit tests already cover
  the boost mechanics.
- [x] **Deterministic tiebreak in the keyword arm** (med, PROD) — DONE v1.3.24.
  `keyword.ts` ORDER BY gains `, id COLLATE "C" ASC` (byte-order, identical on
  PGLite + RDS regardless of default collation — a bare `id ASC` would inherit
  divergent collations). `ts_rank_cd` is a computed expression (already sorted)
  so the tiebreak is free — no plan/ranking change. The VECTOR arm is left
  untied ON PURPOSE: a secondary key on `vector <=>` can defeat the HNSW index
  (mig 001), and exact cosine ties on real embeddings are vanishingly rare;
  HNSW order is deterministic per index. `tests/tiebreak_determinism.test.ts`
  proves it. code-reviewer CLEAN (its collation MEDIUM is exactly the
  COLLATE "C" applied). codex unavailable.
- [x] **Request param redaction for logging** (high) — DONE v1.3.13.
  `mcp/param-redaction.ts` `summarizeMcpParams` → `{declared_keys,
  unknown_key_count, approx_bytes (1 KB-bucketed, side-channel-safe)}` + a
  `logToolCall` hook in the HTTP transport (opt-in `MEMEX_LOG_REQUESTS=1`, off
  by default). Slugs/queries/paths never reach logs. Follow-up: a persistent
  JSONL audit-trail writer (ISO-week-rotated) that consumes this summary —
  see the audit-writer item below.
- [x] **`call <op>` dispatch CLI** — DONE v1.3.14 (`commands/call.ts`:
  `memex call <tool> [--args '<json>']` → dispatchTool internal ingress, exit 1
  on tool error). The **`status` snapshot** also shipped (v1.3.16,
  `commands/status.ts` — stats + brainHealthMetrics + cacheStats) — the
  brain-facing operational surface (cache + call + status) is now complete.
- [ ] **Enum/array param validation** (medium) — emit `enum`/`items` in
  `paramDefToSchema` so invalid enums never reach handlers.
- [ ] **Score-cliff autocut** (medium) — score-discontinuity detection
  post-rerank (return 1 when obvious, k when genuinely k answers).
- [x] **doctor categorization + cause-ranking** (high) — DONE v1.3.10.
  Checks bucketed brain/ops/meta (no `skill` — agent-only, N/A to brain-only);
  `summary.ranked_failures` orders root-cause-first with a downstream_of
  honesty contract (only annotated when the root is also failing). Drift guard
  fails CI on an uncategorized check. `core/doctor-categories.ts` +
  `core/doctor-cause-rank.ts`.
- [x] **`cache` CLI** (stats/clear/prune) — DONE v1.3.12 (`commands/cache.ts` +
  `cacheStats`/`pruneCache`/`clearCache`; fresh-vs-stale vs the doc clock).
  The sibling **`status` dashboard** (v1.3.16) + **`call <op>` dispatch**
  (v1.3.14) also shipped — operational surface complete.
- [x] **per-source health metrics** (medium) — DONE v1.3.11. `core/source-health.ts`
  `brainHealthMetrics` (embed_coverage over non-code chunks, lag_seconds,
  queue_depth, failed_jobs_24h) surfaced as the `source-health` doctor brain
  check (informational; only failed_jobs_24h gates ok). Brain-level (memex is
  single-source), not per-source. **FINDING surfaced: live embed_coverage is
  ~40% (528/1307 embedded) with 0 code chunks — i.e. ~779 markdown chunks lack
  a vector. Stable all session (347/1307/528). Operator should confirm whether
  that's by-design (a backfill/model-migration gap) or a real vector-arm
  retrieval hole.**
- [x] **JSONL audit-trail writer** (medium) — DONE v1.3.17.
  `core/audit-week-file.ts` (`isoWeekKey`/`auditFilePath`/`appendAudit`,
  best-effort, ISO-week-rotated, `MEMEX_AUDIT_DIR` env). `logToolCall` appends
  the redacted request summary (from `summarizeMcpParams`) when the dir is set
  — independent of the `MEMEX_LOG_REQUESTS` console sink, off by default. No
  param values in the trail.
- [ ] **extract_facts + recompute_emotional_weight cycle phases** (high,
  LLM-free) — reconcile DB facts from a `## Facts` fence; score page
  salience [0..1] from tags/takes.
- [ ] **resolve_symbol_edges cycle phase** (medium) — batch-resolve code-edge
  symbols to chunk IDs.
- [ ] **Per-handler timeout_ms + deterministic stagger** (medium) — wall-clock
  cap per job; FNV-1a offset to decorrelate cron jobs.
- [ ] **Code-chunk wall-clock timeout** (low) — tree-sitter `setTimeoutMicros`
  so a pathological file can't hang the WASM parser.

### Facts model (in-scope, larger)
- [ ] **facts-fence markdown binding** (high) — make a `## Facts` fence the
  system-of-record; parse/strip/render/upsert each cycle (`row_num`,
  `source_markdown_slug`). Today facts are DB-only and reset-fragile.
- [ ] **Fact metadata** (high) — `kind`, `notability`, `valid_from`,
  `valid_until` for categorization / recall ranking / forget-supersede.
  (`visibility` only if a multi-visibility model is ever adopted — see
  agent-layer note; single-holder today.)
- [ ] **Timeline extraction from meetings** (medium, LLM-free) — attendees +
  body mentions. **Timeline dedup key** — verify it covers
  `(page_id, date, summary, source)`.

### Schema / code-graph (in-scope, larger)
- [ ] **`code_edges_chunk` (resolved) + `code_edges_symbol` (unresolved)**
  (high) — structural call graph; pairs with `resolve_symbol_edges`.
- [ ] **Language coverage** (high) — 3 → many (grammar WASMs + per-language
  symbol-type config); **symbol hierarchy** (nested method chunks) + **per-
  language edge config**.

### Durable jobs (in-scope subset of P3)
- [ ] Multi-process supervisor + PID-file lock + crash-restart (high);
  wedge detection + queue-health (medium); lock-renewal heartbeat for long
  jobs (medium); rate-lease concurrency gates (high); job audit JSONL (medium).

### Enrichment (LLM-free subset)
- [ ] Typed-NER link inference from context windows (gazetteer + pack regex)
  (high); schema-pack link-type inference rules (high); ReDoS-guarded regex
  for user packs (medium); completeness scoring rubrics (medium).

### TODO — agent-layer (DEFERRED, north-star-gated, NOT planned)
The agent/LLM/auth/voice half. Recorded for completeness; out of brain-only
scope unless the operator opens the gate.
- **Auth/tenancy:** OAuth 2.1 scope hierarchy; `source_id` multi-tenancy on
  pages/links + RLS; request-scoped auth context; per-token source
  allow-list; token→client lookup. (This is the reference's equivalent of
  our public-bearer+redaction model — our intentional difference.)
- **Agent loop:** think (LLM synthesis) CLI; dream-cycle orchestration;
  brainstorm; recall/forget hot-memory; anomalies.
- **LLM enrichment:** fact extraction from conversation turns; fact dedup
  classifier (cosine + LLM); conversation parser; ingestion event daemon.
- **Cycle (LLM/heavy):** lint `--fix`, backlinks-materialize, filesystem→DB
  sync phases; budget reservation + spend-tracking; job attachments.
- **Eval (LLM-judge):** contradiction judge; takes-quality panel; eval-compare
  significance testing; JSON-repair for judge output; LongMemEval harness.
- **Ops (agent):** quarantine + content-flag; destructive-guard soft-delete;
  RemediationStep framework; remote doctor; `doctor --remediate`.
- **Chunkers (LLM/deep):** receiver-type resolution for call edges; two-pass
  edge disambiguation; LLM-guided chunking fallback.
- **Schema (agent):** multimodal/image embedding columns; file attachments +
  ledger; eval/calibration/dream-verdict tables.
- **mcp (agent):** request audit log; source-isolation scoping; `_meta`
  hot-memory injection hook.

### Parity OK (faithful, no action)
Page generation clock; JSON-RPC error wrapping; per-query result deltas;
eval-candidates capture; multi-source entity-typing guards (n/a single-source).

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

## Schema / migration scale (deferred)

- **`CREATE INDEX` in migrations is non-`CONCURRENTLY` and the runner wraps
  each migration in one transaction.** `CONCURRENTLY` cannot run inside a
  transaction block, so index-creating migrations (e.g. 027
  `chunks_symbol_name_idx`) take a brief `SHARE` lock blocking writes for
  the build. Negligible at current scale (~1.3k chunks) and bounded by the
  v1.3.2 `lock_timeout`, but a large future `chunks`/`documents` table would
  stall indexing during the build. When that bites, split index creation
  out of the transactional runner into a separate `CONCURRENTLY` path (it
  must run outside a tx and handle the INVALID-index-on-failure case).
  Surfaced by the P1 chunk-symbol-metadata (migration 027) review.

## Cleanup (deferred)

- **Drop the now-unused `chunks.ts` generated column + `chunks_ts_idx`.**
  Migration 030 moved the keyword read path onto `search_vector`; the old `ts`
  column (migration 001, `to_tsvector('simple', content)` STORED GENERATED) is
  no longer read for ranking, but is left in place because dropping a generated
  column forces a table rewrite. Before dropping, grep `src/` for `\bts\b` /
  `chunks_ts` to confirm no diagnostic still references it (e.g. `doctor`,
  `snapshot`, eval), then drop the column + its GIN index in a single migration
  during a quiet window. Flagged by the v1.3.26 code-review.

## Defence-in-depth hardening (deferred)

- **`storage.init()` is called OUTSIDE the `try`/`finally` in most command
  handlers** (`commands/jobs.ts`, `sources.ts`, and siblings follow the same
  shape). If `init()` throws (failed migration/connect) the `finally`'s
  `storage.close()` never runs → a leaked engine/pool. `commands/cache.ts`
  (v1.3.12) moved `init()` INSIDE the try as the correct pattern; the
  pre-existing handlers should be swept to match. LOW (init failure is rare +
  the process usually exits anyway). Flagged by the v1.3.12 codex review.

- **`links.source_chunk_id` is non-sticky on a bare re-add** (`core/links.ts`
  `addLink`). Migration 029 made the new provenance columns sticky
  (`COALESCE`/`CASE` preserve prior values when a bare `link` re-call omits
  them), but `source_chunk_id` keeps its original 016 last-writer-wins
  behavior — an explicit re-`link` that omits it nulls it. Harmless today (the
  explicit `link` MCP tool callers don't set it, and only enrichment writes
  it). IF a future enrichment pass writes `source_chunk_id` AND an explicit
  re-link can follow, give it the same `COALESCE(EXCLUDED.x, links.x)`
  treatment for consistency. Flagged by the v1.3.9 code-review; left as
  pre-existing intentional semantics, not changed in that increment.

- **`publicSafeErrorMessage` logs the raw detail via `console.error`.** Fine
  for an on-host operator log, but the suppressed detail is a single
  `.message` line that could contain CRLF (cosmetic log-line splitting) or a
  Postgres error embedding a column value (PII). If the EC2 logs are ever
  forwarded off-host (CloudWatch shipping, log aggregation), strip CRLF and
  consider redacting the detail before logging. LOW; surfaced by the
  2026-06-09 fix review.

- **Public read existence-oracle on `page_get` / `jobs_get` /
  `page_versions`.** On a public-ingress miss these return `isError:true`
  echoing the slug/id, while a hit returns `ok:true` — so a public-bearer
  caller can probe-enumerate which slugs exist even with all bodies
  redacted (entity facts/timeline/recall already return a uniform empty
  shape). Rated LOW, not fixed: slugs are operator-chosen and *already
  public* across the surface (`search`/`backlinks`/`graph` all return
  paths), so the marginal leak is small, and changing a read tool's
  public-miss shape to uniform `{ok:true, …:null}` is an API-semantics
  change the operator's own single-holder client may rely on. If we ever
  tighten to a strict metadata-only posture, make public misses uniform
  (no slug echo, no `isError`). Surfaced by the 2026-06-09 security-engineer
  + bug-hunter audit.

- **`graph_neighbors` / `graph_query` relationship dump — OPERATOR
  DECISION NEEDED.** These two read tools dispatch with NO `redact` flag,
  so on public ingress they return raw `source_slug`/`target_slug` pairs —
  a public-bearer caller can pull the full edge graph (e.g. every
  `people/*` linked to `companies/acme` via `works_at`). The 2026-06-05
  decision deliberately kept the *edge `type`* public (constrained enum,
  single-holder daily-rotated bearer, slugs already public) — but that
  rationale was about individual slugs, NOT relationship dumps, which leak
  *who-relates-to-whom* at scale. Decide: (a) accept as consistent with the
  slugs-are-public posture, or (b) gate `graph_*` behind the internal token
  / redact slugs on public. Flagged by the 2026-06-09 bug-hunter audit.

- **Any future document-delete / prune path MUST bump
  `document_generation_clock`.** The live-model cache clock (migration 025)
  is bumped on document *writes* in `writeDocumentTransaction`. Today
  nothing hard-deletes a `documents` row (the sweep only adds/updates), so
  there is no staleness gap. But when a prune/GC path lands, it must call
  `bumpDocumentClock(tx)` in the same transaction — otherwise a query cache
  built on this clock would serve results referencing deleted chunks. Add a
  regression test alongside that path. Flagged by the migration-025 review.

- **Search `token_budget`: token estimate is `chars/4`, not a real
  tokenizer.** Good enough for a context cap, but a multibyte/CJK-heavy or
  code-heavy corpus will over- or under-count. The word-boundary truncation
  can also drop up to ~40% of the overflowing tail hit (the cut lands at the
  last whitespace past 60% of the limit). Acceptable today; revisit with a
  real tokenizer if budgets get tight. The trimmed hit is flagged
  `truncated: true` so callers can detect the cut. Surfaced by the P2
  token-budget review.


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

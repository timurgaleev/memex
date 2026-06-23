# TODO — memex-stack

Forward-looking work that is intentionally deferred. Items already
shipped live in [`CHANGELOG.md`](./CHANGELOG.md); items rejected as
out-of-scope live under "NOT in scope" in the design doc that
introduces them.

---

## Deferred — full-parity follow-ups (2026-06-23)

> NOTE: the "brain-only" north-star elsewhere in this file is **superseded** as
> of 2026-06-23 — the operator opted into full reference parity. LLM synthesis,
> code-graph, push-context, advisor, and an OAuth app-layer all shipped
> (v1.10.0–v1.16.0). These are the remaining pieces, deferred because they need
> infra/provider decisions, not because they're out of scope.

- [ ] **Brain federation** (deferred — operator, 2026-06-23). A network of
  memex brains (multi-source / multi-holder), likely on Supabase or a similar
  backend. Needs a per-source/per-user data model (memex is single-holder today
  — no `user_id` on documents/pages), cross-brain read grants, and an infra
  story. A *separate project*, not an increment — start with a design doc
  (tenancy + sync/clock + auth) before any code.
- [ ] **Embedding 1024→1536** (deferred). Larger vectors for slightly better
  recall, but requires moving off Amazon Bedrock Titan v2 (1024-dim) to a
  1536-dim provider + a full corpus re-embed + an `embeddings` column migration.
  Provider choice is the operator's.
- [ ] **Enable OAuth in production** (operator action — code shipped default-OFF
  in v1.16.0). Before flipping `auth.oauth.enabled`: (a) terraform public ingress
  (ALB/SG/TLS + JWKS egress) via the ops dir; (b) decide tenancy (today every
  validated token maps to the one shared redacted scope); (c) pick an IdP + fill
  `auth.oauth`; (d) add a negative / per-IP cache to the JWKS fetch.

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
- [x] **Slug-based page-type inference** (enrichment, high) — DONE.
  `inferPageType(slug)` (pages.ts) maps the slug's first segment to a type
  (people/→person, companies/→company, meetings/→meeting, …). `putPage` now
  infers `type` when omitted (an explicit type always wins; unknown prefix →
  `note`), and `page_put`'s `type` param is optional (snapshot regenerated).
  Consumer is the v1.3.41 gazetteer (`type IN person/company`) — earlier
  "no consumer / dropped" note is now stale. Migration-free, backward-compatible.
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
- [x] **BaseCyclePhase + warn-state result envelope** (cycle, medium) — DONE
  (the warn-envelope half; the base-CLASS half intentionally NOT adopted).
  `PhaseResult`/`CycleResult` gain `status: "ok"|"warn"|"fail"` alongside the
  unchanged `ok` (back-compat — a warn is still `ok:true` and doesn't fail the
  cycle). `deriveStatus(phase, detail)` (cycle/index.ts) computes warn from
  explicit per-phase rules (embed-stale per-chunk errors, snapshot non-persist);
  reconcile-links `unresolved` + orphans-purge `flagged` are by-design
  informational → stay `ok`. runPhase emits a `warn`-level progress log; the
  `cycle` recipe renders `status=ok|warn|FAIL`. ADAPTED, not blind-ported: memex's
  6 phases are functional fns wrapped by `runPhase`, which ALREADY gives the
  uniform error handling + source-scope the reference's base class provides — a
  class refactor would be churn against "don't refactor what isn't broken", so
  only the observability kernel landed.
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
- [x] **Structured OperationContext** (mcp, medium) — ASSESSED → not built
  (cosmetic-parity churn, no ad-hoc duplication to centralize). memex's
  operation context is ALREADY centralized in two clean seams: `http/public_guard.ts`
  derives `isPublic` from the request (auth/ingress) once, and `mcp/dispatch.ts`
  derives the `redact`/`redactGraph` policy from `isPublic` once at the dispatch
  entry, passing the booleans down. The reference's `buildOperationContext()`
  exists to carry multi-source scoping + OAuth auth-tiers + budgets + source
  allow-lists — none of which memex has (single-source, single-holder bearer).
  Wrapping memex's one `isPublic` bit in a formal context OBJECT would be
  ceremony with zero functional benefit, against "don't refactor what isn't
  broken". Revisit only if a real second context dimension (tenancy/auth-tier)
  ever lands.
- [x] **Qrels format** (eval, medium) — DONE/moot. The adapter's only stated
  trigger is "before reusing reference qrels" — which won't happen (the
  reference's qrels are its private eval corpus; not importable). memex's own
  `tests/eval/qrels.json` is `expected_paths`-centric, which MATCHES memex's
  path-keyed chunk search output (`eval.ts` compares `expected_paths` to
  `topPaths`). Pages are slug-canonical but search returns chunk PATHS, so a
  slug-centric rewrite would add an impedance mismatch, not remove one. No
  consumer → not built (would be speculative).
- [x] **`link_kind` UNIQUE-coexistence** (enrichment, medium) — ASSESSED → MOOT
  (2026-06-13). See the full disposition under the "2026-06-13 EXHAUSTIVE
  re-comparison" section above. Short version: the NER-link increment (v1.3.46
  typed-links) already resolved the collision by YIELDING (`ON CONFLICT … DO
  NOTHING`), and plain vs typed_ner edges use non-overlapping `type` vocabularies
  so they already coexist under the current key. Widening would break the
  reviewed yield design, duplicate explicit edges, and need unbuilt graph-read
  dedup — churn for zero gain.

### Integrate now (brain-only, safe, in-scope) — prioritized

#### From the 2026-06-13 EXHAUSTIVE reference re-comparison (5-agent subsystem fan-out vs `4ee530f v0.42.42.0`)
A full subsystem-by-subsystem diff (schema/chunkers/embeddings · retrieval/ranking/eval
· MCP/CLI/jobs/config · facts/links/graph · cycle/security/redaction). Security
swept clean — **no redaction-parity gap, no CRITICAL**: memex has a single public
ingress (`dispatchTool`), allowlist field redaction, and is strictly stronger than
the reference (which relies on OAuth scopes, not field redaction). The genuine
brain-only LLM-free BUILD candidates found, prioritized:
- [x] **Fact confidence decay + `valid_until` expiry at recall** (highest value) —
  DONE. The mig037 `kind`/`valid_from`/`valid_until` columns were stored but
  inert (zero readers). `core/facts-decay.ts` `effectiveConfidence` + the
  `listFacts`/`entityRecall` `decay` path consume them (opt-in `MEMEX_FACT_DECAY`,
  default OFF). Adapted to memex: nullable DATE columns, no `expired_at`,
  written_at anchor fallback, env-gated not default-on.
- [x] **`link_kind` UNIQUE coexistence** — ASSESSED → MOOT (no widening shipped;
  it would be both unnecessary and harmful). Evidence: (1) the plain and typed_ner
  writers use NON-OVERLAPPING `type` vocabularies — plain edges are
  `type ∈ {wikilink, mentions}` (`links.ts:480`, `gazetteer.ts:261`), typed_ner
  edges are `type ∈ {works_at, attended, founded, knows, …}` (`typed-links.ts`),
  so a plain mention and a typed-NER edge of the SAME (src,tgt,type) essentially
  never occur — they ALREADY coexist under the current key (different type =
  different key). (2) The only same-(src,tgt,type) overlap is an explicit `link`
  (link_kind NULL) vs an inferred typed_ner of that type, and there the current
  `ON CONFLICT … DO NOTHING` YIELD is CORRECT (`typed-links.ts:173-174`: explicit
  operator assertion wins over inference) — coexistence would wrongly duplicate
  an operator-asserted edge. (3) v1.3.46 deliberately shipped this single-edge
  yield design (reviewed). (4) Real coexistence would additionally require
  graph-read precedence/dedup (`graph_neighbors`/`graph_query` don't dedup by
  provenance) — a larger model change, not a standalone UNIQUE widening. So the
  collision the item worried about is already resolved by yield, with no live
  data loss. A drop-and-recreate of the UNIQUE on the populated `links` table for
  zero behavioral gain is exactly the churn "don't refactor what isn't broken"
  warns against.
- [x] **Markdown chunk overlap** (recall lift) — DONE (opt-in
  `MEMEX_CHUNK_OVERLAP`, default OFF). `recursive.ts` prepends the previous
  chunk's tail (sentence/word-snapped, capped at maxChars/2) to each size-split
  continuation, applied AFTER mergeShort over the final list + heading-start skip
  so it changes chunk content not count and never bridges a section boundary.
  Adapted to memex (char-bounded, no tokenizer): the reference's 5-level
  delimiter cascade + CJK word-counting NOT ported (CJK = no live non-Latin
  corpus; the cascade is a token-aware refinement memex's char-greedy splitter
  doesn't need). codex caught the before-mergeShort count-shift; fixed.
- [x] **Graph-signals post-fusion stage** — ASSESSED → DOCUMENT-DEFER (evidence).
  The three reference signals map onto memex as: (a) **session-cluster
  diversification (~0.95x MMR-lite) = REDUNDANT** — memex already applies
  per-document dedup `maxPerDoc:1` (`search/hybrid.ts:414`), a HARD one-chunk-
  per-document cap that's strictly stronger than a 0.95x demote; (b)
  **cross-source boost = DORMANT** — memex is single-source, the reference itself
  notes this signal is "dormant on single-source brains"; (c) **adjacency-hub
  boost = structurally dormant on memex's data** — it operates on the page-link
  graph, but the live brain is 347 documents / ~2 pages, search runs over
  `documents`/`chunks` not `pages`, so the page graph is ~2 nodes and the boost
  would touch a negligible fraction of hits with no way to validate. (Note found
  en route: the search-time `salienceMultiplier` reads only frontmatter
  `pinned`/`weight`, NOT the mig036 link-degree salience column — but wiring that
  in is equally page-scoped, same dormancy.) Building 400+ lines of RRF-score-mult
  + floor-gate + adjacency SQL for a ~2-node graph is premature infra against
  "perform only the necessary work."
- [x] **Jobs `timeout_ms` / dead-letter** (robustness) — DONE (migration 039,
  v1.3.52). A wedged handler held the single worker's only in-flight slot forever
  (stall sweep recovers a dead WORKER, not a hung HANDLER). Nullable
  `jobs.timeout_ms` (via `Queue.enqueue` / `submitJob` / `jobs_submit`) + a
  worker default (`MEMEX_JOB_TIMEOUT_MS`, OFF by default) race the handler; on
  exceed it dead-letters (terminal, no retry, `FailOptions.terminal`) and frees
  the worker, extending the claim lock (`extendLock`) so the stall sweep can't
  requeue it first. `runJob` fully guarded. codex caught the unwired submit path
  + lock-vs-timeout race + an unhandled-rejection path; all fixed.
- [x] **Relational recall arm** — DOCUMENT-DEFER (structurally dormant). It would
  parse "who invested in X" and inject typed-edge candidates as a 4th RRF arm,
  but the graph it ranks is ~0 typed edges on the live brain (typed-links is
  opt-in default-OFF; ~2 pages / 347 documents). It also needs a relational-intent
  parser + fusion plumbing. memex already exposes the graph via `entity_recall` /
  `graph_neighbors` (the agent calls them explicitly). Building a 4th arm over an
  empty graph is premature; revisit if the brain grows a real typed-edge graph.
- [x] **`symbol_name_qualified` column + qualified-name FTS weight** —
  DOCUMENT-DEFER (dormant). It disambiguates `Foo.bar` vs `Baz.bar` in CODE
  search, and the FTS weight only matters with code chunks — the live corpus has
  ~0 code chunks (markdown brain). The mig-030 trigger comment already records
  "memex has neither column yet" as a deliberate deferral. Cheap to add but with
  no validatable value on the current data; revisit when a code-heavy corpus lands.
- [x] **Jobs lease fencing token** — DOCUMENT-DEFER (nil value at concurrency=1).
  A per-attempt `lock_token` guards against a revived stalled worker clobbering a
  row reclaimed by ANOTHER worker — a multi-worker race. memex's serve runs a
  SINGLE worker (`serve.ts`, concurrency 1), so there is no second worker to race;
  the `status='running'` write guards + the v1.3.52 timeout/extendLock already
  close the wedge hole. Add together with a multi-worker scale-out if one ever
  lands.

Dispositioned LOW / out-of-scope: CJK-aware chunking (English corpus), contextual-
retrieval embed wrapper (needs an LLM pass — north-star), backoff jitter
(multi-worker only — MOOT by design), multimodal/image embeddings + 36-language
tree-sitter (asset-blocked), OAuth/multi-tenant/access_tokens + LLM cycle phases
(synthesize/extract/grade/emotional-weight — north-star).

#### From the 2026-06-12 NIGHT reference re-comparison (reference advanced v0.42.37 → v0.42.42)
Fetched the clone to `4ee530f v0.42.42.0` and diffed. Conclusion: **NO new
brain-only LLM-free candidate for memex** — every advance is already-done, N/A
to memex's architecture, or north-star:
- `v0.42.40` well-form lone UTF-16 surrogates → ALREADY DONE (memex v1.3.34).
- `v0.42.41` triage-wave: `venv/` skip in the code walker → ALREADY DONE
  (`sweep-code.ts` skips `.venv`/`venv`/`__pycache__`); OAuth authorize-scope
  default + legacy-token-scope → N/A (no OAuth, public-bearer model); AI-SDK
  asymmetric `input_type` on the wire → N/A (memex embeds via Bedrock Titan v2,
  symmetric, no AI-SDK adapter); **config `DATABASE_URL` cwd-`.env` hijack →
  N/A** (the reference's hijack is the GENERIC `DATABASE_URL` that any web-app
  `.env` sets; memex reads ONLY the namespaced `MEMEX_POSTGRES_URL`, which a
  random checkout's `.env` never contains, and the container `/app` has no cwd
  `.env` — verified). timeline-dedup-repair / extract-facts → LLM/north-star.
- `v0.42.42` CLI bounded-teardown for txn-mode poolers → infra N/A (memex's
  serve/CLI lifecycle differs; not a pooler-teardown shape).
- `v0.42.39` Retrieval Reflex (teach the agent when/what to retrieve) →
  AGENT-LAYER north-star (the agent is the MCP client), out of brain-only scope.
- `v0.42.37` jobs stale-lock reap → infra N/A (assessed earlier).

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
- [x] **Contract-derived `validateParams(op, params)`** (mcp, high) — DONE
  (duplicate of the shipped item above; `validateParams` is wired as a
  pre-dispatch check in dispatch.ts:140 and enforces type/enum/min-max).
- [x] **`OperationError {error,message,suggestion?,docs?}`** (mcp, med) — DONE
  (duplicate of the shipped `OperationError shape` item above —
  `core/operation-error.ts` + `toEnvelope`, public message-drop).
- [x] **Facts-fence parser/renderer** (cycle, med, LLM-free) — DONE.
  `core/facts-fence.ts` (parse/render/strip) + `core/fence-shared.ts` (generic
  table-row primitives, faithful port). `| # | claim | confidence | source |`,
  strikethrough=inactive, memex-namespaced markers. Pure, INERT until
  `extract_facts`. Adapted to memex's simpler fact model (entity_facts);
  reference's kind/visibility/notability/typed-claim columns NOT ported. Escape
  pair is a true round-trip inverse (char-scanner split + backslash escape;
  code-reviewer caught the trailing-backslash gap → fixed). code-reviewer CLEAN.

- [x] **Graph read redaction on public** (high) — DONE (verified 2026-06-12).
  `redactGraphLinks` (public_redaction.ts) strips `confidence` /
  `source_chunk_id` / `written_at` on the public bearer, keeping slugs+type;
  wired in dispatch for `graph_neighbors`/`graph_query`. The stale "SHIPPING
  THIS INCREMENT" note predated the actual ship.
- [x] **Chunk weighted FTS** (high) — DONE (migration 030; see the weighted
  `search_vector` item above). Weight A = `symbol_name` + `parent_symbol_path`,
  B = chunk text; `doc_comment`/`symbol_name_qualified` fold in when added.
- [ ] **`symbol_name_qualified` column** (high) — stable edge-resolution key;
  extend migration 027, weight A in FTS.
- [x] **doc_comment chunk column** (medium) — DONE (migration 032). The code
  chunker (`core/chunkers/code.ts`) extracts a symbol's doc comment — JSDoc/`//`
  block above a JS/TS symbol (climbs `export` wrappers + leading decorators,
  rejects trailing comments + file-level license headers) or a Python docstring
  (rejects f-strings) — into `chunks.doc_comment`, folded into the migration-030
  weighted-FTS trigger at weight A. NULL/markdown-safe; 2000-char cap; config
  stays `simple`. ai-engineer + code-reviewer + codex reviewed (codex caught
  decorated-method/trailing-comment/f-string extraction bugs → all fixed).
  Follow-up (LOW, deferred): Python adjacent-literal docstrings (`"a" "b"` parse
  as `concatenated_string`, not `string`) are missed — null-safe, rare; add if
  a corpus needs it.
- [x] **Entity slug canonicalization** (high) — DONE (migration 033).
  `core/slug-canonicalize.ts` resolves a `[[wikilink]]` mention to an
  existing canonical page slug before the edge is written
  (`[[Alice Smith]]` → `people/alice-smith`). 5-stage confidence-ordered
  cascade: exact slug → unique exact-tail (namespaced basename) → unique
  prefix expansion → pg_trgm `similarity()` fuzzy (threshold + runner-up
  margin) → slugify floor. Edges stamped `resolution_type`
  qualified/unqualified (mig-029 cols) + `link_kind='plain'`. Wired into
  `syncWikilinksForPage`. ADAPTED, not blind-ported: the reference earned
  safety from source-scoping + dir/page-type hints memex's single flat
  vault lacks, so (a) fuzzy runs LAST not 2nd, (b) tail/prefix resolve only
  on a UNIQUE match — ambiguity falls to the slugify floor, never silently
  arbitrated, (c) threshold raised 0.55→0.7 + margin gate, (d)
  **connection_count tie-breaking REJECTED** (ai-engineer: rich-get-richer
  bias; a wrong `qualified` edge would compound across future resolutions).
  Default-on; `MEMEX_WIKILINK_CANONICALIZE=0` kill switch +
  `MEMEX_WIKILINK_TRGM` override. ai-engineer (2 HIGH on ordering/threshold,
  both fixed by the redesign) + code-reviewer (CLEAN) + codex (self-resolve
  contract leak + unnamespaced-prefix sprawl, both fixed). Dormant on live
  edges until a page is re-synced.
- [x] **Gazetteer auto-link mentions** (high) — DONE (opt-in, default OFF).
  `core/gazetteer.ts`: `buildGazetteer` (person/company titles + aliases,
  excl. self, ambiguity-drop), `scanMentions` (maximal-munch longest-first,
  unicode word boundaries, wikilink-span masking, first-mention dedup,
  proper-noun capitalization heuristic), `syncMentionsForPage` (replaces only
  `link_kind='plain'` mentions, `ON CONFLICT DO NOTHING` so an explicit edge
  is never clobbered). Wired into put_page / page_append after the wikilink
  sync. **DEFAULT OFF** (`MEMEX_GAZETTEER=1`): false-positive sensitive +
  memex's flat vault has no scoping to contain a bad single-token match, so
  unlike the reference (default-on) it is opt-in until the operator confirms
  behavior on their vault. security-engineer (no Crit/High/Med) + ai-engineer
  (proper-noun heuristic + unicode boundaries + maximal-munch test) + codex.
  NOTE: single-token sentence-start common words remain an inherent NER
  ambiguity bounded by the stop-list + default-OFF; the typed-NER / schema-pack
  inference layer (below) is the richer follow-on.
- [x] **Slug/page alias resolution** (medium) — DONE (migration 034), the
  `page_aliases` half. A page declares alt names in `compiled_truth.aliases`;
  `core/page-aliases.ts` (`normalizeAlias`/`extractAliasNorms`/`setPageAliases`/
  `resolveAliasUnique`) keeps a normalized `page_aliases` index in lockstep
  with every `putPage` (replace-set inside the write tx; FK cascade on hard
  delete; soft-delete filtered + auto-restored). The slug canonicalizer gains
  an authoritative **alias** stage (after exact-slug, before fuzzy). Collision
  -safe (unique-only, falls through), fails open pre-034. code-reviewer +
  codex CLEAN. The `slug_aliases` half (old-slug→canonical on RENAME) is NOT
  built: memex has no page-rename operation (put creates / delete soft-removes;
  a slug never changes), so the table would have no writer. Add it together
  with a rename op if one ever lands.
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
- [x] **Enum/array param validation** (medium) — DONE/moot. The `enum` half
  already ships: `paramDefToSchema` emits `enum` and `validateParams`
  (operations.ts:140) rejects a non-member before dispatch. The `array`/`items`
  half has NO consumer — no operation declares an array param and no handler
  reads an array arg (the contract's `ParamType` is `string|integer|number|
  boolean|object` by deliberate design; arrays are the documented escape hatch,
  hand-written in tool_defs.ts). Adding `items` support would be speculative
  dead code, so it is intentionally not built until a real array param lands.
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
- [x] **extract_facts** (high, LLM-FREE) — DONE (migration 035). The `## Facts`
  fence is now the system of record: `core/facts-reconcile.ts`
  `reconcileFactsForPage` projects a page's fence into `entity_facts` on every
  put (re-read + content_hash guard + repair-on-reput), wipe scoped to the new
  `source_markdown_slug` column (legacy/explicit facts survive), malformed-fence
  protection, row_num clamp + row cap, `purgeFenceFactsForPage` on delete, fence
  stripped before chunk-indexing. Default-on, `MEMEX_FACTS_FENCE=0` kill switch.
  code-reviewer (no blockers) + codex (2 HIGH + 5 MEDIUM, all fixed). The
  OPTIONAL fact-text embedding (reference's find_trajectory enrichment, falls
  open) is a deferred follow-on; recompute_emotional_weight (page salience
  [0..1]) is a SEPARATE deferred item below. Original deferred design note: [done] CONSULTED THE REFERENCE: its extract_facts is NOT
  LLM — the `## Facts` fence is the SOURCE OF TRUTH and the phase deterministically
  reconciles the DB index from it (the only AI call is an OPTIONAL embed of the
  fact text that falls open if the gateway is down). Best-practice contract to
  adapt: per affected page → read body → `parseFactsFence` (already in memex,
  `core/facts-fence.ts`) → wipe that page's fence-owned DB facts → re-insert from
  the fence; after the phase the DB byte-matches the fence. Empty-fence guard:
  refuse the destructive pass while legacy pre-fence rows still exist (return
  `warn`, not a silent wipe). NEEDS **migration 035**: memex's `entity_facts`
  (mig 018) has `entity_slug/fact/confidence/source_slug/source_chunk_id/written_by`
  but NOT the fence-reconciliation keys — add `source_markdown_slug` (the page
  hosting the fence, to scope the wipe) + `row_num` (the fence row) so a
  wipe-by-source_markdown_slug + re-insert-by-row_num is possible without
  clobbering legacy/explicit facts. Wire as a `reconcile-facts` cycle phase
  (between extract + the new warn-envelope makes partial reconcile a `warn`).
  Optional: embed fact text via memex's existing Bedrock Titan path (defer —
  falls-open like the reference). recompute_emotional_weight (page salience
  [0..1] from tags/takes) is a SEPARATE follow-on, also LLM-free.
- [x] **Page salience (recompute_emotional_weight equivalent)** (high) — DONE
  (migration 036). `pages.salience` REAL [0..1] recomputed by the new
  `recompute-salience` cycle phase. `computeSalience` (`core/salience-score.ts`)
  = high-emotion-tag boost (max 0.5, configurable seed set via
  `MEMEX_SALIENCE_HIGH_TAGS`) + ln-scaled link-degree boost (max 0.5, saturating
  at degree 20). ADAPTED faithfully: the reference scores tags + "takes"; this
  brain has no takes, so link-degree (distinct in+out neighbours GATED to
  EXISTING live pages — no dangling-target inflation) replaces the takes half.
  Consumer = read-only `memex salience [--type T] [--days N] [--limit N]` ("what
  matters" surface), separate from document hybrid-search ranking (phase does
  NOT touch the doc query-cache generation/clock). ai-engineer + code-reviewer +
  codex: float4-exactness (Math.fround), batched UPDATE, bare-flag rejection,
  tag-trim, dangling-gate (reviewers split — chose inflation-safety). A
  `recent_salience` MCP op is a deferred follow-on (public surface).
- [~] **resolve_symbol_edges cycle phase** (medium) — MOOT, see the code-graph
  assessment below: memex resolves code-edge symbols→chunks at QUERY time
  (commands/code.ts code-def join), so a batch pre-resolution phase is a cache
  for a corpus that doesn't yet need one (~0 live code chunks).
- [ ] **Per-handler timeout_ms + deterministic stagger** (medium) — wall-clock
  cap per job; FNV-1a offset to decorrelate cron jobs. (The code-chunk half of
  this bundle is done below; the cron-job stagger half remains — it belongs with
  the durable-jobs supervisor work.)
- [x] **Code-chunk wall-clock timeout** (low) — DONE. `parseWithBudget`
  (`core/chunkers/parsers.ts`) runs every code parse under a wall-clock budget
  via tree-sitter's `progressCallback` (returning truthy from the periodic
  callback cancels the sync WASM parse → null → chunkCode throws → sweep-code
  skips the file). Default 5s, `MEMEX_PARSE_TIMEOUT_MS` override (0 disables).
  ADAPTED: the reference's `setTimeoutMicros` mis-marshals its i64 arg under
  Bun's WASM bridge (ToBigInt error), so the progress callback — the modern
  documented replacement — is used instead. Cancel verified by a unit test.

### Facts model (in-scope, larger)
- [x] **facts-fence markdown binding** (high) — DONE (v1.3.42, migration 035).
  The `## Facts` fence is the system of record; `core/facts-reconcile.ts`
  parses/strips it and re-projects entity_facts on every put (scoped by
  `source_markdown_slug`/`row_num`). See the v1.3.42 + v1.3.45 changelog.
- [x] **Fact-text embedding** (high) — DONE (v1.3.48, migration 038). Nullable
  `vector(1024)` `embedding` on entity_facts; `embed-facts` cycle phase
  backfills via Bedrock Titan (falls-open, injectable). `entity_recall` gains an
  optional `query` param that ranks the entity's facts by cosine similarity
  (`embedding <=> queryvec`, embedded-first via NULLS LAST, confidence
  tiebreak), falls-open to confidence order. No ANN index (per-entity exact
  scan). security-engineer SHIP (allowlist redaction drops the column; rate
  bucket bounds Bedrock cost) + ai-engineer + codex.
- [x] **Fact metadata** (high) — DONE (migration 037). `entity_facts` gains 4
  NULLABLE columns — `kind` (event/preference/commitment/belief/fact), `notability`
  (high/medium/low), `valid_from`, `valid_until` (DATE) — carried by the `## Facts`
  fence and projected by the reconcile pass. The fence PARSER was rewritten from
  fixed-position to HEADER-DRIVEN column mapping (`buildColMap` + `isHeaderShaped`),
  so a legacy 4-column fence and a wide one parse with the same code and columns
  may be reordered. Hand-edited cells normalize to NULL when not a recognized
  enum / strict-ISO date (`normalizeKind/Notability/Date`, round-trip calendar
- [x] **Fact metadata** (high) — DONE (migration 037). `entity_facts` gains 4
  NULLABLE columns — `kind` (event/preference/commitment/belief/fact), `notability`
  (high/medium/low), `valid_from`, `valid_until` (DATE) — carried by the `## Facts`
  fence and projected by the reconcile pass. The fence PARSER was rewritten from
  fixed-position to HEADER-DRIVEN column mapping (`buildColMap` + `isHeaderShaped`),
  so a legacy 4-column fence and a wide one parse with the same code and columns
  may be reordered. Hand-edited cells normalize to NULL when not a recognized
  enum / strict-ISO date (`normalizeKind/Notability/Date`, round-trip calendar
  guard); CHECK constraints mirror the enums as defense-in-depth (NULL allowed).
  NO `valid_until >= valid_from` CHECK by design (degrade-gracefully). RECALL
  RANKING by notability/validity is the deferred consumer (the projection
  pipeline is the deliverable here). code-reviewer (HIGH claim-literally-"claim"
  header-absorption → fixed via header-shape guard) + security-engineer (CLEAN —
  params safe, normalizeDate airtight, no ReDoS, bounded) + codex.
  (`visibility` still omitted — single-holder model; add only with a
  multi-visibility model. Typed-claim metric/value/unit fields also omitted.)
- [x] **Timeline extraction from meetings** (medium, LLM-free) — DONE (v1.3.47,
  opt-in `MEMEX_MEETING_TIMELINE=1`). `core/timeline-meetings.ts` +
  `extract-timeline` cycle phase: each `meeting` page with a resolvable date
  writes append-only `timeline_events` for the meeting + each resolved attendee
  (`Attended <title>`). Self-contained (reads `attendees`/`attended_by`
  frontmatter directly — no dependency on the opt-in typed-link `attended`
  edges), date heuristic (compiled_truth.date -> slug-date -> first body
  date-mention -> skip), attendees resolved PRECISE-stages-only + resolved-only.
  Migration-free (reuses `timeline_events` mig 017). **Dedup key**: memex's
  `timeline_events` dedups on `(slug, occurred_at, source_chunk_id)` with
  `source_chunk_id='meeting-timeline:<slug>'` — covers the reference's
  `(page_id, date, summary, source)` intent (slug=page, occurred_at=date, the
  source key carries summary+source). Append-only: a removed attendee leaves a
  stale event (by-design timeline immutability), which is why it is opt-in.

### Schema / code-graph (in-scope, larger)
- [~] **`code_edges_chunk` (resolved) + `code_edges_symbol` (unresolved)** +
  **resolve_symbol_edges** (high) — ASSESSED 2026-06-13: **MOOT for memex as a
  dedicated-table re-model.** memex ALREADY has a working call graph via the
  entity-mention model: `extractCodeEntities` (core/code-entities.ts) extracts
  `call_expression`-derived `code-caller`/`code-callee`/`code-ref` entity
  mentions at INDEX time (the reference's "unresolved code_edges_symbol"
  equivalent), and `code-callers`/`code-callees`/`code-refs`
  (commands/code.ts) RESOLVE name→defining-chunk at QUERY time by joining
  `chunks → entity_mentions → entities` through the `code-def` entity (the
  reference's "resolved code_edges_chunk" equivalent, computed lazily). So the
  capability EXISTS; the only delta is the reference PERSISTS resolved edges in
  a table (and pre-resolves via a `resolve_symbol_edges` phase) vs memex
  resolving at query time. For a markdown-dominant corpus (live brain has ~0
  code chunks) that delta is premature optimization, and persisting a parallel
  edge table would duplicate/refactor working code ("don't refactor what isn't
  broken"). REVISIT only if a code-heavy corpus makes query-time resolution a
  measured bottleneck — then persist resolved edges as a cache, don't re-model.
- [ ] **Language coverage** — DEFERRED (assessed 2026-06-13). Requires shipping
  new tree-sitter grammar **WASM binaries** (build artifacts) into `wasm/` +
  per-grammar node-type config; the LIVE corpus is markdown-dominant (~0 code
  chunks) so more code languages add ~0 immediate retrieval value. The
  symbol-hierarchy half already shipped (parent_symbol_path TEXT[], mig 028).
  Revisit when a code-heavy source is indexed.

### Durable jobs (in-scope subset of P3)
- [~] Durable-jobs supervisor — ASSESSED 2026-06-13: **the durable-jobs CORE
  already exists** (`core/jobs/{queue,worker,backoff,dag,quiet-hours}.ts`):
  atomic `FOR UPDATE SKIP LOCKED` claim (multi-worker safe), `lock_until` lease
  + `stall_count`/`max_stalled` WEDGE detection & requeue (mig 008), DAG FAN-IN
  (mig 019), retry/backoff, quiet-hours. The remaining deltas — a PID-file
  single-supervisor guard, multi-PROCESS lock-renewal heartbeat, and per-kind
  rate-lease concurrency gates — are SCALE-OUT features that add little on the
  single-EC2 single-worker deployment (one container, one drain loop). DEFER
  until a genuine multi-process / multi-host need arises; job-audit JSONL is a
  small standalone follow-on if wanted.

### Enrichment (LLM-free subset)
- [~] Typed-NER link inference — **schema-pack (frontmatter) DONE** (v1.3.46,
  opt-in `MEMEX_TYPED_LINKS=1`): `core/typed-links.ts` derives works_at/founded/
  attended/located_at/advises/invested_in/knows edges from `compiled_truth`
  fields (FIELD_MAPPINGS), resolver PRECISE-stages-only (no trgm), RESOLVED-ONLY,
  link_kind='typed_ner' + origin_slug, single-origin invariant, DO-NOTHING yield
  to explicit. STILL DEFERRED: prose-window NER from context (gazetteer +
  ReDoS-guarded pack regex) (high); completeness scoring rubrics (medium); the
  company-side `key_people`→works_at mapping + typed_ner↔explicit coexistence
  (needs #145 link_kind UNIQUE widen).

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

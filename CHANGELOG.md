# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- **Contract-derived param validation at the MCP boundary.** Every tool call is
  now checked against the `OPERATIONS` contract before dispatch: a present param
  must match its declared type, enum membership, and numeric min/max, else the
  call returns a structured `invalid_params` `OperationError`. This enforces, in
  one place, the constraints the advertised `inputSchema` already declares but
  individual handlers checked unevenly. Safe by construction: the MCP client
  derives its params from the same contract, so a well-formed call can never be
  rejected (a per-operation parity test pins this) — only a malformed one, which
  a handler would have rejected anyway. Required-presence is still owned by the
  handlers (their messages are richer); unknown/undeclared params are not
  rejected. One real tightening: an `object`-typed param now rejects a JSON
  ARRAY (arrays were previously accepted by the `typeof === "object"` handler
  guards), matching the schema's `type:"object"` for the loose write-tool fields
  (`compiled_truth` / `payload` / `extra`). Reviewed by security-engineer (ship
  — no new oracle, no injection, no DoS) + code-reviewer. `validateParams` in
  `mcp/operations.ts`.

## [1.3.30] — 2026-06-11

### Added
- **Per-family retrieval eval gate (test-only).** A new hermetic gate groups
  the retrieval qrels into named query FAMILIES — `body_term` (a control),
  `alias_synonym` (reachable only through the embedder's synonym bridge), and
  `multi_chunk_dilution` (the relevant phrase lives in one chunk of a 3-chunk
  document, competing with a partial-match distractor) — and asserts each
  family's Hit@3 independently. Aggregate metrics can stay green while a single
  retrieval MODE silently regresses; per-family gating catches that. Includes a
  differential probe proving the `alias_synonym` family is a true vector-arm
  sentinel (the keyword arm alone provably cannot satisfy it), so a dead vector
  arm fails the gate. Complements the aggregate hybrid gate; no production code
  changes. `tests/retrieval_quality_families.test.ts`.

## [1.3.29] — 2026-06-11

### Added
- **Structured `OperationError` envelope for known MCP failures.** A known,
  validated failure (bad params, unknown tool) now returns a machine-readable
  envelope — `{error: <code>, message, suggestion?, docs?}` — instead of a bare
  string, so the calling agent can branch on a stable code and act on the
  recovery hint. On PUBLIC ingress the free-text `message` is withheld (the
  only field that could carry runtime detail); the constrained `error` code and
  author-static `suggestion`/`docs` pass through, a net improvement over the
  previous single generic public string. Raw exceptions stay on the
  fully-redacted path unchanged. The `search` param validations (`q`, `k`,
  `token_budget`) and the unknown-tool path now throw it. Reviewed by
  security-engineer (ship — message-drop is a structural control, no
  enumeration/XSS/prototype-pollution) + code-reviewer. Adapted from the
  reference's `OperationError`, with memex's public message-redaction contract
  added. New `core/operation-error.ts`.

## [1.3.28] — 2026-06-11

### Changed
- **Rate limiter: LRU eviction + TTL instead of fail-closed at capacity.** The
  per-IP token-bucket limiter used to refuse all new keys once its `maxKeys`
  cap (10 000) filled — so a flood of distinct source IPs could lock out every
  new legitimate caller (a trivial denial of service). It now evicts the
  least-recently-used bucket to admit a new key, so a new caller is always
  admitted while memory stays bounded; per-key throttling is unchanged, and an
  active caller is self-healing (each request re-marks it most-recently-used,
  out of eviction range). A TTL sweep (`ttlMs`, default 15 min) now drops
  buckets untouched past the window alongside the existing idle
  (fully-refilled) sweep. Reviewed by security-engineer (ship, net improvement
  over fail-closed) + code-reviewer.

## [1.3.27] — 2026-06-11

### Added
- **`memex embed [--limit N] [--dry-run]` — embedding backfill.** Re-embeds
  non-code chunks that have no row in the `embeddings` table — the operator
  remedy when `memex status` / `memex doctor` (source-health) report
  `embed_coverage` below 100%. Such chunks (indexed before embedding was wired,
  left behind by a dropped embedding-dimension migration, or skipped by a
  transient Bedrock failure mid-index) are invisible to the vector arm of
  hybrid search — only the keyword arm can reach them — so a silent retrieval
  hole opens. The command walks the missing chunks and computes their Titan
  vectors. Code chunks are graph-only by design and stay excluded (the
  candidate filter matches source-health's `embeddable` definition). Idempotent
  (`ON CONFLICT DO NOTHING` + an `IS NULL` anti-join, so a re-run only embeds
  what is still missing); per-chunk failures are counted, not fatal; `--dry-run`
  counts without any Bedrock call; `--limit N` caps cost per run. A successful
  backfill bumps the document-generation clock so the exact-match query cache
  is invalidated — a ranking cached before the repair no longer bypasses the
  freshly-embedded chunks. The recorded model id is sourced from the same
  constant `embedText` defaults to, so a backfilled row never drifts from the
  embedder that produced it.

## [1.3.26] — 2026-06-11

### Added
- **Weighted chunk FTS (`search_vector`).** The keyword search arm now ranks
  against a new weighted `chunks.search_vector` (migration 030) instead of the
  flat `ts` column. A chunk's symbol identity — `symbol_name` plus its
  `parent_symbol_path` scope, populated for code chunks by migrations 027/028 —
  sits at FTS weight `A`, above the body text at weight `B`, so a query that
  names a function/class (or its enclosing scope) ranks that symbol's chunk
  above chunks that only mention the term in prose. Markdown chunks have no
  symbol columns, so their lexemes all fall to weight `B` — a uniform shift
  from the old default `D` that scales `ts_rank_cd` identically and leaves
  their relative order (and the rank-based RRF contribution) unchanged; only
  symbol-bearing chunks gain the differential boost. The tokenizer config is
  unchanged (`simple`), so the matched set for markdown chunks is identical to
  the old `ts`. For code chunks it is also a small recall gain — a query naming
  an enclosing scope now reaches a nested chunk whose body omits it. Computed by a `BEFORE INSERT OR UPDATE` trigger (the
  `array_to_string` fold of the scope array is not immutable, so a generated
  column was not possible); existing rows are backfilled in the migration.
  Adapted from the reference's weighted chunk FTS — its `doc_comment` /
  `symbol_name_qualified` weight-`A` inputs do not exist in memex yet and fold
  in when those columns land.

## [1.3.25] — 2026-06-11

### Added
- **Near-duplicate dedup (Jaccard text similarity).** After the existing
  per-document dedup, a new stage drops a hit whose text is too similar
  (word-set Jaccard > `MEMEX_NEARDUP_JACCARD`, default `0.85`) to a
  higher-ranked already-kept hit. Per-doc dedup keeps one chunk per document,
  but two DIFFERENT documents can still carry near-identical text (a note and
  its `.bak` copy); this collapses them to the higher-ranked twin. Greedy and
  rank-order-preserving; an empty/contentless hit is never dropped. Skipped for
  `exact` intent ("show me everything") and disabled entirely when the threshold
  is set `> 1.0`. Adapted from the reference's Layer-2 text-similarity dedup; the
  reference's type-diversity layer (needs a page-type taxonomy memex lacks) and
  compiled-truth guarantee (an LLM-cycle artifact memex lacks) are intentionally
  not ported. The threshold is folded into the query-cache ranking signature, so
  changing it re-keys the cache. New `dedupByTextSimilarity` in
  `core/search/dedup.ts`.

## [1.3.24] — 2026-06-11

### Fixed
- **Deterministic tie-break in the keyword search arm.** `keywordSearch` ordered
  by `ts_rank_cd` alone, so equal-rank ties — common when several chunks share
  the query terms — resolved in the storage engine's unspecified order, a latent
  source of green-local / red-Linux divergence (the same flakiness class as the
  mock-leak incident). Both keyword queries now append `, id COLLATE "C" ASC`: a
  byte-order secondary key that is identical on PGLite and live RDS regardless of
  their default collations. `ts_rank_cd` is a computed expression (always sorted,
  never index-backed), so the tie-break is free — no plan change, no ranking
  change, only the previously-unspecified tie order is now stable. The vector arm
  is deliberately left untouched: a secondary key on a pgvector `<=>` ORDER BY
  can defeat the HNSW index, and exact cosine ties on real embeddings are
  vanishingly rare.

## [1.3.23] — 2026-06-11

### Added
- **Hermetic retrieval-quality gate over the full hybrid path.** The CI
  correctness gate now covers vector + keyword + RRF fusion (previously only the
  keyword arm), with NO Bedrock: a deterministic basis-vector embedder
  (`tests/det-embed.ts` — FNV-1a token hash → 1024-dim L2-normalized
  bag-of-words) seeds chunk vectors and is injected into the query side through
  a new `SearchOptions.embedQuery` seam, while intent override + `noExpansion` +
  `noCache` strip the remaining LLM calls. A change that regresses hybrid
  ranking below the floors (hit-rate, MRR, nDCG — env-overridable) now turns the
  suite red. The `embedQuery` option defaults to the real Titan embedder, so it
  is a test-only injection with zero production behavior change.

## [1.3.22] — 2026-06-11

### Added
- **Adaptive return-sizing (opt-in, default OFF).** A new per-call
  `adaptiveReturn` search option trims the returned hit list to an
  intent-driven cap instead of always returning the full top-K: single-answer
  intents (`factual` / `exact`) get a tight cap (default 2), broad intents
  (`topic` / `howto` / `personal`) get a recall-preserving cap (default 6), with
  an at-least-`minKeep` failsafe so a caller never gets a silent blank when
  candidates exist. `true` enables the defaults; a partial object overrides the
  caps. Adapted from the reference (whose intent union differs) to memex's own
  `Intent` values, and — because memex's hybrid score is RRF-fused (no
  trustworthy cliff) — the mechanism is a cap, not a score-cut. Applied as the
  FINAL view, after the query cache stores the full ranked set and after the
  eval-capture hook records it, so it never poisons the cache and never shrinks
  the eval window. Default OFF → identical results for every existing caller.
  New `core/search/return-policy.ts`.

## [1.3.21] — 2026-06-11

### Security
- **Query-expansion prompt-injection guards.** The query-expansion step asks
  Nova Lite (Bedrock Converse) for paraphrase variants of the user query. Both
  sides of that call are now sanitized: `sanitizeQueryForPrompt` neutralizes the
  query before it reaches the model (caps length, strips code fences + HTML-ish
  tags, drops a leading instruction-override preamble such as
  `ignore:`/`system:`, collapses whitespace, and warns — without echoing the
  content — when it changes anything), and `sanitizeExpansionOutput` validates
  the untrusted model output (strips control characters, drops empties, caps
  length, dedupes, caps the count). Defense-in-depth: the query already travels
  in the user turn and the variants only become additional keyword (tsquery)
  search passes — never code, never re-fed to an LLM — so this hardens the trust
  boundary without changing results for a normal query. New exports in
  `core/search/expansion.ts`.

## [1.3.20] — 2026-06-10

### Added
- **Title-phrase boost.** When the query is a contiguous phrase in a page's
  title (a "name of the thing" query), that hit's score is nudged up by a
  scale-invariant factor (`MEMEX_TITLE_BOOST`, default `1.25`, ON) so the page
  surfaces over a weak body chunk that merely mentions the terms. Adapted from
  the reference's title-superstring matcher: a multiplier is scale-invariant, so
  unlike the reference's cosine floors it applies cleanly onto memex's RRF
  score. Matching is deterministic and zero-I/O — a contiguous token-run inside
  the title (token-boundary, not substring) gated by ≥2 non-stopword content
  tokens, or an exact full-title match (covers single-word chosen names). Set
  `MEMEX_TITLE_BOOST` ≤ `1.0` to disable; a fractional value warns (the boost
  only ever multiplies up). New `core/search/title-match.ts`.

### Changed
- **`evidence` now recognizes `exact_title_match`, and `exists` is tightened.**
  A title-phrase hit is stamped `exact_title_match` (→ `create_safety: exists`)
  at any rank — the strongest, arm-independent signal. The both-arms→
  `high_vector_match`→`exists` path is now gated on the hit landing in the top
  rank band (the first 3 results) rather than firing for any both-arms hit:
  the wide retrieval fanout means co-membership in both arms is not the same as
  a high rank, so a common token could previously land an irrelevant chunk in
  both arms and read a false `exists`. A both-arms hit outside the head now
  reads `keyword_exact` (`probable`) instead. This is more conservative (the
  worse error — a false `exists` that hides a real page and risks silent data
  loss — is removed) while the rank band still protects a legitimate page that
  sits at rank 1–2. Cache-hit results gain `exact_title_match` too (it keys off
  the hit title, computable without arm membership); everything else keeps the
  conservative default. Search ordering changes only for title-phrase hits.
- **Query-cache key folds in a ranking signature.** The exact-match query cache
  stores an ordered result list; its key now includes a `RANKING_VERSION` tag,
  the live `MEMEX_TITLE_BOOST` (read through the same memoized getter the
  ranking uses, so the key and the order can't diverge), and the raw
  `MEMEX_RECENCY_DECAY` env — so deploying a ranking change or changing either
  env re-keys the cache immediately instead of serving a pre-change ordering
  until the document clock next advances. (Time-based recency drift within a
  cache lifetime remains by design — the cache is gated on the document
  generation clock, so any write refreshes it.)

## [1.3.19] — 2026-06-10

### Added
- **Search hits carry `evidence` + `create_safety`.** Every search result is
  now stamped with WHY it matched, not just a score: `evidence` names the
  strongest signal that surfaced the chunk (`high_vector_match` when both the
  vector AND keyword arms found it, `keyword_exact` for a keyword-only match,
  `weak_semantic` otherwise) and `create_safety` (`exists` / `probable` /
  `unknown`) is the derived "is this page already here?" hint an agent can key
  its don't-duplicate decision off instead of a raw score. Adapted from the
  reference's contract to memex's score model: the reference keys off a
  calibrated 0..1 cosine, but memex's hybrid score is RRF-fused (rank-based),
  so the signal is which retrieval ARM(s) surfaced the chunk, not a cosine
  floor — conservative by design, so a soft signal never reads as `exists`.
  Pure-additive: it does not reorder results. The two labels are constrained
  enums (no note content), so they surface on both internal and public ingress.
  Cache-hit results (which hydrate stored chunk ids without re-running
  retrieval) get the conservative default `weak_semantic` / `unknown`, so the
  contract is always present and never a false `exists`. New
  `core/search/evidence.ts`.

## [1.3.18] — 2026-06-10

### Changed
- **MCP tool schemas are now generated from one contract.** The 25 inline
  JSON-Schema `inputSchema` blocks (which had to be hand-kept consistent across
  the HTTP and stdio surfaces) are replaced by a single `OPERATIONS` contract
  (`mcp/operations.ts`): each tool declares its params as typed `ParamDef`s and
  the schema is derived by `operationInputSchema` / `paramDefToSchema`. The
  defs MCP clients receive are byte-for-byte identical — a snapshot-equivalence
  test pins the generated output against the original hand-written defs, so
  this is a proven zero-behavior refactor. It removes the drift risk and gives
  a typed surface to build derived param validation on next.

## [1.3.17] — 2026-06-10

### Added
- **Opt-in JSONL audit trail for MCP tool calls.** When `MEMEX_AUDIT_DIR` is
  set, each tool call appends one redacted JSON line to an ISO-week-rotated
  file (`<dir>/audit-<YYYY-Www>.jsonl`) — the same redacted summary the console
  logger uses (tool name, ingress, ok, declared param key names + counts +
  bucketed size; never a value). The two sinks are independent (`MEMEX_AUDIT_DIR`
  for the file, `MEMEX_LOG_REQUESTS` for stdout), both off by default. The
  writer is best-effort: an unwritable dir or full disk is swallowed so the
  audit trail can never break the request it records. New
  `core/audit-week-file.ts`.

## [1.3.16] — 2026-06-10

### Added
- **`memex status` — one-shot operational snapshot.** Bundles the three signals
  an operator usually wants at a glance into a single JSON object: index counts
  (`stats`), data/ingest health (embedding coverage, staleness lag, job queue,
  failed jobs — from `brainHealthMetrics`), and the query-cache state
  (total / fresh / stale vs the clock). Read-only and judgement-free — unlike
  `doctor` it sets no exit code; it just reports the numbers, reusing the same
  primitives `doctor` and `cache` use. New `commands/status.ts`.

## [1.3.15] — 2026-06-10

### Fixed
- **CLI commands that signal failure via `process.exitCode` now actually exit
  non-zero.** The entrypoint called `process.exit(code)` with the cli case's
  return value, and an explicit `0` argument OVERRIDES any `process.exitCode` a
  command set — so `memex doctor` (and `lint` / `integrity` / `eval` /
  `check-resolvable` / `sources` / …, which print a report and set
  `process.exitCode = 1` while returning 0) exited 0 even on failure, silently
  breaking their documented cron/CI "exits 1 on failure" contract. A new
  `resolveExitCode` honours an explicit non-zero return first, then falls
  through to `process.exitCode` — repairing every affected command at once.

## [1.3.14] — 2026-06-10

### Added
- **`memex call <tool> [--args '<json>']` — invoke any MCP tool from the
  shell.** A convenience for operators and smoke tests: exercise a tool exactly
  as the MCP transport would, without standing up an MCP client. Dispatch runs
  on the INTERNAL ingress (same trust as `reindex` / `apply-migrations`), so
  write tools and full unredacted read output are available — the public-bearer
  surface is a separate path and is unaffected. `--args` must be a JSON object;
  the exit code is 1 when the tool returns an error result, so it composes in
  scripts. New `commands/call.ts`.

## [1.3.13] — 2026-06-10

### Added
- **Redacted MCP request logging (opt-in).** `summarizeMcpParams` turns a tool
  call's params into a log-safe summary — which *declared* parameter names were
  present (from the tool's schema), how many *unknown* keys came along, and a
  coarse byte size — and never a single value (a search `q`, a `page_put` body,
  a slug, a path all stay out of the logs). Size is bucketed UP to the nearest
  1 KB so the exact length can't be binary-searched via repeated probes (a
  content-length side channel). A new `logToolCall` hook in the MCP HTTP
  transport writes one such redacted line per tool call **only when
  `MEMEX_LOG_REQUESTS=1`** — off by default, so there is no behavior change
  until an operator opts in. New `mcp/param-redaction.ts`.

## [1.3.12] — 2026-06-10

### Added
- **`memex cache` CLI — operator surface for the query cache.** `cache stats`
  reports the query-cache row counts split fresh-vs-stale against the current
  document-generation clock (plus distinct intents and created-at span);
  `cache prune` drops only the stale rows (those a doc write has already
  invalidated — never served, just taking space); `cache clear` drops every
  row. Neither prune nor clear can change search correctness — a miss simply
  recomputes from the live tables. New `core/search/query-cache.ts`
  `cacheStats` / `pruneCache` / `clearCache` + `commands/cache.ts`. Read-only
  for `stats`; no migration.

## [1.3.11] — 2026-06-10

### Added
- **Brain-level health metrics surfaced by `memex doctor`.** A new
  `source-health` check reports embedding coverage (over the chunks that
  *should* carry a vector — code chunks are graph-only by design and excluded),
  ingest staleness `lag_seconds`, pending `queue_depth`, and `failed_jobs_24h`.
  It is informational by design: only a job that *failed* in the last 24h gates
  the check (an unambiguous "something broke"); coverage / lag / queue are
  reported in the detail rather than declaring the brain unhealthy, because a
  brain can legitimately run with partial coverage (graph-only sources, a
  pending backfill). New `core/source-health.ts` (`brainHealthMetrics`),
  categorized `brain`. Read-only aggregation, no Bedrock, no migration.

## [1.3.10] — 2026-06-10

### Added
- **`memex doctor` categorizes checks + ranks failures root-cause-first.**
  Each check now carries a `category` (`brain` = data integrity, `ops` =
  infra/setup, `meta` = the doctor itself; the agent-only `skill` category is
  intentionally absent — memex is brain-only), and the report gains a
  `summary` with a per-category ok/fail rollup and a `ranked_failures` list
  ordered root-cause-first. Ordering carries an explicit honesty contract: a
  failure is only annotated `downstream_of` a root when that root is *also*
  failing — co-failure is never treated as proof of causation. A drift guard
  (`tests/doctor_categories.test.ts` + the doctor end-to-end test) fails CI if
  a future check ships without a category. No behavior change to exit codes or
  the existing `checks` array. New `core/doctor-categories.ts` +
  `core/doctor-cause-rank.ts`.

## [1.3.9] — 2026-06-10

### Changed
- **Link-provenance columns on `links` made usable (migration 029).**
  Migration 024 (P0) had already laid five provenance columns on `links` as
  bare nullable TEXT stubs (`context`, `link_kind`, `origin_page_id`,
  `origin_field`, `resolution_type`) but nothing populated or constrained
  them. Migration 029 turns the stubs into a usable contract so a future
  LLM-free enrichment pass (gazetteer auto-link, typed-NER) and a reconcile
  pass can rely on them: `context` becomes `NOT NULL DEFAULT ''` (a missing
  window is `''`, never NULL — existing NULLs backfilled); `link_kind` gets a
  CHECK (`plain` | `typed_ner`); `resolution_type` gets a CHECK (`qualified` |
  `unqualified`); and the mis-named `origin_page_id` (024 copied the
  reference's integer name, but this brain is slug-keyed) is **renamed to
  `origin_slug`**, a soft reference consistent with `source_slug` /
  `target_slug`. `addLink` now accepts + validates these and keeps them
  **sticky** on an idempotent re-add (a bare `link` re-call never wipes
  enrichment-written provenance). No public/redaction surface change: the
  `graph_neighbors` / `graph_query` projections do not select these columns
  and the public allowlist excludes them — `context` (free-text note content)
  can never reach a public-bearer caller. The explicit `link` MCP tool
  contract is unchanged. Every migration step is guarded (idempotent).
  Unblocks link reconciliation + NER.

## [1.3.8] — 2026-06-10

### Changed
- **`chunks.parent_symbol_path` widened scalar TEXT → `TEXT[]` — nested code
  symbols keep their full ancestor chain.** The code chunker (migration 027,
  v1.3.4) recorded only the innermost enclosing symbol, so a method inside
  `outer() { class Inner { … } }` stored `"Inner"` and lost `"outer"`. The
  chunker now emits the whole scope chain outermost-first
  (`["outer","Inner"]`); the indexer persists it as a `TEXT[]`, and
  migration 028 casts existing scalar values to 1-element arrays in place
  (no data loss — the innermost parent is preserved; deeper chains fill in
  on the next reindex of each file). Markdown chunks stay NULL. The column
  is not yet surfaced in search output, so there is no public/redaction
  surface change. Substrate for later symbol-edge / qualified-name
  resolution.

### Added
- **Hermetic retrieval-quality CI gate (keyword arm).** A deterministic
  test seeds a tiny corpus, runs the keyword/FTS search over a set of query
  families, scores it with the IR-metric primitives (recall@k / MRR /
  nDCG@k), and asserts floor thresholds — so a change that regresses keyword
  ranking turns the suite red. No Bedrock, no embeddings. (The vector/hybrid
  arm needs a deterministic query-embedder injection point — tracked as a
  follow-up.)
- **`scripts/mcp-refresh.sh` — one-shot client bearer refresh.** Pulls the
  current public bearer from Secrets Manager and re-registers the memex MCP
  server in Claude Code, so a client holding yesterday's (rotated) token can
  recover from 401s without manual steps. Keeps the strong daily rotation;
  just removes the manual re-register. Token is fetched fresh, never printed,
  and the `claude mcp add` output is suppressed so it can't echo the header.
  Env-driven (`MEMEX_MCP_URL`, optional `AWS_PROFILE`/`AWS_REGION`/
  `MEMEX_SECRETS_PREFIX`); runs on the operator's machine, not the host.

## [1.3.7] — 2026-06-09

### Added
- **eval-replay now reports run-to-run retrieval stability.** Each replayed
  query that has a promoted baseline gains a `stability` block — `jaccard`
  (top-k set overlap of the current vs baseline result ids) and `top1` (did
  the rank-1 result stay the same) — with an aggregate `meanJaccard` +
  `top1StableRate`. Computed by new pure IR-metric primitives
  (precision/recall/MRR/nDCG/Jaccard/top-1) in `core/search/metrics.ts`, the
  substrate for the forthcoming retrieval-quality harness + CI correctness
  gate. No change to the live search path.

## [1.3.6] — 2026-06-09

### Changed
- **Recency decay is now per-prefix instead of one global half-life.** The
  recency multiplier picks its half-life + floor by longest-prefix-match on a
  hit's path: evergreen tiers (e.g. `concepts/`) stop decaying, time-bound
  tiers (e.g. `daily/`, `chat/`) decay fast, entity tiers (`people/`,
  `companies/`) decay slowly. Paths matching no prefix keep the original
  uniform decay (120-day half-life, 0.6 floor), so existing rankings are
  unchanged for un-prefixed content (including code chunks under `src/`).
  Override the map with `MEMEX_RECENCY_DECAY=prefix:halfLifeDays:floor,...`
  (parsed fail-loud so a typo surfaces at startup).

## [1.3.5] — 2026-06-09

### Security
- **Graph reads now redact relationship provenance on public ingress.**
  `graph_neighbors` / `graph_query` previously returned raw edge rows to the
  public bearer, exposing the full relationship topology *plus* provenance
  (`source_chunk_id`, `written_at`), the confidence signal, and the internal
  row id. The public projection now keeps only the slugs + the constrained
  edge `type` (consistent with the rest of the read surface, where slugs are
  already public) and drops everything else. Provenance is stripped on **any**
  public ingress, independent of `MEMEX_PUBLIC_READ_BODIES` (that flag governs
  note bodies, not graph metadata). Internal ingress is unchanged. Found by a
  cross-model audit (independent reviewers + a parity diff against the
  reference implementation).

## [1.3.4] — 2026-06-09

### Added
- **Code chunks now carry symbol metadata.** Indexing a source file records
  each chunk's `symbol_name`, `symbol_type` (function/class/method/arrow/
  const/module-import), `parent_symbol_path` (enclosing symbol), and
  `language` on the live `chunks` table (migration 027) — values the
  tree-sitter chunker already computed but previously discarded. Markdown
  chunks leave them NULL. This lets `code-callees <path>:<line>` name the
  covering symbol straight from the chunk row and is the substrate for
  symbol-aware retrieval. No change to public search output.

## [1.3.3] — 2026-06-09

### Security
- **Raw exception text no longer crosses the public boundary.** The MCP
  tool dispatcher, the JSON-RPC transport, and the unauthenticated
  `/health` endpoint previously echoed an exception's message straight to
  the caller — on a DB fault that could leak Postgres schema/column names
  or the DSN host. A shared `publicSafeErrorMessage` helper now logs the
  real detail server-side and returns a generic `"internal error"` on
  public ingress (and always for `/health`); the internal path keeps the
  full detail for debugging. Found by an adversarial security audit.

## [1.3.2] — 2026-06-09

### Changed
- **Migrations now fail fast instead of hanging a deploy.** Each migration
  transaction sets `lock_timeout` before its DDL, so an `ALTER`/`ADD COLUMN`
  that can't acquire its `ACCESS EXCLUSIVE` lock (because a long-running
  query holds a conflicting one on live RDS) aborts and rolls back rather
  than blocking the deploy indefinitely. Default is `10s`; override with
  `MEMEX_MIGRATION_LOCK_TIMEOUT` (e.g. `60s`, `5min`) for a one-off
  migration that must wait behind a known long transaction — a malformed
  value fails the deploy loudly. No effect on local PGLite
  (single-connection, no lock contention).

## [1.3.1] — 2026-06-08

### Removed
- **The Obsidian / markdown auto-watch recipe.** `serve` no longer spins up
  a filesystem watcher + boot-time vault sweep. Markdown still enters the
  brain on demand via the `memex reindex` CLI and the MCP `index` tool (and
  pages via `page_put`) — only the always-on vault recipe + its chokidar
  watcher are gone (it was already disabled in production). Stale "Obsidian"
  references across docs and comments were cleaned up; the functional
  dotfile ignore globs (`.obsidian`, `.git`, …) and the `index`/`reindex`
  path-guard are unchanged.

## [1.3.0] — 2026-06-08

### Changed
- **Hybrid search now honours a document's declared importance.** A
  frontmatter `pinned: true` floors a gentle salience multiplier at 1.3×,
  and `weight: <n>` sets it explicitly (clamped to 0.5–2.0×). Applied as a
  post-fusion nudge alongside recency; documents that declare neither are
  unaffected (1.0×). Lets you pin/weight notes without touching the engine.
- **Hybrid search now nudges fresher content up the ranking.** A gentle,
  floor-bounded recency multiplier decays with `documents.updated_at`
  (half-life ~120 days, never below 0.6× so old-but-relevant hits are
  nudged, not buried). Operates on the live retrieval model; a
  missing/unparseable/future timestamp is neutral (1.0×).
- **Hybrid search now weights keyword vs vector retrieval by query
  intent.** Reciprocal Rank Fusion gained optional per-list weights;
  `exact`/`factual` queries lean on keyword (FTS) matches, `topic`/
  `personal` queries lean on semantic vector matches, `howto` stays
  balanced. Gentle multipliers (0.7–1.4) nudge ranking without overriding
  RRF's rank smoothing. Equal-weight behaviour is unchanged when no
  weights are passed.

### Added
- **Exact-match query cache for hybrid search (on by default, fail-open).**
  An identical repeated query now returns its previously-computed ranking
  without re-embedding, re-classifying intent, or re-retrieving — saving
  latency and Bedrock calls. Validity is gated on the live-model generation
  clock, so any document write invalidates the cache automatically; the
  cache stores only chunk ids, re-hydrated from live tables so returned
  content is always current. Any cache error falls through to a normal
  search (it can never break retrieval). Disable per-call with `noCache` or
  globally with `MEMEX_QUERY_CACHE=0`. Migration 026.
- **Cache-invalidation clock on the live retrieval model (internal).** A
  `document_generation_clock` singleton (migration 025) is bumped on every
  document write from the indexer transaction, giving a cheap corpus-level
  "did anything change" signal. Substrate for a forthcoming query cache; no
  behaviour change yet. (The earlier clock from migration 022 sits on the
  dormant `pages` model; this one is on the live `documents`/`chunks` path.)
- **`search` gained an optional `token_budget` parameter.** Caps the total
  size of returned context (~chars/4 tokens); hits are kept in rank order,
  the overflowing tail hit is truncated on a word boundary, and the top hit
  is always returned. Lets an MCP client ask for right-sized context instead
  of a fixed `k` chunks. Unset = unchanged behaviour.
- **Schema substrate for retrieval-quality work (internal, no behavior
  change yet).** A per-page `generation` counter plus a global
  `page_generation_clock` singleton provide a cheap cache-invalidation
  signal for a future query cache; new `tags` / `raw_data` / `config` /
  `ingest_log` metadata tables; and provenance / ranking-signal columns on
  `pages` / `sources` / `links` (e.g. `emotional_weight`,
  `last_retrieved_at`, link `context`/`origin`). All additive — the
  foundation the retrieval-quality phases build on. Migrations 022–024;
  the generation bump is applied at the application layer inside the
  existing page-write transaction (memex uses no DB triggers).

## [1.2.13] — 2026-06-07

### Security
- **EC2 security group SSH inbound now actually closes when disabled.**
  The SSH ingress rule was defined with a `dynamic "ingress"` block whose
  `for_each` collapsed to an empty list when `ssh_allowed_cidr=""` — but a
  dynamic block that iterates zero times leaves the `ingress` attribute
  *unset* (null), which the AWS provider reads as "do not manage ingress",
  so the live `/32` rule was never removed. Rewrote it as an explicit
  `ingress = var.ssh_allowed_cidr != "" ? [{…}] : []` argument; the empty
  list forces the provider to delete all inbound rules. Set
  `ssh_allowed_cidr=""` and applied — the live SG now has zero inbound
  (host is reached only via SSM Session Manager).

### Removed
- **Dropped the legacy `subdomain` slot end-to-end.** `var.subdomain` (the
  retired chat-UI host) fed `STACK_SUBDOMAIN` → `.env` `SUBDOMAIN`/
  `PUBLIC_HOST`, none of which any service consumes (compose reads neither).
  Removed it from `variables.tf`, `compute.tf`, `user_data.sh.tftpl`,
  `terraform.tfvars.example`, `scripts/bootstrap.sh`, and `scripts/init.sh`,
  and realigned `tests/init.test.sh` to the new prompt order. The live
  instance is unaffected (`ignore_changes=[user_data]`; bootstrap runs only
  on first boot). The public MCP host (`memex_subdomain` → `brain.*`) is
  untouched.

### Changed
- **`/ship` is now the mandated entry point for shipping.** Documented in
  `CLAUDE.md` that every change must ship via the `/ship` skill, with the
  repo-specific overrides spelled out (ships to `main`, tags + `gh release`
  instead of a `VERSION` file, operator-only commits with no Claude
  co-author, SSM deploy, local tests as the gate).

## [1.2.12] — 2026-06-06

### Fixed
- **Daily public-bearer rotation never reached the live container.**
  `scripts/rotate-memex-public-bearer.sh` wrote the new bearer to Secrets
  Manager + the on-disk `env_file`, then ran `docker restart` — which does
  NOT reload a changed `env_file` (container env is baked at *create*
  time). So after every 04:00 rotation the container kept the previous
  bearer while SM held the new one, silently breaking public MCP auth for
  any client using the current SM value until the next `compose up`.
  Replaced the restart with `docker compose up -d --force-recreate memex`
  so the freshly-staged `env_file` is actually loaded. Discovered live
  (SM == on-disk env, but the container's `MEMEX_PUBLIC_BEARER` was
  stale). Added `MEMEX_ROTATE_SERVICE` knob (default `memex`).

## [1.2.11] — 2026-06-05

### Security
- **`entity_recall` public page now passes the full field allowlist.** A
  follow-up `/cso` + bug-hunter pass found the public `entity_recall`
  returned its `page` object via the recall layer's `redact_body`
  destructure (which strips only `markdown_body`) instead of the shared
  `redactBody` / `PUBLIC_SAFE_PAGE_FIELDS` allowlist that `page_get` /
  `page_list` / `page_versions` use. No free-text body leaked (markdown
  body was stripped, `compiled_truth` is public by policy), but it
  returned `deleted_at` and — the real issue — **broke the fail-safe
  invariant**: a newly added `PageRow` field would have leaked by default
  on this one path. `mcp/dispatch.ts` `callEntityRecall` now runs the
  page through `redactBody` on public ingress; regression test asserts
  every returned page key is allowlisted. Internal ingress unchanged.

## [1.2.10] — 2026-06-05

### Security
- **Supply-chain: SHA-pin `oven-sh/setup-bun`.** The CI workflow pinned
  the third-party action to a mutable `@v2` tag; moved to the commit SHA
  `0c5077e51419868618aeaa5fe8019c62421857d6` (# v2), matching the
  existing `hashicorp/setup-terraform` pin. Removes the tag-move
  supply-chain vector (already heavily mitigated by
  `permissions: contents: read`, no workflow secrets, push/PR-only
  triggers).
- **Least-privilege: drop stale Gmail egress rules.** Removed the
  `993` (IMAP TLS) and `587` (SMTP STARTTLS) egress rules from the EC2
  security group in `terraform/ec2.tf` — the Gmail/IMAP/SMTP
  integrations were removed when memex became MCP-only, leaving those
  outbound ports allowed for no consumer. Egress-only (no inbound
  exposure), so this is hygiene, not a fix; the live SG drops them on
  the next operator `terraform apply` (folded into the deferred
  state-realign maintenance window — see `TODO.md`).

### Changed
- **Documented the public-read-redaction posture as complete.** Every
  body-bearing / free-text read tool now redacts on public ingress;
  the `graph_*` edge-`type` is an explicit, documented *keep* (single-
  holder daily-rotated bearer; constrained enum, not note text; core to
  graph recall). Reframed the now-dead `FORBIDDEN_PATHS_FROM_PUBLIC`
  REST guard in `http/public_guard.ts` as an intentional fail-closed
  defense-in-depth backstop (the REST routes were removed in A.7; the
  set guards against accidental re-introduction). No runtime behavior
  change.

## [1.2.9] — 2026-06-05

### Security
- **Public-ingress redaction now covers entity facts + timeline.** A
  `/cso` audit found the public MCP read path stripped note bodies from
  `search` / `page_get` / `page_list` / `page_versions` and
  `entity_recall`'s page body, but **not** the free-text `fact` and
  `event` strings returned by `entity_facts`, `entity_timeline`, and
  `entity_recall`'s `facts[]` / `timeline[]` arrays — note-derived
  private content reachable by any public-bearer holder, the same leak
  class as the pre-v1.2.0 vault exposure. Added `redactFacts` /
  `redactTimeline` allowlists in `core/public_redaction.ts` (keep
  id/slug/confidence/source/timestamps, drop the `fact`/`event` text)
  and threaded the `redact` flag through the three entity read tools in
  `mcp/dispatch.ts`. Internal ingress and the `MEMEX_PUBLIC_READ_BODIES=1`
  opt-in are unchanged. Regression tests assert the secret text is
  absent anywhere in a public payload (leak-shaped, rename-proof) and
  present on the internal path. Residual `jobs_*` / `graph_*` public
  read exposure tracked in `TODO.md`.
- **Public-ingress redaction extended to `backlinks` + the `jobs_*`
  reads.** A follow-up security review (security-engineer + bug-hunter)
  found the same leak class still open on read tools that were never
  threaded through the public allowlist: `backlinks` returned
  `surfaceForm` (the raw note-authored wikilink display text, e.g.
  `[[people/jane|Jane's lawyer]]` → `Jane's lawyer`), and `jobs_get` /
  `jobs_list` / `jobs_logs` returned `payload` / `result` / `last_error`
  / `idempotency_key` — arbitrary caller JSON plus raw error text that
  can embed vault paths and note snippets, reachable by any public-bearer
  holder (job IDs are discoverable via `jobs_list`). Added
  `redactBacklinks` + `redactJob` allowlists in
  `core/public_redaction.ts` (keep the operational status/metadata, drop
  the free-text fields) and threaded the `redact` flag through
  `callBacklinks`, `callJobsList`, `callJobsGet`, and `callJobsLogs` in
  `mcp/dispatch.ts`. Internal ingress and the `MEMEX_PUBLIC_READ_BODIES=1`
  opt-in are unchanged. Leak-shaped regression tests
  (`mcp_backlinks_jobs_redaction.test.ts`) assert the secret text is
  absent from public payloads and present on the internal path. Closes
  the primary `jobs_*` public-read residual previously tracked in
  `TODO.md`.

## [1.2.8] — 2026-05-31

### Removed
- **Telegram bridge removed — memex is now reached over MCP only.** The
  chat surface is gone; memex (the brain) is served at
  `GET /health` + `POST /mcp` via cloudflared for MCP clients (Claude
  Code, Cursor, …). Removed:
  - `deploy/telegram-bridge/` (the whole Python daemon, Dockerfile,
    entrypoint) and `deploy/helpers/` (the `memex` MCP-client CLI it
    shipped).
  - The `telegram-bridge` service from `docker-compose.yml` (only
    `memex` + `cloudflared` remain).
  - `telegram-bot-token` from `fetch-secrets.sh`, terraform
    (`secrets.tf`/`outputs.tf`), and the standalone public-bearer file
    (the bearer now lives only in `memex.env`, which memex reads to
    validate incoming MCP bearers).
  - The bearer-rotation script no longer restarts a bridge or delivers
    over Telegram — it rotates the secret + restarts memex.
  - Bridge/telegram tests deleted or updated; compose, dockerfile,
    fetch-secrets, and rotate test suites adjusted.

  cloudflared + `memex-public-bearer` + daily rotation are kept — that is
  the brain's authenticated public MCP ingress. The live
  `telegram-bot-token` secret is deleted out-of-band.
- **Telegram swept from bootstrap/init + all docs.** Dropped the
  `TELEGRAM_BOT_HANDLE` prompt/.env knob (`init.sh`) and the
  telegram-bridge EFS-dir seed (`bootstrap.sh`); rewrote README,
  ARCHITECTURE, AGENTS, llms.txt, SECURITY, CLAUDE, and all
  `deploy/memex/docs/*` + secrets/README to the MCP-only brain
  (answer synthesis is the MCP client's job, not memex's). Adjusted
  the init/bootstrap/compose/dockerfile/fetch-secrets/rotate test
  suites accordingly.

## [1.2.7] — 2026-05-31

### Removed
- **Terraform: dropped the `home_assistant_token` and `google_calendar`
  Secrets Manager resources** (and their `secret_arns` outputs) — the
  follow-up to the v1.2.6 life-integration teardown. The IAM read policy
  is prefix-scoped (`<secrets_prefix>/*`), so no IAM change was needed.
  The corresponding live secrets (`<prefix>/home-assistant-token`,
  `<prefix>/google-calendar`, plus the manually-created
  `<prefix>/gmail-oauth`) are deleted out-of-band; operators running
  `terraform apply` from an existing state should let the apply reconcile
  the two managed resources (or `terraform state rm` them).

## [1.2.6] — 2026-05-31

### Removed
- **All external "life" integrations stripped — memex is now a pure
  knowledge brain (Obsidian vault + code) reachable over MCP + Telegram
  chat.** Removed Home Assistant, Google Calendar, and Gmail entirely:
  - **memex**: deleted the `gcal` + `gmail` ingest recipes, their CLI
    commands (`memex gcal poll` / `memex gmail poll`), the `gmail.poll`/
    `gcal.poll` job handlers and source registrations in `serve.ts`.
  - **telegram-bridge**: dropped the `/today`, `/tomorrow`, `/week`,
    `/weather` commands and the `run_helper` shell-out path; the bot now
    answers only `/search`, `/ask`, `/health`, `/help`, and plain text
    via MCP + Bedrock RAG.
  - **helpers**: deleted `deploy/helpers/gcal` and `deploy/helpers/ha`
    (only the `memex` MCP client remains).
  - **host**: deleted the 6 gcal/gmail OAuth + poll scripts and the
    `memex-gcal-poll` / `memex-gmail-poll` systemd units (only
    `memex-rotate-bearer` remains).
  - **secrets**: `fetch-secrets.sh` no longer fetches
    `home-assistant-token` or `google-calendar`.
  - **docs**: README / ARCHITECTURE / AGENTS / llms.txt / bridge +
    secrets READMEs / CLAUDE-CODE updated to the brain-only surface;
    `GMAIL-GCAL-SETUP.md` deleted; `PRIVACY.md` rewritten (no Google
    OAuth — the stack reads only the operator's own vault + code).

  Terraform secret/IAM teardown and live AWS secret deletion follow
  separately (plan-gated).

## [1.2.5] — 2026-05-31

### Changed
- **telegram-bridge hot-reloads the memex bearer.** The bridge used to
  read `/run/secrets/memex-public-bearer.txt` once at startup, so the
  daily rotation left a brief window (between memex's restart and the
  bridge's) where in-flight calls 401'd. The serve loop now re-reads the
  bearer every 60s and swaps it in when it changes — non-fatal on a
  transient empty/missing file mid-rotation (keeps the current value and
  retries). No restart required to pick up a rotated bearer.

### Fixed
- **`fetch-secrets.sh` writes string secrets atomically** (temp file +
  `mv` rename) instead of an in-place `>` truncate-then-write. Closes the
  partial-write window the bearer hot-reload would otherwise expose: a
  reader now always sees a complete old-or-new file, never a truncated
  one mid-rotation.

## [1.2.4] — 2026-05-31

### Removed
- **Legacy REST routes deleted (MCP cleanup, Phase A.7).** The daemon's
  HTTP surface is now exactly two routes: `GET /health` + `POST /mcp`.
  The phase A.1–A.4 routes (`/index`, `/search`, `/backlinks`,
  `/friction`, `/pages/*`, `/graph/*`, `/entities/*`, `/timeline/*`,
  `/jobs/*`) and their eight handler modules are gone — every behaviour
  is reachable via `tools/call` on `/mcp`. The `memex` shell helper now
  talks to `/mcp` (sending `MEMEX_INTERNAL_TOKEN` for the `index` write
  tool); the telegram-bridge already used `/mcp`. Docs (`API.md`,
  `ARCHITECTURE.md`, `README.md`) updated to the two-route contract.

## [1.2.3] — 2026-05-31

### Security
- **`MEMEX_INTERNAL_TOKEN` now gates MCP write tools too.** The HTTP
  `/index` route already required the shared internal token, but the MCP
  JSON-RPC surface (`POST /mcp`) did not — a compromised sibling on the
  docker bridge could call `tools/call name=index` (or any write tool)
  with no token and poison the RAG corpus. Write tools
  (`FORBIDDEN_MCP_TOOLS_FROM_PUBLIC`) now require the token on the
  internal path; read tools (the bridge's `search`) and the public
  ingress are unaffected. No-op until the operator configures the token
  (legacy fallthrough, matching the HTTP gate). **Takes effect on the
  next EC2 deploy.**

## [1.2.2] — 2026-05-31

### Security
- **Pin `hashicorp/setup-terraform` to a commit SHA** (`dfe3c3f`, v4)
  instead of the moving `@v4` tag. If hashicorp's org were compromised,
  a re-tagged `v4` would otherwise flow into CI silently. First-party
  actions (`actions/checkout`, `actions/setup-python`, `oven-sh/setup-bun`)
  remain on major tags — lower risk, owner-canonical publishers.

## [1.2.1] — 2026-05-31

### Tests
- **MCP-ingress redaction regression test** locks the v1.2.0 vault-exfil
  fix. `tests/mcp_redaction.test.ts` calls `dispatchTool` directly and
  asserts that public ingress (`isPublic: true`) strips `markdown_body`
  / `body_snapshot` from `page_get` / `page_list` / `page_versions` /
  `entity_recall` while internal callers keep them, and that
  `MEMEX_PUBLIC_READ_BODIES=1` re-enables bodies. Uses a shared,
  seeded-once PGLite fixture (read-only assertions) so it stays fast.
- **MCP `search` redaction wiring test** completes the coverage.
  `tests/mcp_search_redaction.test.ts` stubs `hybridSearch` (no Bedrock,
  no pgvector) and asserts public ingress strips `content` and any
  non-allowlisted field from search hits while internal keeps them, plus
  the `MEMEX_PUBLIC_READ_BODIES=1` opt-in. All five public read tools are
  now regression-locked.

### CI
- **arm64 Bun job per-test timeout raised to 30s** (amd64 gate stays at
  the 5s default). The free arm64 canary runner is 3-4x slower; PGLite
  cold-init intermittently pushed individual tests past the default,
  producing false failures. The timeout is now arch-specific via the
  matrix.

## [1.2.0] — 2026-05-30

### Security
- **Public MCP ingress no longer leaks note bodies (vault-exfil fix).**
  The REST routes redacted note bodies for public callers, but the
  documented public ingress (`brain.<domain>/mcp`) goes through the MCP
  JSON-RPC layer, where `dispatchTool` ignored the request's public flag
  — so a holder of the public bearer could read entire note contents via
  `search` / `page_get` / `page_list` / `page_versions` / `entity_recall`.
  Redaction now applies on BOTH ingress paths through a shared
  `core/public_redaction.ts` allowlist (bypassed only with
  `MEMEX_PUBLIC_READ_BODIES=1`); internal callers are unaffected.

### Changed
- **Chat path simplified — `telegram-bridge` owns it end-to-end.**
  The legacy chat-agent container is removed from the stack.
  `telegram-bridge` calls memex over MCP JSON-RPC for retrieval and
  Bedrock Claude Haiku 4.5 (`eu.anthropic.claude-haiku-4-5-20251001-v1:0`)
  for synthesis. The bot still exposes the same eight slash commands
  (`/today`, `/tomorrow`, `/week`, `/weather`, `/search`, `/ask`,
  `/health`, `/help`); plain text is treated as `/ask`. Bearer auth
  for the bridge's MCP calls lives at
  `/run/secrets/memex-public-bearer.txt` (mode `0444`); the daily
  rotation timer restarts the bridge so it re-reads the new token.

### Removed
- **Legacy chat-agent container removed entirely.** The container, its
  build context, web-UI config, plugin manifest, gateway-token secret,
  and the 13 markdown skills under `deploy/skills/` are gone. The helper
  CLIs (`gcal`, `ha`, `memex`) moved into `deploy/helpers/` and ship
  into the bridge container instead. The chat-agent's post-onboard
  config script is deleted.
- **Morning-briefing script + systemd units removed entirely** (the
  former `archive/morning-briefing/` directory is deleted). They
  depended on the now-removed chat-agent container and stopped working
  at the cutover. The capability remains a future TODO (host-side
  composer → Bedrock Haiku → Telegram Bot API); nothing ships today.
- **Final chat-agent scrub.** The last narrative references to the
  removed chat agent are gone from source, tests, docs, and audit
  patterns. Guard tests were rewritten to assert the expected memex
  topology positively (e.g. the exact compose service set) instead of
  naming the removed component; legacy secret-prefix and
  terraform-address scrub patterns were dropped. One opaque value
  remains by design — the live RDS source-id key in
  `recipes/obsidian.ts`, deferred to the memory-store migration.

### Changed (docs)
- Refreshed `README.md`, `AGENTS.md`, `CONTRIBUTING.md`, `CLAUDE.md`,
  `ARCHITECTURE.md`, `TODO.md`, `llms.txt`, `deploy/secrets/README.md`,
  and `deploy/memex/docs/OPERATIONS.md` to match the current
  three-container stack. `CLAUDE.md`'s model-selection note now points
  at the bridge's `MEMEX_BRIDGE_LLM_MODEL` (the deleted post-onboard
  script is gone). `AGENTS.md` and `CONTRIBUTING.md` now require running
  the matching review skill/agent and the test→push→deploy→verify ship
  workflow for every change.

### Added
- **Phase A.5 — hot_memory + subagent durable ledger (schema only).**
  Lays the persistence rails for two future engines without exposing
  any MCP surface today: the dream-cycle consolidate phase that
  promotes short-term observations into `entity_facts`, and the
  sub-agent runner that crash-recovers an in-flight LLM tool loop
  from durable storage.

  Schema (migration 020_hot_memory.sql):
  * `hot_memory` -- short-term fact buffer with supersession.
    Columns: `entity_slug` (soft ref, no FK so a fact can land
    before the page does), `fact`, `effective_confidence REAL`
    bounded by `CHECK [0, 1]`, `session_id`, `source_slug`,
    `source_chunk_id`, `written_by`, `superseded_by BIGINT` (self
    ref, ON DELETE SET NULL), `written_at`.
  * Indexes: `(entity_slug, written_at DESC)` for the entity
    timeline read; partial `(session_id) WHERE session_id IS NOT
    NULL` for the per-session sweep; partial
    `(entity_slug, effective_confidence DESC) WHERE superseded_by
    IS NULL` -- the hot working set the consolidate phase reads.

  Schema (migration 021_subagent_ledger.sql):
  * `subagent_messages (id, job_id FK CASCADE, turn_num, role,
    content jsonb, written_at)` with `UNIQUE(job_id, turn_num)`
    so a worker retry replays the same INSERT idempotently and
    the first one wins. `role` constrained to `user | assistant
    | tool_result | system`.
  * `subagent_tool_executions (id, job_id FK CASCADE, turn_num,
    tool_name, input jsonb, output jsonb, status, error,
    started_at, finished_at)` with `status` constrained to
    `pending | succeeded | failed | skipped`. Supervisor inserts
    a `pending` row BEFORE invoking the tool; on crash, the
    resume sweep finds it via the partial index
    `(started_at) WHERE status = 'pending'` and decides retry vs
    skip.

  Core modules (no MCP surface in A.5):
  * `core/hot_memory.ts` -- `recordHotFact` (per-field length
    bounds on `fact` (4000), `session_id` / `source_chunk_id` /
    `written_by` (256) so the schema cannot accept multi-MB
    free-text rows), `supersedeHotFact` (rejects self-supersede;
    returns `{updated, superseded_by}` so the losing caller of a
    concurrent supersede sees the actual winner's id and can
    reconcile instead of retrying blindly), `listHotFacts`
    (default `unsuperseded_only: true`; supports `session_id`
    filter and `limit` 1-1000).
  * `core/subagent_ledger.ts` -- `appendMessage` (ON CONFLICT DO
    NOTHING on `(job_id, turn_num)` for replay-safe writes,
    falling back to a SELECT to return the pre-existing id; now
    THROWS if the SELECT also misses so callers never see a
    bogus `id: -1`; `content` capped at ~1 MB pre-`JSON.stringify`),
    `listMessages` (default LIMIT 1000, max 1000 -- prevents a
    50k-turn job from returning the whole ledger),
    `beginToolExecution` (writes the `pending` row; `tool_name`
    capped at 256 chars; `input` capped at ~1 MB),
    `finishToolExecution` (UPDATE guarded by `WHERE status =
    'pending'` so a duplicate finish never rewrites a terminal
    row; returns `{updated, current_status}` so the loser of a
    concurrent succeeded/failed race can see which terminal
    status actually stuck; `output` capped at ~1 MB; `error`
    truncated to ~1 MB), `listToolExecutions` (default LIMIT
    1000, max 1000).

  Security note (TODO.md, to be enforced by the A.6 MCP layer):
  `hot_memory.fact`, `subagent_messages.content`, and
  `subagent_tool_executions.input/output/error` carry free-text
  PII / OAuth-bearing tool inputs / model output. Future MCP
  read tools MUST go in the WRITE-tools allowlist
  (`FORBIDDEN_MCP_TOOLS_FROM_PUBLIC`) so the public-bearer never
  reaches them. Soft-ref `entity_slug` reads must return `404`
  uniformly on miss to prevent entity-existence enumeration.
  Crash-recovery sweeps for pending tool rows must bind to a
  `supervisor_run_id`/`worker_id` and refuse cross-worker
  retries -- otherwise an internal-token holder who writes a
  pending row turns the next sweep into a stored-command
  injection into the agent loop.

  Tests:
  * `tests/hot_memory.test.ts` -- 12 cases (insert + validation
    of slug grammar, fact non-empty, confidence range, source_slug
    grammar; supersede semantics including self-supersede rejection,
    idempotency, and a third-party race in which the losing caller
    reads back the winner's id via `superseded_by`; listHotFacts
    unsuperseded_only default, session_id filter, confidence DESC
    ordering).
  * `tests/subagent_ledger.test.ts` -- 9 cases (validation of
    job_id / turn_num / role; idempotent append on
    `(job_id, turn_num)`; ordering; `pending -> succeeded`
    lifecycle exposing `current_status`; refusal to finish a
    non-pending row with the surviving `current_status` reported
    back; rejection of `pending` as a finish status; CASCADE
    delete on `jobs` row removal for both ledger tables).

  Why schema-only: the consolidate behaviour for `hot_memory`
  and the supervisor runner that fills `subagent_*` both belong
  in later phases that will also ship their MCP surfaces. The
  schema lands now so the migration log moves forward in a
  single commit instead of fragmenting across later phases.

- **Phase A.4 — jobs DAG (fan-out + fan-in + idempotent submit) +
  jobs_* MCP surface.** Lays down the durable async-work substrate
  for future recipe pipelines and dream-cycle phases.

  Schema (migration 019_jobs_dag.sql):
  * `jobs` extended with `parent_job_id` (FK to jobs.id ON DELETE
    SET NULL), `depth INTEGER DEFAULT 0` (capped at 32 to prevent
    runaway recursion), `idempotency_key TEXT` (partial UNIQUE on
    `(kind, idempotency_key) WHERE NOT NULL`).
  * `job_children (parent_id, child_id, created_at)` -- denormalised
    edge table for fast "what children did I spawn?" lookups.
  * `child_done_inbox (parent_id, child_id, child_status,
    result_excerpt, completed_at, notified_at)` -- outbox-style
    write-once ledger. The parent's handler drains the inbox to
    detect fan-in completion. Partial index on
    `(parent_id, completed_at) WHERE notified_at IS NULL` for cheap
    unread-row lookups.

  Core module `core/jobs/dag.ts`:
  * `submitJob` -- idempotent on `(kind, idempotency_key)`. Parent
    -> child fan-out persists the edge in `job_children` and inherits
    depth+1. Refuses fan-out from a terminal parent (succeeded /
    failed / cancelled). Depth cap 32 with explicit error message.
  * `writeChildDoneInbox` -- write-once semantics: ON CONFLICT DO
    NOTHING so a worker retrying after a crash never overwrites the
    first observation of a terminal state. Excerpt truncation is
    UTF-8 byte-bounded (walks back from byte 8192 to the previous
    UTF-8 lead byte) so multi-byte glyphs at the boundary drop
    cleanly instead of corrupting into U+FFFD.
  * `drainDoneInbox` -- atomic read+mark-read with optional
    `mark_read: false` peek for tests.
  * `cancelJob` -- cascade BFS over pending descendants. Uses a
    visited Set so cyclic `job_children` rows (an idempotency-key
    replay can re-attach an existing job to a new parent) terminate
    instead of infinite-looping. Hard-capped at 10_000 descendants
    so a pathological tree fails fast rather than ballooning the
    `ANY($1::text[])` parameter.
  * `listJobs`, `getJob` -- read surface. `getJob` returns the row
    plus its children and unread inbox count.

  HTTP surface (`http/jobs_route.ts` + server.ts):
  * `POST /jobs/submit` -- internal-only (MEMEX_INTERNAL_TOKEN).
  * `POST /jobs/cancel` -- internal-only. Reason capped at 512
    chars.
  * `POST /jobs/list`, `/jobs/get`, `/jobs/logs` -- public+bearer.
    Public-ingress responses STRIP `payload`, `result`, and
    `last_error` (replaced with boolean `has_error` / `has_result`
    markers). These fields routinely carry sensitive context
    (URLs, OAuth excerpts, file paths from handler exceptions,
    Bedrock model IDs) -- internal callers still see them in full.
  * `/jobs/list` returns 400 on a malformed body so a bad caller
    cannot silently enumerate everything with an empty filter.

  MCP -- 5 new tools, total 20 -> 25:
  * `jobs_submit`, `jobs_cancel` (WRITE; added to
    FORBIDDEN_MCP_TOOLS_FROM_PUBLIC).
  * `jobs_list`, `jobs_get`, `jobs_logs` (READ).

  Test coverage:
  * `tests/jobs_dag.test.ts` (~37 assertions): idempotency on
    `(kind, key)`, fan-out depth inheritance + cap, terminal-parent
    refusal, inbox round-trip + peek + write-once semantics, UTF-8
    boundary truncation (4-byte emoji corpus crossing the 8192
    boundary), cascade cancel + cycle termination + 10k cap.
  * `tests/mcp.test.ts` updated for the 25-tool tools/list.
  * `tests/public_guard.test.ts` extended for the new forbidden /
    allowed sets.

  Self-review acted on across two parallel reviewers (code-reviewer +
  security-engineer): cycle BFS termination, UTF-8 split, write-once
  inbox, payload/result/last_error redaction on public reads, list
  400 on malformed body, reason length cap, depth-32 documentation,
  result type widened to `unknown` (handlers may legitimately return
  strings/arrays/numbers). Two MEDIUM findings deferred to TODO.md:
  CASCADE asymmetry on `parent_job_id` vs `job_children` /
  `child_done_inbox`; inbox-during-cancel race (needs SERIALIZABLE
  isolation or `FOR UPDATE` on frontier read).

  Suite: 228 pytest + 549 bun (+26 from Phase A.3) passing, audit +
  scrub clean.

- **Phase A.3 — timeline events + entity facts + entity MCP surface.**
  Two new append-only ledgers + five new MCP tools that together let
  the agent answer "what do I know about X?" from a single call.

  Schema (migrations 017 + 018):
  * `timeline_events` — (id, slug FK→pages CASCADE, occurred_at,
    event, source_chunk_id, written_at). Two indices (slug+time,
    occurred_at) plus a partial UNIQUE index on
    (slug, occurred_at, source_chunk_id) WHERE source_chunk_id IS
    NOT NULL — chunk-sourced events idempotent, manual events
    skip dedup deliberately.
  * `entity_facts` — (id, entity_slug soft-ref, fact, confidence
    REAL CHECK 0..1, source_slug, source_chunk_id, written_by,
    written_at). Indices on (entity_slug, written_at desc),
    (entity_slug, confidence desc), and (source_slug)
    WHERE source_slug IS NOT NULL. Partial UNIQUE on
    (entity_slug, fact, source_chunk_id) — same dedup semantics as
    timeline_events. Entity_slug is a SOFT reference (no FK) so a
    fact can be recorded about an entity before its page exists —
    a future dream-cycle "consolidate" phase will auto-stub pages
    once an entity hits N facts.

  Core modules:
  * `core/timeline.ts` — `addTimelineEvent` (idempotent with chunk_id,
    manual entries always insert), `getEntityTimeline` with
    since/until/limit window filters, ISO-string and Date input
    normalisation.
  * `core/facts.ts` — `addFact`, `listFacts` (confidence-desc default,
    recency-order opt-in, source_slug filter), and the headline
    aggregator `entityRecall(slug, opts)` that returns the page
    row + top-confidence facts + most-recent timeline events in
    parallel. Optional `redact_body` strips `markdown_body` from the
    returned page (forced on by the public HTTP path).

  HTTP routes (`http/entities_route.ts` + server.ts wiring):
  * `POST /entities/facts/add` — internal-only (MEMEX_INTERNAL_TOKEN).
  * `POST /timeline/add` — internal-only.
  * `POST /entities/facts` — public+bearer (READ).
  * `POST /entities/timeline` — public+bearer (READ).
  * `POST /entities/recall` — public+bearer (READ; redacts body on
    public ingress unless MEMEX_PUBLIC_READ_BODIES=1).

  MCP surface — 5 new tools, total 15 -> 20:
  * `add_fact`, `add_timeline_event` (WRITE — added to
    FORBIDDEN_MCP_TOOLS_FROM_PUBLIC).
  * `entity_facts`, `entity_timeline`, `entity_recall` (READ).

  Test coverage:
  * `tests/timeline.test.ts` (~25 assertions): FK on slug,
    ISO/Date normalisation, dedup with vs without chunk_id,
    since/until/limit windowing, CASCADE on page delete.
  * `tests/entity_facts.test.ts` (~30 assertions): soft-stub entity
    facts (no page required), confidence range, source_slug filter,
    confidence-vs-recency ordering, dedup semantics, entityRecall
    page=null path, combined page+facts+timeline result, limits,
    body redaction toggle.
  * `tests/mcp.test.ts` updated for the 20-tool tools/list contents.
  * `tests/public_guard.test.ts` extended for the new
    forbidden/allowed sets.

  Suite: 228 pytest + 523 bun (+29 from Phase A.2) passing, audit +
  scrub clean.

- **Phase A.2 — typed page-to-page links + graph MCP surface.** New
  migration `016_links_typed.sql` adds a `links` table keyed on
  `(source_slug, target_slug, type)` with confidence + optional
  source_chunk_id + write timestamp. Source has FK CASCADE on
  `pages.slug`; target is a soft reference (slug text, page may not
  yet exist). CHECK constraint pins `inferred_confidence` to `[0,1]`.
  Three indices: source+type, target+type, type.
- **`deploy/memex/src/core/links.ts`** — typed graph CRUD: `addLink`
  (idempotent on the unique tuple — re-asserting just updates
  confidence + chunk_id), `removeLink`, `graphNeighbors`
  (outbound/inbound/both with optional type filter),
  `graphQuery` (typed-relationship lookup; requires at least one of
  `source_slug` / `target_slug` so the table can't be drained in
  one call). `slugifyTarget` normalises loose names ("Alice Smith")
  into strict slugs ("alice-smith") with `/` namespace preservation
  and Unicode→ASCII collapse. `KNOWN_LINK_TYPES` catalogue: wikilink,
  mentions, works_at, attended, founded, advises, invested_in,
  knows, met, located_at, related_to, supersedes, contradicts.
  Application-layer enforced — extensible via `allowAdHocType`.
- **Deterministic `[[wikilink]]` extractor.** `extractWikilinks(body)`
  returns the distinct surface forms (`[[Alice|alias]]` → "Alice").
  `syncWikilinksForPage(slug, body)` replaces the wikilink-typed
  outbound edge set for `slug` in a single transaction — never
  touches other types and never touches edges from other sources.
  Zero LLM calls.
- **Auto-sync on page writes.** Both the HTTP `POST /pages/put` and
  `POST /pages/append` routes (and their MCP counterparts) now call
  `syncWikilinksForPage` after a successful changed write. Self-
  healing: if the sync throws after the page row is committed, the
  page write stands and a retry (or a future dream-cycle reconcile
  pass) rebuilds the edges — both writes are idempotent.
- **HTTP graph surface** (`deploy/memex/src/http/graph_route.ts`):
  `POST /graph/link` and `POST /graph/unlink` (internal-only,
  `MEMEX_INTERNAL_TOKEN`-gated), `POST /graph/neighbors` and
  `POST /graph/query` (open under the public-bearer).
- **MCP graph tools.** Four new tools: `link`, `unlink` (WRITE,
  added to `FORBIDDEN_MCP_TOOLS_FROM_PUBLIC`), `graph_neighbors`,
  `graph_query`. Total registered tool count rises from 11 → 15.
- **Test coverage.** New bun suite `tests/links.test.ts` (50
  assertions covering slugify rules, add/remove idempotency,
  confidence range, direction-filtered neighbors, typed graphQuery,
  wikilink extractor edge cases — pipes, dedup, malformed brackets,
  empty body — and the post-write sync semantics: replaces stale
  wikilink edges without touching other-typed or other-source
  links). `tests/mcp.test.ts` updated for the 15-tool registered
  surface. `tests/public_guard.test.ts` extended for the new
  forbidden list (link, unlink blocked; graph_neighbors,
  graph_query allowed).

- **Phase A.1 — DB-canonical page store.** New migration
  `015_pages.sql` adds two tables: `pages` (slug PK, type, title,
  `compiled_truth` jsonb, `markdown_body`, content_hash,
  created_at, updated_at, deleted_at) and `page_versions`
  (append-only edit history keyed by `(slug, version_n)`). Both
  are indexed for type filters + updated-desc listing + jsonb
  GIN search on compiled_truth.
- **`deploy/memex/src/core/pages.ts`** — CRUD module behind every
  write: `putPage` (idempotent upsert with auto-versioning),
  `appendPage`, `getPage`, `listPages`, `pageVersions`,
  `deletePage` (soft delete with tombstone version row). Strict
  slug validation (kebab-case + optional `/` namespaces, 1..256
  chars). Catalogue of well-known page types
  (`KNOWN_PAGE_TYPES`) with an `allowAdHocType` escape hatch.
- **HTTP page surface.** `deploy/memex/src/http/pages_route.ts`
  + new server routes: `POST /pages/put`, `POST /pages/append`,
  `POST /pages/delete` (all internal-only behind
  `MEMEX_INTERNAL_TOKEN` like `/index`), `GET /pages/get`,
  `POST /pages/list`, `GET /pages/versions`. Public-ingress
  reads return an allowlisted shape (slug/type/title/
  compiled_truth/content_hash/timestamps) unless
  `MEMEX_PUBLIC_READ_BODIES=1` — matches the existing `/search`
  redaction policy.
- **MCP page tools.** Six new tools exposed via the JSON-RPC
  MCP transport: `page_put`, `page_append`, `page_delete`,
  `page_get`, `page_list`, `page_versions`. Writes added to
  `FORBIDDEN_MCP_TOOLS_FROM_PUBLIC` so a public bearer-holder
  can never mutate the store. Total registered tool count
  rises from 5 → 11.
- **Test coverage.** New bun suite `tests/pages.test.ts`
  (35 assertions covering slug grammar, idempotent put, version
  history, append semantics, soft delete with tombstone, list
  filters, type validation, transactional integrity).
  `tests/public_guard.test.ts` extended for the new
  forbidden-list (page writes blocked; page reads allowed).
  `tests/mcp.test.ts` updated for the new tools/list contents.

### Removed
- **`obsidian-sync` container deleted.** Source tree
  (`deploy/obsidian-sync/`), compose service block, terraform
  secret (`<secrets_prefix>/obsidian-sync`), docker test class,
  the `obsidian` helper CLI, and the `deploy/skills/obsidian.md`
  skill file all gone. memex storage is being redesigned to be
  database-canonical (Postgres rows as the source of truth, not
  filesystem files); the bidirectional-Obsidian-sync sidecar no
  longer fits that direction. The legacy filesystem-watch recipe
  (`deploy/memex/src/recipes/obsidian.ts`) is kept in source for
  now and disabled by default (`MEMEX_VAULT_PATHS=/memory`, no
  external vault mount) — it will be replaced or removed in the
  next iteration's schema migration.
- `${EFS_MOUNT}/vault:` bind mounts removed from the `memex` and
  chat-agent service definitions in `deploy/docker-compose.yml`.
  EFS now carries only container runtime state (workspace, cron,
  devices, recipe-state, telegram-bridge state).

### Changed
- ARCHITECTURE.md, README.md, AGENTS.md updated to reflect the
  four-container topology (`memex` + chat agent + `telegram-bridge`
  + `cloudflared`).

## [1.1.0] — 2026-05-17

### Added
- **`telegram-bridge` container — always-on two-way Telegram surface.**
  Long-polls the Bot API independently of the chat agent so the bot keeps
  replying even when the chat-agent is restarting or stuck on a
  paired-device approval. Routes slash-commands (`/today`, `/tomorrow`,
  `/week`, `/weather`, `/search`, `/health`, `/help`, `/ask`) to the
  existing helpers, and answers free text with a RAG pipeline
  (`memex /search` for retrieval, Bedrock Nova Lite for synthesis).
  Falls back to retrieval-only when Bedrock is unavailable so the bot
  never goes silent. Runs as non-root uid 10001 with read-only fs,
  tmpfs `/tmp` (noexec), `cap_drop: ALL`, and `no-new-privileges`.
  Allowlisted by numeric chat id via `MEMEX_BRIDGE_ALLOWED_CHAT_IDS`;
  unbounded refusal floods are prevented by an LRU-capped + global
  rate-limited `RefusalGate`. Persists `last_update_id` to
  `${EFS_MOUNT}/telegram-bridge/state.json` so restarts don't replay
  history (atomic write + fsync(file+dir) + per-PID tmp suffix).
- **Internal-route shared-token gate (`MEMEX_INTERNAL_TOKEN`).** Plugs
  the `Cf-Connecting-Ip`-only trust hole on POST `/index` and POST
  `/friction`: any peer on the docker bridge must now present the
  shared bearer or get `401`. Provisioned via terraform
  `random_password` + Secrets Manager; fetched into the memex
  container's `memex.env` via `fetch-secrets.sh`. Legacy single-node
  installs upgrade cleanly — when the token is absent the server
  logs a one-shot warning and stays open.
- **Public `/search` + `/backlinks` body redaction.** Public-ingress
  responses now return only an allowlisted shape (`title`,
  `sourcePath`, `score`, `documentId`, `chunkId`, `kind`, `rank`) —
  any future body-ish field added to `SearchHit` cannot accidentally
  leak. Bodies opt back in via `MEMEX_PUBLIC_READ_BODIES=1` for
  operators who want full hit content over Cloudflare. Generic
  `"search backend error"` / `"backlinks backend error"` on public
  500s so SQL paths and table names no longer leak via exception
  text. Internal callers still see full bodies + raw error text.
- **Bedrock RAG hardening in the bridge.** `_scrub_tags` now covers
  `<note>`, `<user_question>`, `<system>`, `<instruction>`,
  `<assistant>`, `<user>`, `<tool>`, `[INST]`/`[/INST]`, and `</s>`
  role markers — plus a unicode strip (NUL / ZWJ / BOM) before the
  regex so invisible-char bypasses fail too. `_defang_urls` wraps
  every `http(s)://...` token in backticks before sending to
  Telegram so the operator never accidentally taps a URL the model
  hallucinated from a poisoned Gmail/GCal note. Bedrock request
  body now passed via `--body fileb://<mkstemp>` instead of argv —
  prompts + retrieved notes no longer appear in `/proc/<pid>/cmdline`
  to any uid on the host. Per-call request + response tmpfiles via
  `tempfile.mkstemp()`, both unlinked in the same `finally` so a
  symlink-attack on a shared `/tmp` is impossible.
- **Standalone systemd morning-briefing path** (`memex-morning-briefing.timer`)
  that composes the daily briefing from helpers and posts via
  Telegram Bot API directly. Bypasses the chat-agent gateway pairing
  scope entirely so the 07:00 Europe/Berlin delivery is no longer
  blocked on chat-UI approvals.
- **multi-arch CI matrix.** `bun-tests` job now runs on both
  `ubuntu-latest` (amd64) and `ubuntu-24.04-arm` (arm64, production
  target). An arm64-only Bun runtime regression or a transitive
  native module without an arm64 wheel now fails CI before reaching
  the EC2 deploy.
- **Operator-private PII overlay** (`scripts/lib/pii-patterns.local.txt`
  — gitignored) lists concrete identifiers (email, chat id, account
  id, instance id, RDS endpoint, domain, GitHub handle) so any
  future regression of an operator identifier gets caught by
  `make audit` even if the generic patterns wouldn't have.
- **Upstream `pii-patterns.txt` extensions** — RDS / ElastiCache /
  Redshift hostname shape + GitHub `<owner>/<repo>` reference; both
  catch the shapes the operator-private overlay would otherwise be
  alone in catching.

### Changed
- **IAM Bedrock policy tightened** — adds an explicit Deny against
  direct `bedrock:InvokeModel` outside `var.bedrock_allowed_regions`
  (default `eu-west-1`, `eu-central-1`, `eu-north-1`, `us-east-1`).
  Profile-routed invocations (CalledVia=bedrock) keep working;
  direct invocations of `nova-pro` / `haiku-4-5` in non-allowlisted
  regions are blocked, capping the cost-burn radius of a
  compromised container.
- **memex container drops root.** Dockerfile now runs as the alpine
  `bun` user (uid 1000) with `chown -R bun:bun /app`; the EFS
  bind-mounts are already chowned 1000:1000 by `scripts/bootstrap.sh`.
  Combined with `cap_drop: ALL` + `no-new-privileges`, an RCE in
  the Bun process no longer lands as root with full read of the
  host AWS profile dir.
- **Chat-agent entrypoint accepts a Telegram-disable flag**
  (default in compose) and removes the `channels.telegram` block
  before booting. Prevents the 409 Conflict that occurs when two
  consumers race for the same bot's `getUpdates` long-poll — the
  `telegram-bridge` container now owns the bot exclusively by
  default.
- **`fetch-secrets.sh` permission model fixed for non-root
  containers.** `.secrets/` dir → `0711` (root reads+lists, others
  descend only); `telegram-bot-token.txt` → `0444` so uid 10001
  inside the bridge can read it; `fetch_text` helper takes an
  optional 3rd `mode` arg. `bootstrap.sh` now chmods
  `/home/ec2-user/.aws/config` to `0644` (no secret in that file)
  so the bridge can read the AWS profile pointing at IMDS.
- **`bootstrap.sh` seeds `${EFS_MOUNT}/telegram-bridge` dir** with
  ownership `10001:10001` so the bridge can write its state file
  on first boot without an out-of-band fix.
- **CI shellcheck job** now lints `deploy/telegram-bridge/entrypoint.sh`
  so a syntax regression in the bridge launcher fails CI rather
  than at boot.
- **`bridge _parse_allowed_chat_ids` rejects non-ASCII digits.**
  Python's `int()` accepts Arabic-Indic and full-width digits
  (`int("١٢٣") == 123`), which would silently allowlist a chat id
  the operator did not visually intend. Now requires `part.isascii()`
  before parsing. Negative ids (Telegram supergroups) still work.

### Fixed
- **RDS master password rotation** (May-17, 2026 incident). Rotated
  via `aws rds modify-db-instance --master-user-password
  --apply-immediately` after a brief leak during the May-16
  PGLite→RDS debug session. Documented gotcha: the secret stores a
  full postgres URL, so the rotation password must be URL-safe
  (exclude `?`, `#`, `&`, `:`, `=`, `+`, `%`) OR URL-encoded before
  being written back to `<secrets_prefix>/memex-postgres-url`. The
  TODO entry now spells out the safe `get-random-password
  --exclude-characters` invocation.
- **Connection-pool leak when Telegram returns 409 Conflict.** The
  bridge's `HTTPError` handler now drains the response body before
  raising, so an open-but-unread connection no longer accumulates
  on some urllib versions.

### Security
- Three parallel security reviews (security-engineer x2 +
  code-reviewer + devops-automator + ai-engineer + bug-hunter)
  acted on across two passes: **1 CRITICAL** (internal-auth gate),
  **5 HIGH** (memex non-root, IAM region-tightening, body
  redaction, RAG injection, RefusalGate DoS bound), **8 MEDIUM**
  (SSRF guard on `MEMEX_URL`, prompt-injection delimiter scrub,
  fsync on state file, signal handler ordering, max-hits clamp
  warning, `tmpfs /tmp:noexec`, public-vs-internal rate-limit
  split, scrubber unicode strip), and **4 LOW** fixed in-session
  before push.
- Live attack-surface verification: peer→`/index` request without
  the `MEMEX_INTERNAL_TOKEN` shared bearer returns `401` from the
  running memex container. The defensive change is provably active
  in production, not just in tests.

### Tests
- `+1` Bun test file (`internal_auth_and_redaction.test.ts`, 16
  assertions covering the new internal-auth gate + allowlist-based
  redaction including a regression guard for future SearchHit
  fields).
- `+45` pytest assertions across `test_telegram_bridge.py` (URL
  validator, tag-scrub invisible/NUL/role-marker bypasses, ASCII
  chat-id guard, Bedrock retry classifier, RefusalGate LRU + global
  rate limit, fsync-based State.save, `_handle_rag → _defang_urls`
  wiring regression).
- `+4` pytest assertions across `test_fetch_secrets_sh.py` +
  `test_bootstrap_sh.py` (per-file mode arg, 0711 dir mode, 0644
  AWS config mode, EFS bridge dir seeding).
- `+1` compose hardening parametrize entry for `telegram-bridge`.
- `+1` Dockerfile structural class for the bridge image.
- Full suite at v1.1.0: **244 pytest + 434 bun green, audit + scrub
  clean, terraform fmt + validate clean.**

## [1.0.0] — 2026-05-11

### Added
- Initial public release as `memex`.
- `memex` knowledge brain (Bun + Postgres + pgvector + MCP server,
  with PGLite available as a dev-only fallback) — hybrid search,
  entity graph, and graph-only code chunkers for TS / Python.
- Chat-agent surface (Telegram + web UI via
  Cloudflare Tunnel).
- `obsidian-sync` sidecar for bidirectional Obsidian vault sync.
- `cloudflared` sidecar for public HTTPS ingress.
- Terraform stack (VPC, EFS, RDS Postgres, EC2, Cloudflare Tunnel,
  Secrets Manager, CloudTrail, CloudWatch logs).
- Interactive `make init` bootstrap that writes `.env`,
  `terraform/terraform.tfvars`, and `terraform/backend.hcl`.
- `make audit` PII gate — fails if any maintainer-private identifier
  leaks into a tracked file.
- Bash unit tests for `init.sh` and `audit.sh`.
- MIT License, SECURITY policy, contributor guide, GitHub Actions CI.

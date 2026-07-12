# TODO — memex-stack

Forward-looking work that is intentionally deferred. Items already
shipped live in [`CHANGELOG.md`](./CHANGELOG.md); items rejected as
out-of-scope live under "NOT in scope" in the design doc that
introduces them.

---

## Chronicle follow-ups (2026-07-12 session, deferred small tail)

- **Chronicle CLI read commands.** `chronicle_day`/`chronicle_since`/
  `chronicle_last_seen`/`ontology_get`/`volunteer_chronicle` exist as MCP ops
  only; `memex day <date>`-style CLI wrappers deferred (MCP-first surface;
  add when terminal ergonomics matter). `memex eval chronicle` and
  `capture --type diary/event` DID land.
- **Ontology transaction-time history.** `valid_from`/`valid_until` model
  valid time; a superseded row's update is not itself versioned
  (`recorded_from`/`recorded_until`). Append-only revisions would allow
  "what did the brain believe last Tuesday" queries. Deliberately skipped —
  day-granularity valid time covers the agent use cases; revisit if a
  calibration/audit need appears.
- **`export.ts` containment via realpath.** Export path containment uses a
  lexical `resolve().startsWith` check; the shared realpath-both-sides guard
  would also defuse symlinked export targets. Low risk (operator-only
  surface), small change.
- **Empty-env hardening tail.** `MEMEX_PATTERNS_REFLECTION_PREFIX` (empty →
  empty prefix after trim) and `MEMEX_HOST`/`MEMEX_BRAIN_PORT` CLI reads
  tolerate `""` oddly; same class as the fixed AWS_REGION reads, lower blast
  radius.
- **Chronicle boost floor.** The temporal-mode chronicle lift rides the
  existing post-fusion multiplier chain without a separate floor threshold;
  memex's arm-survival gating is the equivalent guard today. If ranking
  regressions surface on temporal queries, add a floor before the multiplier.

---

## Full-recompare actionable gaps (2026-07-07 session 2, 16-subsystem workflow)

Dispositioned 2026-07-07 (session 2, continued). One shipped; the DB-machinery
pair genuinely needs a live-RDS session; two reasoned-defers/keeps:

- **[DONE — v1.93.0] frontmatter→typed-edge `related_to`.** Added
  `related`/`see_also` → `related_to` (outgoing) as an ANY-page-type bucket in
  `typed-links.ts` (per-type rules win on collision). Symmetric-safe (A→B and B→A
  are distinct rows — no single-origin breach). `investors→invested_in` and
  `source`/`sources` DELIBERATELY not ported: investors re-derives the person-side
  `invested_in` triple from a second origin (breaks memex's single-origin
  invariant, same reason `key_people` is skipped); `source` is often a provenance
  string, not a slug. Test `typed_links.test.ts` (8/8). Default-OFF feature.
- **[DONE — v1.95.0, full build (operator asked 2026-07-07)] HNSW index
  lifecycle manager.** Built the entire HNSW index-lifecycle surface in
  `core/vector-index.ts`, on memex's `Engine` (query/exec/transaction; CONCURRENTLY routes through
  `engine.exec` = simple-protocol single statement) and memex's real index
  (`embeddings_vector_idx` on `embeddings(vector)`, mig 001) + RDS (not Supabase):
  `checkActiveBuild`, `dropZombieIndexes`, `dropAndRebuild` (temp CONCURRENTLY
  build → DROP+RENAME atomic swap; old index intact on failure), `monitorBuild`,
  `isExternalMaintenanceBuild`. Exposed via `memex hnsw <status|sweep|rebuild>`
  (commands/hnsw.ts) + an opt-in startup zombie-sweep (`MEMEX_HNSW_ZOMBIE_SWEEP=1`,
  default-OFF — deliberately not an always-on connect sweep,
  per memex's no-surprise-mutation posture; `doctor`'s invalid-indexes check
  already surfaces the condition). CONCURRENTLY rebuild verified against LIVE RDS.
  Tests `vector_index.test.ts` (PGLite guards + classifier; the real Postgres path
  verified on prod). Supersedes the v1.94.0 detection-only slice below.

- **[DONE — v1.94.0, detection slice] HNSW / invalid-index doctor check.**
  The real risk an HNSW index-lifecycle manager guards against is a failed/interrupted
  index build (a killed `CREATE INDEX CONCURRENTLY`, or an OOM mid-build — memex has
  OOM history) leaving `indisvalid=false`: Postgres keeps the index but never uses
  it, so the vector arm silently seq-scans with NO error. Closed with a **read-only
  `invalid-indexes` doctor check** (`doctor-ops.ts checkInvalidIndexes`, wired into
  both the MCP + CLI doctor registries, category `ops`) that flips ok:false and
  names the index; recovery is a one-liner `REINDEX INDEX CONCURRENTLY <name>`
  (online, no write lock). Tests `doctor_ops.test.ts` (valid + simulated-invalid).
  Deliberately did NOT build the full dropAndRebuild/monitorBuild/temp+
  RENAME module — over-engineering for a single small RDS where REINDEX recovers in
  one command; and NOT the `CREATE INDEX CONCURRENTLY` migration-runner escape hatch
  (index rebuild is a runtime maintenance op, not a migration — so PGLite never has
  to run CONCURRENTLY, and the runner's most sensitive path stays untouched). The
  runner escape hatch remains available to build IF a future *migration* ever needs
  a concurrent index on a large live corpus — deferred, not needed now (4.4k chunks,
  index builds instant).
- **[DEFER — reasoned] schema-verify full column-drift.** memex already has
  migration-version drift detection (`doctor-ops.ts checkSchemaVersion`: applied
  MAX(id) vs discovered files), which catches the realistic failure (unapplied
  migrations). A full column-level drift detector needs an expected-schema artifact
  memex doesn't maintain (it would derive from a consolidated CREATE artifact,
  ~72KB) — high cost, low marginal value on a single-app-managed RDS
  where hand-schema-drift can't happen.
- **[KEEP — no change] `resolveRequestedScope` in `auth-info.ts`.** The OAuth
  adversarial re-audit's ONLY finding, and it is NOT a trap: it is the correct,
  documented, tested single resolver for a per-call `source_id`/`all_sources`
  param — with the IDOR guard baked in (a tenant can only name a source in its
  grant; trusted-local keys on `auth === undefined`, not `isPublic`). memex exposes
  no such param today, so it is inert — but it is exactly what a future per-call
  scope param SHOULD route through, not code to delete. Retained intentionally.
  (memex was at parity or AHEAD on every other security axis — closes IDOR/DCR/array-
  injection leaks.)

**Two deviations surfaced (operator decision, NOT changed):**
- `stats` + `jobs_list/get/logs` reachable from the public bearer (an
  alternative would gate them behind `admin`). DELIBERATE in memex (explicit tests + jobs-metadata redaction). A flip
  to forbid was built then REVERTED (would break a thin-client status reader +
  needs 2 tests rewritten). Decide: keep (thin-client) or gate behind `admin`.
- Notability keep-all on the facts write path (an alternative drops LOW / defers
  MEDIUM). memex keeps all + ranks by notability — arguably better for a
  remember-everything brain. Left as deviation.

Lower-value/skip: cross-slug dedup (`findDuplicatePage` — memex ingest isn't
overlapping vault roots), background-work drain (PGLite-only; prod is RDS Postgres),
runtime/wall-clock budget cap, `import` resumable checkpoint.

## Prod-audit findings (2026-07-07 session 2)

A live prod audit (SSM → container + RDS) found prod **healthy and in sync**:
container healthy/running/restarts=0 (OOM resolved, cycle rss 122MB), doctor all
green (brain 12/0, ops 7/0), migrations prod hi=94 == code 094, 0 NULL-source
docs, 8 sources incl. timur/zukhra, no errors in 24h logs. Follow-ups surfaced:

- **[DONE 2026-07-10] Prod git is missing recent tags.** `git -C /opt/memex
  fetch --tags` run on the live host; `git describe` now reports `v1.98.0`.
- **[DONE 2026-07-10] Cycle soft warns — investigated, one real bug fixed.**
  `lint=warn` is accurate data reporting (700/712 vault docs lack `tags:`
  frontmatter, 89-91 lack title/created/updated) — working as intended, the
  warn IS the report; clear it by fixing vault frontmatter, not code.
  `orphans-purge=warn` was a real false-positive bug: the phase disk-probed
  EVERY `documents.source_path` including virtual rows (`page://`,
  `page-truth://`, `gmail:`, `gcal:`) that never exist on disk → perpetual
  flags. Fixed: only absolute paths are probed (orphans-purge.ts).
- **[INFO] `source_grants=0`.** The timur/zukhra tenants hold no federated-read
  grant, so each reads only its own source. Confirm this is intended isolation vs
  a pending operator federate SQL (agent prod auth-writes are guardrail-blocked;
  operator runs the 1-line grant if federation is wanted).
- **[LOW 2026-07-10, codex P2] Relative-path docs skip orphan disk-probe.**
  `memex index foo.ts` persists the caller's relative source_path unchanged;
  the orphans-purge disk probe now only checks absolute paths, so a vanished
  relative-path file is never flagged. Right fix = normalize to absolute at
  ingest (indexFile/callIndex), not in the probe. Rare (operator ingests use
  absolute paths / schemes); do when touching the ingest path.
- **[LOW 2026-07-10, codex P2] Legitimately-empty code files still produce
  zero-chunk docs** (fallback requires non-blank text), so a tracked empty
  file keeps `orphans-purge=warn` alive. Consider excluding 0-byte sources at
  sweep time or exempting empty-content docs from the zero-chunk flag. None
  exist on prod today.
- **[LOW 2026-07-10, codex P2] Code sweep is not chunker-version-aware.**
  `sweepCodeRoots` mtime-skips unchanged files, so a CODE_CHUNKER_VERSION bump
  drains only via a manual `reindex --source code --all`. If bumps become
  regular, teach the sweep to force files whose doc rows are version-stale
  (listStaleChunkerDocIds ∩ walked paths, like the vault sweep's
  forceStaleChunker).
- **[LOW — re-scoped 2026-07-10] Typecheck debt is toolchain drift, not 2 files.**
  `bunx tsc --noEmit` now reports 56 errors across src+tests — `typescript` is
  pinned `^5.6.0` but bunx resolves 5.9.3, and `@types/bun: latest` floats
  (Dirent<NonSharedBuffer>, `toWellFormed` wants lib es2024, ParameterOrJSON).
  Runtime unaffected (bun strips types; CI has no tsc gate). The two
  real-looking smells were hand-verified false alarms: `subagent_ledger.ts:225`
  is a deliberate runtime guard against untyped callers; `jobs/dag.ts:273` is
  index-access strictness with correct bounds. Close by pinning typescript +
  bumping tsconfig lib to es2024 in one hygiene pass — not urgent.

---

## Test coverage follow-ups (2026-07-06)

- **Reranker candidate-window promotion — functional test.** `MEMEX_RERANK_WINDOW`
  widens the two-pass rerank window so a hit fused below `k` can be promoted into
  the returned set. The cache-signature plumbing is tested; the promotion itself
  is only verified by review. A functional test needs `hybridSearch` with both
  the query embedder AND `two-pass.rerank` stubbed (via `mock.module`) to inject
  a permutation that lifts an item originally at rank >k, <window into the top-k.
- **DB pool/statement-timeout factory branch.** `positiveIntEnv` +
  `MEMEX_PG_POOL_MAX` / `MEMEX_PG_STATEMENT_TIMEOUT_MS` wiring in
  `engine/factory.ts` has no direct test (trivial env-parse mirroring the
  existing `QUERY_EMBED_TIMEOUT_MS` pattern; would assert garbage → default).

## Deferred by stack — future upgrade paths (2026-07-04)

Capabilities memex deliberately does NOT
build today, because each is blocked by a stack constraint or a standing
architecture decision — NOT because they were overlooked. Documented here with
the exact condition that would unblock each, so a future session neither
re-litigates the decision nor accidentally builds it. Everything else that was
buildable has been shipped (see the parity waves in CHANGELOG).

| Capability | Why deferred (blocker) | What would unblock it |
|---|---|---|
| **Cross-encoder reranker tier** | Bedrock exposes no rerank API. A true cross-encoder needs a rerank model memex can't call under the AWS-Bedrock-only rule. | AWS shipping a Bedrock rerank model, OR relaxing the AWS/Anthropic-only rule to allow an external reranker. Today substituted by a paid Haiku index-reorder + Sonnet graph-rerank (both default-OFF) — capability present, mechanism different. |
| **Autocut** (score-cliff result sizing) | Depends on a real cross-encoder score cliff; RRF has only mechanical decay, no trustworthy separatrix. | Falls out for free once a cross-encoder tier exists (above). Substitute today: intent-capped adaptive-return. |
| **Image / multimodal + `search_by_image`** | Titan Text Embeddings v2 is text-only (1024-dim); the AWS-only stack has no multimodal embedder wired, and there is no image-asset substrate. | **AWS-buildable** — Titan Multimodal Embeddings G1 (native Bedrock, no rule change) + an image-asset page substrate + an image-embedding column + `search_by_image`. Worth doing IF an image corpus ever exists; no rule reversal needed. |
| **Anthropic-only constraint itself** | Operator decision (2026-07-01): only Anthropic via Bedrock (Haiku/Sonnet) + Titan embeddings. Any feature needing a non-Anthropic model (external embedder like ZeroEntropy/Voyage, external reranker) is out. | An explicit operator reversal of the Anthropic-only rule. Firm today. |
| **Minion / server-side subagent runtime** | memex has no multi-agent server runtime by design; it implements minion loops as a SINGLE Sonnet/Haiku call or onto memex's own durable job queue. | Only if a server-side multi-agent runtime is ever wanted (large architectural add). Not planned — the single-call ports cover the capability. |
| **Schema-pack "cathedral"** (9 MCP ops + `schema-suggest` phase: typed-schema authoring, lint, graph, mutations) | A whole typed-schema-authoring subsystem memex deliberately skipped; a personal AWS brain uses a fixed type list, so ~0 payoff for a large surface. | Only if memex ever exposes operator-authored schema packs to multiple tenants. Deferred by scope, not blocked by stack. |
| **File / S3 / raw-KV substrate + storage tiering** | memex is DB-canonical by design (RDS + EFS) rather than filesystem-first (a local markdown vault). | A decision to add an object-store tier (S3) for large/binary assets. Not needed for the DB-canonical model. |
| **git-sync / federation / federated reads** | Operator deferred (future, not now) — needs a sync/federation model memex hasn't provisioned. | Explicit go on multi-brain federation. Deferred. |
| **`skillopt` self-optimizing skill phase** | Adjacent to a skill-distribution subsystem memex doesn't run; default-OFF paid feature not ported. | Only if the skill subsystem grows a self-optimization loop. Low priority. |

Value-1 items intentionally left unbuilt (zero consumer on a text-only brain):
`image_of` `![[img]]` edges; calibration SVG charts / pattern drill-down admin.

---

## Deferred (v1.81 line-by-line review, 2026-07-06)

- **takes-fence.ts:415** — upsertTakeRow/supersedeRow re-render the fence from
  parseTakesFence output only, so a row the parser SKIPS (unknown kind,
  non-numeric weight, dup row_num, <6 cells) is silently dropped from the
  markdown source-of-truth. Preserve unparsed rows verbatim before deferring
  to the parser. (Low blast radius: operator hasn't authored fence takes yet.)
- **nudge.ts** — nudgeOnTakeCommit / evaluateAndFireNudge (mig-074) have NO
  production caller; the take-commit bias nudge is dead until wired to a commit
  hook. Default-off feature, no behavior today.
- **takes-canon.ts:125 / takes-fence.ts:395 (LOW)** — resolveTake source guard
  joins documents.id=source_ref (fence takes store a page slug there, not a doc
  id); renderTakesFence rounds resolvedValue via formatWeight (2 dp) — corrupts
  fractional resolution values. Fix when fence-authored takes go live.
- **conversation-facts-backfill.ts:155 (LOW)** — worth-gate `gate.kept.has(p.slug)`
  keys on slug only; two same-slug pages in different sources collide in the
  gate. Use a (slug, source_id) composite ref.
- **volunteer.ts:174 (LOW)** — priorContext suppression uses substring
  `includes(p.slug)`, so a short slug that is a substring of a longer one is
  wrongly suppressed. Match on token boundaries.
- **contradictions.ts:316 (LOW)** — Stream-3 orphan take coalesces missing doc
  tenant to 'default'; a foreign-tenant take could pair. Skip orphans instead.
- **search-stats.ts:267 (LOW)** — runSearchTune JSON prints applied commands
  before they run; label as "proposed" in report-only mode.

## LOW backlog (v1.81 cycle-3 verify, 2026-07-06)

- **mig 085 entity_facts_superseded_by_fkey has no ON DELETE action** — a
  hard-delete that removes a fact still referenced by a tombstoned row's
  superseded_by now FK-violates where it succeeded pre-085. Add ON DELETE SET
  NULL (or CASCADE) when a purge path exercises it.
- **postgres.ts onnotice is a no-op** — migration NOTICEs (082 RLS trigger
  skipped, 092 repaired/skipped counts) are invisible on live RDS deploys.
  Route NOTICE to the migrate log so the operator can confirm 082/092 outcomes.
- **`MEMEX_TENANT_FAIL_CLOSED=1` must be verified/set on the live container**
  before handing out any second-tenant credential — a scopeless client
  otherwise reads whole-brain and writes 'default'. (Action item, not code:
  confirm on SSO restore.)

## LOW backlog (v1.81.0 parity-build review, 2026-07-06)

- **Budget caps are opt-in**: `oauth_clients.budget_usd_per_day` defaults NULL
  (unlimited); neither register-client nor the admin API sets one at mint.
  Consider a conservative default for new clients.
- **Spend settle trusts the handler's self-reported spentUsd**; error paths
  release the reservation without logging actuals — the daily ledger
  undercounts on failures. Settle from the tracker's actuals instead.
- **Cf-Connecting-Ip is trusted for rate-limit keys and public/internal
  classification** (ingest + public_guard). Safe only while the origin is
  reachable exclusively via the Cloudflare tunnel — the invariant is
  documented, not enforced.
- **/ingest limiter consumes a token before auth** — unauthenticated 401s can
  drain a shared-NAT bucket. Key on client_id post-auth.
- **set_take_status is not holder-gated** (write-source-scoped only): a token
  whose allow-list hides a take can still accept/reject it by key.
- **gradeTakes evidence for NULL-source takes runs an unscoped hybrid search**
  (operator fence/think takes) — judge sees whole-corpus text; reasoning rows
  are operator-visible only, so impact is contained.
- **Admin-minted PATs are tenant-unscoped by default** (Agents page /api-keys)
  — matches CLI default; mint with permissions.source_id when the Agents UI
  grows a tenant picker.
- **take-commit nudge module (mig 074) wired only to set_take_status accepts**
  via fence sync; fence-authored commits are not yet nudged —
  broaden when operator-authored takes become the primary path.

## LOW backlog (PAT port review, 2026-07-05)

- **`permissions.takes_holders` is stored but not yet enforced at read time**
  — per-token takes visibility is not enforced; memex currently gates
  takes ops operator-only, so the allow-list is dormant. Add the enforcement
  half if takes ever open to tenant tokens.
- **Legacy PAT verify grandfathers `['read','write','admin']`** ignoring the
  stored `scopes` column. Harmless while no MCP op
  requires `admin` and operator-only tools gate on `authInfo === undefined`;
  tighten both together if that changes.
- **`auth create` name uniqueness is check-then-insert** (no partial unique
  index on active names). Racy only
  under concurrent operator CLIs; add `CREATE UNIQUE INDEX ... ON
  access_tokens(name) WHERE revoked_at IS NULL` if it ever matters.
- **No `auth test <url> --token` command** (remote MCP
  smoke test; we verify via curl in the ship loop instead).
- **/mcp bearer verification does 2 unauthenticated hash lookups per garbage
  bearer** with no per-IP limiter (unlike /token, /register). Indexed lookups;
  add a limiter if abuse shows up in mcp_request_log.
- **Verifier DB outage surfaces as 401** (fall-through) rather than a
  500 — cosmetic error-path choice.

## LOW backlog (v1.78 review notes)

- **`insights.ts` `computeDriftScore` cosine length-mismatch → max drift.** A
  mixed-dimension embedding ledger (after a dim migration) would read mismatched
  pairs as drift_score 1. Harmless while the embedding dim is uniform; guard if
  `MEMEX_EMBED_DIM` is ever changed on a live corpus.
- **`remediation.ts` per-run budget: over-cap action `continue`s** (a cheaper
  later action can still enqueue) rather than stopping, and the "already pending"
  heuristic can double-count `est_usd`. Queue `ON CONFLICT` prevents real dup
  rows; refine to a hard stop + de-dup on est if remediation is used heavily.
- **`enrich_thin` / `drift` idempotency is a per-tenant cooldown, not per-item.**
  A 12h phase cooldown bounds repeated paid spend, but the fully-idempotent form
  is a per-item last-processed watermark (a small migration) so a resolved item
  is never re-judged even within the window.

## LOW backlog (v1.76 review notes)

- **`memex export` frontmatter round-trip is lossy.** The emitted header carries
  only `title` + `type`, and the title `needsQuote` check omits newlines, a
  leading `-`/`?`-space, and bare `true`/`false`/`null`/numeric titles — those
  don't re-parse to the same string/type. Rare; the export is a
  backup/portability dump, not a lossless serializer. Widen the quoting rule (or
  emit the full frontmatter) if round-trip fidelity ever matters.

---

## 2026-07-02 — full-parity + tiers session (v1.57 → v1.72) DONE

Shipped + live-verified this session (see CHANGELOG for each):
- Multi-tenant read+write isolation complete (leak-close, contract harness,
  destructive-op scoping, write-time canonicalizer, links/tags source_id keys
  mig 059, write fail-closed, gazetteer scoping).
- Only-Anthropic-via-Bedrock (Nova removed → Haiku utility, Sonnet paid).
- All paid slices live + a bug fixed (empty `MEMEX_FACTS_MODEL` refused spend).
- **Contextual retrieval complete**: deterministic wrapper + `reindex --contextual`
  whole-corpus re-embed + PAID per-chunk Haiku LLM tier (`MEMEX_CONTEXTUAL_LLM`) +
  **Bedrock prompt caching** (~3x cheaper re-embed).
- **Quality/cost tiers** documented (Free/Balanced/Max); `MEMEX_RERANK` allowlisted;
  `init.sh` defaults to Max; operator's prod on Balanced (`GRAPH_RERANK=0`+`RERANK=1`).
- Monthly cost forecast (~$80/mo Balanced prod; ~$141 Max). CI time-bomb fixed.

Remaining = **operator-gated only**: (a) live 2-tenant auth smoke (personal howto in
the maintainer vault; autonomous prod-mutation is classifier-blocked — hands-on);
(b) composite-PK slug drop (Codex: DEFER, use tenant slug prefixes); (c) terraform
apply only from the ops dir. No open build work.

---

## 2026-07-03 — brain-only parity backlog (deep compare)

A 7-subsystem code-level review of memex (v1.72),
scoped to the retrieval brain only. Memex's core is solid and wins in
several places (durable job queue, contextual retrieval, version history,
public redaction, tenant write scoping, stronger slug cascade). The genuine
gaps below are worth closing; three of them are latent bugs in memex's own code.

### Tier 1 — build (correctness + free/cheap quality)
1. **Content-sanity ingest gate WRITER.** memex has the full
   quarantine/content_flag/embed_skip read+filter substrate but nothing WRITES
   the markers (`embed-skip.ts` comment: "the deferred content-sanity writer
   stamps it"). Add a `content-sanity.ts`: scraper-junk patterns
   + operator literals hard-block, oversize warn 50KB/block 500KB, markup-ratio
   0.85 → content_flag. Hook into every ingest path (indexDocument / page write).
   Deterministic, free.
2. **Fact-extraction canonicalization bundle** (3 one-touch bugs in our code):
   - (a) `writeExtractedFacts` blind-slugifies the entity name — never calls the
     existing `slug-canonicalize.ts` cascade → phantom `alice` instead of
     `people/alice-smith`. Wire the cascade in.
   - (b) extractor parses `kind`/`notability` but `addFact`/`AddFactInput` drop
     them (columns EXIST — mig 037). Thread both through → NULL-kind facts that
     never decay get their decay back. Widen `AddFactInput` + insert.
   - (c) `forget_fact` on a fence-owned fact is silently non-durable — it stamps
     a DB tombstone but `reconcileFactsForPage` wipes+reinserts fence rows on the
     next page re-put → fact resurrects. Make forget survive rebuild (strike the
     fence row / preserve tombstone across reconcile).
3. **Insert-time fact dup/supersede classification.** `addFact` dedups on exact
   `(entity_slug, fact, source_chunk_id)` only → rephrased dups + contradictions
   accumulate. Port cosine-0.95 fast-path + Haiku `duplicate|supersede|independent`
   classifier (entity-prefiltered candidates). Depends on #2. Utility-tier Haiku.
4. **Calibration/synthesis tenancy.** `synth_calibration_profile` has NO
   source_id axis; the phase aggregates ALL tenants into one global profile
   exposed via `get_calibration_profile` (cross-tenant blend + leak). Add source
   axis (mig **060**), scope the phase + the read. Do before a real 2nd tenant.
5. **Filter pushdown to SQL.** lang/since/until/symbolKind filters post-hydrate
   over the fanout pool → a filtered query can return 0 despite matches. Thread
   filters into `keyword.ts` / vector SQL so the LIMIT budget lands on matches.
6. **Ranking (search/hybrid.ts), two free deterministic signals:** always-on
   log-scaled backlink-count boost `1 + 0.05*ln(1+count)` (floor-gated); and a
   cosine re-score blend `0.7*RRF + 0.3*query-chunk cosine` before dedup.
7. **`find_experts` topic param.** memex's version has no topic — returns generic
   link-degree hubs. Port topic-ranked expertise (match score + recency decay +
   salience) so "who knows about X" works.

### Tier 2 — worth it, when convenient
Semantic query-cache (embedding-cosine ≥0.92 hit; memex exact-text only —
paraphrase always misses; keep memex's better freshness model); `think` gather
breadth (4 fused streams incl. takes-vector + graph vs memex's 2; trajectory
injection for temporal Qs; citation validation vs gathered evidence);
`MEMEX_FACTS_EXTRACTION` wired into write surfaces + a conversation-facts
backfill cycle phase (today CLI-batch only); `consolidate` phase (facts→takes via
embedding clustering, deterministic); `patterns` phase (cross-session theme miner,
Sonnet slice); latent-contradiction probe (Sonnet slice feeding find_contradictions);
embedding provenance signature + auto-invalidation on model/dim swap; page rename
primitive + `slug_aliases` redirect table; nightly `memex eval` quality probe
(systemd timer + snapshot); take lifecycle hygiene (min-age grading gate; nothing
updates `synth_takes.status`; calibration profile consumed by nothing); default
chunk overlap (memex OFF, a 50-word ON option); batch/concurrent embed workers
(~10-20x faster full re-embed); hot-memory `_meta` injection on MCP responses.

### Skip (reasoned)
Image/multimodal + `search_by_image` + file/S3 substrate (no images/PDFs in the
corpus; Titan Multimodal G1 makes it AWS-buildable IF ever wanted); autocut
(memex reranker emits ordinal scores — nothing to cut on); CJK chunking
(en/de/ru corpus); 36 tree-sitter grammars (ts/py cover the corpus; add go/rust
on demand); schema-pack authoring suite; raw_data/ingest_log writers;
progressive-batch orchestrator; drift-watch; remediation auto-run; search
telemetry rollup (memex eval side is richer); takes-quality 3-model panel
(violates Anthropic-only; a Sonnet-judge variant is possible later); 9 extra
conversation-parser formats; `enrich_thin` + extraction receipts; `sources_*`
admin over MCP (CLI posture fine); job retry/pause/replay over MCP.

### OSS-install note
Deliberate: memex REQUIRES AWS (Bedrock embeddings), not local-first (PGLite,
no cloud) — higher install friction by design. Cheap win if OSS
adoption matters: an `INSTALL_FOR_AGENTS.md` (a ~15KB
agent-oriented install doc; memex has none).

Full ranked detail in agent memory `memex-brain-compare-2026-07-03` and the
vault note `Projects/memex/2026-07-03-brain-compare.md`.

### PRE-EXISTING CI red — `tenant_fail_closed.test.ts` (P1, not introduced by v1.73.0)
Three cases in `deploy/memex/tests/tenant_fail_closed.test.ts` fail on **clean
main** (verified at commit 1055326, before any Tier-1 work) AND in CI under real
Postgres — so it is NOT a PGlite-vs-Postgres artifact:
- "the guard bites ONLY the authed-public-no-grant caller > trusted-local … STILL reads whole-brain"
- "empty-scope … get_chunks > flag OFF: authed-public-no-grant get_chunks sees A's chunk (fail-open baseline)"
- "flag ON: static bearer get_chunks STILL sees A's chunk (whole-brain preserved)"
Symptom: the test's seeded page (`companies/fc-a`) is invisible to `page_list`
and `get_chunks` — both return `{ok:true, pages:[]}` / `{chunks:[]}`, i.e. the
seed write in `beforeAll` never persists or a visibility filter hides it. So the
assertions that expect the seed to be READABLE fail (it's a broken-setup failure,
not a real isolation leak). CI has been red on this since at least v1.72.0.
Investigate the seed/isolation-harness setup (why the page doesn't persist/read
in this test's DB), fix, get CI green. Separate from the Tier-1 ship.

### Tier-2 review follow-ups (self-review, 2026-07-03)
- **[HIGH — FIXED]** contradiction probe `defaultPairs` paired two tenants' facts
  on a shared slug → cross-tenant fact-text leak via `find_contradictions`. Fixed
  with `AND f2.source_id IS NOT DISTINCT FROM f1.source_id` + regression test. Both
  default-OFF (`MEMEX_PROBE_CONTRADICTIONS`).
- **[LOW] facts on-write extraction** (`MEMEX_FACTS_EXTRACTION`, default-OFF): the
  BudgetTracker is per-write only — no aggregate daily ceiling, so total spend
  scales with write volume. And the process-singleton extraction queue is shared
  across tenants, so one tenant's write-flood can evict another tenant's pending
  jobs (drop-oldest, cap 100). Best-effort + re-covered by the backfill phase;
  add an aggregate cap + per-tenant queue fairness if the feature goes always-on.
- **[INFO] calibration in `think`**: `getCalibrationProfile(engine)` is called
  unscoped, but `think` is CLI/`deep-synth`-only (never a tenant MCP tool), so it
  is whole-brain by design. IF `think` is ever surfaced as a tenant tool,
  calibration + `gatherPages`/`gatherTakes` must all take `sourceIds`.

### Tier-1 review follow-ups (from the self-review after shipping)
- **[MEDIUM] facts supersede ↔ fence tombstone coupling.** `facts-reconcile.ts`
  builds its "forgotten" skip-set from `forgotten_at IS NOT NULL` regardless of
  cause. The insert-time dedup supersede path (`MEMEX_FACTS_DEDUP`, default-OFF)
  also stamps `forgotten_at`, so a supersede of a fence-sourced claim would
  suppress its fence re-insert while the operator still declares it. Contained
  (opt-in). Fix: distinguish a `forget_fact` tombstone from a supersede one
  (e.g. a `forgotten_reason` column) so reconcile only honors user-forgets.
- **[LOW] facts-classify prompt fence.** `sanitizeForPrompt` neutralizes
  `</data>`/`</turn>` but not the `</existing>`/`</new>` tags the classifier
  uses — a crafted fact could break its own `<new>` fence. Self-inflicted,
  within the caller's own tenant, dedup default-OFF. Fix: add `close-existing`
  /`close-new` patterns to `INJECTION_PATTERNS` in `sanitize.ts`.
- **[LOW] cosine-rescore mixed scale.** `cosine-rescore.ts`: a candidate chunk
  missing from the cosine map keeps its raw (unnormalized) RRF score while the
  rest move to the 0..1 blend — a missing-embedding chunk sinks post-blend.
  Rare (near-total embedding coverage); `MEMEX_COSINE_RESCORE` default-OFF.
- **[INFO] content-sanity junk scan** only reads the first 2KB, so junk padded
  past 2KB evades the quarantine marker. Index-quality only, not a security
  boundary.

---

## Scope reversal (2026-06-30) — FULL parity ACCEPTED

Operator call (2026-06-30): memex is an **open-source project headed for
many companies**, so the cost-first / brain-only / "rejected" gates below are
**lifted**. Build everything; write it in memex's own voice (no external-source
names in code/commits). This block SUPERSEDES the conflicting "keep deferred /
gated / rejected" notes in the dated sections further down — those sections
keep the *engineering detail*; this block changes their *disposition* to ACCEPTED.

Accepted scope, in build order (lowest blast-radius first):

- [x] **1. `near_symbol` + `walk_depth` search expansion** — DONE (Unreleased).
  `core/search/structural-expand.ts` (`expandAnchors`: batched BFS over
  `code_edges_symbol`, depth ≤ 2, 50-frontier / 200-candidate caps, `1/(1+hop)`
  decay, scope on `documents.source_id`) wired into `hybridSearch` pre-hydrate
  (cache bypass, widened per-doc dedup); `near_symbol`/`walk_depth` exposed on
  the `search` op. The prerequisite `chunks.symbol_name_qualified` already
  shipped (mig 041) — no new migration. ai-engineer reviewed: HIGH fan-out/N+1
  fixed (per-frontier batching + caps), 2 MEDIUM fixed (frontier symbol dedup,
  near_symbol baseScore documented). Tests `tests/structural_expand.test.ts`
  (7). Dormant on the live corpus (~0 code chunks) — lands behind its
  default-off switch. Ships bundled with the embedding-dim-config change.
- [~] **2. Multi-tenancy go-live** — IN PROGRESS, hardening the SHIPPED shape
  (2026-07-01 compare + Codex reconcile). Already live: app-layer + admin SPA +
  OAuth (v1.30–v1.51), mig 047 source_id (pages/links/facts/timeline/tags), read
  leak-close (v1.58), Nova→Bedrock-Haiku (v1.59), chunks.source_id mirror (v1.60),
  and a **contract-level isolation harness proving 22 read tools honor scope, no
  leaks** (v1.61). REMAINING, reconciled with Codex (which tempered "build all"):
  - **NEEDED before go-live:** [x] fail-closed unprovisioned-`sub` policy —
    SHIPPED v1.62.0 (`MEMEX_TENANT_FAIL_CLOSED`, default-OFF, `__memex_no_source__`
    sentinel closes the `[]`-means-all bypass; static bearer provably untouched).
    [x] query-cache source_id key — CONFIRMED already keyed via `scope`
    (query-cache.ts:171). [ ] keep synthesis hard-gated OFF until a multi-tenant
    synth source-axis is actually wanted (unchanged — no work needed now).
  - **NEEDED soon (even single-tenant):** [x] deletion-reconcile — SHIPPED v1.62.0
    (`reindex --reconcile-deletes`, opt-in, soft-delete via destructive-guard,
    3 over-delete guards).
  - **composite `(source_id,slug)` PK — precursor SHIPPED v1.63.0 (additive):**
    source-aware page mirror id `page://<sourceId>/<slug>` (legacy `page://<slug>`
    for default → no live re-mirror), source-threaded page reads. REMAINING (the
    irreversible final step, OPERATOR-GATED on an explicit "drop the PK"): drop the
    global `pages.slug` PK + `putPage`'s cross-source reject so two tenants hold the
    same slug as separate rows. Codex + live data (14 pages, 0 dup slugs) agree:
    defer the PK drop until multiple tenants actually write pages.
  - [x] **per-source health/doctor axis — SHIPPED v1.64.0.** `collectPerSourceHealth`
    + `source_health` MCP tool (scoped) + `memex status --per-source` + opt-in
    `MEMEX_DOCTOR_PER_SOURCE` warn check. Whole-brain metric unchanged. Live-verified.
  - [x] **eval-replay CI regression gate — SHIPPED v1.65.0.** `eval-replay run`
    exits 1 on a baseline drop > `EVAL_REPLAY_REGRESSION_EPS`.
  - **Assessed + eliminated (no work): mcp_request_log writer already wired
    (`MEMEX_REQUEST_LOG_DB`); Bedrock-native rerank NOT available in eu-west-1
    (`list-foundation-models` rerank = []) — Haiku two-pass stays the AWS rerank.**
  - **Deferred as low-value-now:** salience take_count (synth store empty until
    `MEMEX_DREAM_SYNTHESIS=1`), query-cache contention-free sequence (low write QPS),
    per-source entities (no active leak — reads re-scope via chunk→document join),
    RLS real policies + FORCE (needs a least-privilege runtime role), wire retrieval
    readers to the chunks.source_id mirror (behavior-neutral perf).
  - [x] **WRITE-path tenant isolation — SHIPPED v1.66.0 + v1.67.0.** Adversarial
    audit (2026-07-02) found the write path had latent holes symmetric to the v1.58
    read leak-close. v1.66.0: destructive tools (delete/revert/restore/removeLink/
    removeTag/forgetFact/purge) scope by the caller's write source. v1.67.0:
    wikilink/verb/typed-link canonicalization source-scoped at write time (no
    cross-tenant `[[people/alice]]` resolution); `links`+`tags` unique keys gained
    `source_id` (**mig 059**, collision-safe on single-source live data — verified
    live: links=9 preserved, new keys `links_source_target_type_source_id_key` +
    `tags_slug_tag_source_id_key`); write-side fail-closed (`effectiveWriteSourceIdForIngress`,
    gated on `MEMEX_TENANT_FAIL_CLOSED`); gazetteer source-scoped. All additive,
    behavior-neutral for single-tenant. This CLEARS the write-gate: a 2nd WRITE
    tenant is now code-safe.
  - **Remaining audit LOWs (deferred, minor):** `list_concepts`/`get_calibration_profile`
    are GLOBAL synth aggregates (safe — synthesis default-OFF; add source_id to synth
    tables only if multi-tenant synthesis is enabled); putPage owner-check blind to
    soft-deleted rows (namespace-squat edge, no cross-tenant write). Not worth a release now.
  - **OPERATOR-GATED (irreversible / needs operator env) — the only remaining go-live blockers:**
    (a) **LIVE 2-tenant auth smoke** over `brain.<domain>/mcp` with real tokens — the one
    genuine go-live proof (Codex); operator-run (mutates prod). Runbook: vault
    `Projects/memex/2026-07-02-multitenant-golive-runbook.md`. (b) flip
    `MEMEX_TENANT_FAIL_CLOSED=1` on live — code shipped default-OFF; safe (static bearer
    is `authInfo=undefined`, unaffected) — flip when a real remote OAuth tenant with a
    grant exists. (c) drop the global slug PK — Codex + live data (14 pages, 0 dup slugs)
    say DEFER; use tenant slug prefixes instead. (d) recreate the lost `terraform.tfvars`
    via `scripts/init.sh` (only needed for a future terraform apply; nothing pending now).
  - **GATED on operator env / explicit deploy (irreversible):** terraform public
    ingress (ALB/SG/TLS — only from the private ops dir, not this checkout) +
    the fail-closed flip against live data (backfill NULL `source_id` first, else
    the scoped reader sees nothing under the static bearer).
  Full picture: memory `memex-full-compare-2026-07-01` + the maintainer's vault
  comparison note (kept outside this repo).
- [ ] **3. Embedding upgrade** — ACCEPTED (was "stay on
  Titan 1024, no switch"). Two-step: (a) make the embedding dimension a
  **config value** (no hardcoded 1024) so a swap is config not rewrite —
  prerequisite; (b) switch to a higher-dim provider + **full
  corpus re-embed** + column/HNSW migration. Verify which provider is reachable
  from our AWS/Bedrock posture first (cost + egress). Detail: "Embedding
  1024→1536" + the "Roadmap decisions" embeddings bullet (now reversed).
- [x] **4. Re-accept the "rejected" expensive-AI features — COMPLETE (v1.57.0).**
  ACCEPTED as **paid opt-in Sonnet slices** (the proven conversation→facts
  pattern: flag + budget + Bedrock Sonnet, never default-ON in a way that
  surprises cost). All six slices S1–S6 shipped default-OFF; the paid
  per-chunk-synopsis tier of S6 + its bulk `reindex --contextual` re-embed remain
  the only operator-gated follow-ups. Six slices, prioritized by value/effort:
  - [x] **S1 — ensemble/multi-vote grading — DONE (v1.56.0).** N Sonnet judges
    → majority verdict + median confidence in `gradeTakesPhase`
    (`MEMEX_TAKE_ENSEMBLE`, mig 056 provenance). ai-engineer reviewed (HIGH
    parse-fail-vs-budget-out split + 2 MEDIUM fixed). Tests in
    `synthesis_takes.test.ts`. Dormant until the flag is set.
  - [x] **S2 — think / deep-synthesis pipeline — DONE (v1.57.0).** `MEMEX_THINK`,
    `core/synthesis/think.ts` (GATHER hybrid+takes → Sonnet synthesis →
    `{answer, citations, gaps}`) + `commands/think.ts` + `cli.ts` case. Budget
    `MEMEX_THINK_BUDGET_USD`. Injectable `pagesFn`/`sonnetFn` seams (hybridSearch
    has no offline embedder). 18 tests.
  - [x] **S3 — relational-recall LLM arm — DONE (v1.57.0).** `MEMEX_RELATIONAL_LLM`,
    `core/search/relational-llm.ts`: Sonnet extracts `{kind,seeds,linkTypes,
    direction}` (validated vs `KNOWN_LINK_TYPES`), reuses the shared
    `fanoutRelational` (refactored out of `relationalRecall`, behavior-preserving,
    13 regression tests green). Wired as an opt-in fallback in the
    `relational_recall` MCP tool. 12 tests.
  - [x] **S4 — graph-aware Sonnet rerank — DONE (v1.57.0).** `MEMEX_GRAPH_RERANK`,
    `core/search/graph-rerank.ts`: post-fusion Sonnet reorder with a link-graph
    degree hint; fail-open to the input order; budget pre-flight BEFORE the degree
    query. Wired into `hybridSearch` before the trim. Distinct from Haiku
    `MEMEX_RERANK`. 15 tests.
  - [x] **S5 — extra deep-synthesis cadence — DONE (v1.57.0).** `MEMEX_DEEP_SYNTH`,
    `core/synthesis/deep-synth.ts`: runs `think` over top `synth_concepts` as
    standing questions on quiet-hours cycle ticks, one shared USD cap, returns +
    logs (no write-back). Wired into `recipes/cycle.ts` runTick. 8 tests.
  - [x] **S6 — contextual-retrieval embed wrapper — DONE (v1.57.0).**
    `MEMEX_CONTEXTUAL_RETRIEVAL`, mig 057, `core/search/contextual-embed.ts`
    (LLM-FREE tier: `<context>{title}\n{synopsis}</context>` on the embed INPUT
    only, deterministic first-two-sentences synopsis, code bypass). Wired into
    the indexer embed path (flag-gated). The paid per-chunk Haiku synopsis tier +
    the `reindex --contextual` bulk re-embed stay DEFERRED/operator-gated —
    sequence the bulk re-embed AFTER Item 3 to avoid a double re-embed. 21 tests.
  Each default-OFF, shipped like facts/S1 (not deploy-gated). Item 4 COMPLETE.

Method (unchanged): implement with `file:line` citations, TDD, self-review
agent per batch, ship via the repo loop (test→push→deploy→verify→release), no
external-source names in any tracked file (`make audit`/`scrub-audit` gate).

---

## Roadmap decisions (2026-06-29) — cost-first

Three forward calls, settled (adapted for our
self-hosted + low-spend constraints):

- **Embeddings — stay on the current 1024-dim provider; no switch now.** Making
  the embedding dimension a config value (not hardcoded) is the only adaptation to
  carry over when embeddings are next touched, so a future model swap is a config
  change, not a rewrite. No provider switch / full re-embed without a measured
  retrieval-quality problem — the swap costs money and a corpus re-embed.
- **Agent/synthesis layer — FIRST SLICE DONE (v1.52.0).** `MEMEX_DREAM_SYNTHESIS=1`
  opts the existing Nova synthesis chain into quiet-hours cycle ticks (default-OFF,
  count-capped, writes the isolated `synth_*` store). memex already had the
  synthesis primitives + storage + MCP reads; this was the missing auto-run wiring.
  Deliberately did NOT build the Opus/USD-budget/`think` pipeline —
  conflicts with the Nova-only / synthesis-is-the-client's-job stance. Later slices
  (deferred): a dedicated slower synthesis cadence, surfacing `synth_*` into
  retrieval/answer context, a composite `auto-think` phase name.
- **Multi-tenant auth — DONE (v1.51.0): self-issued OAuth 2.1 `client_credentials`
  (no external IdP).** memex is its own authorization server
  (`/token` + `memex auth register-client` + `memex_at_` verify on `/mcp`). The
  earlier AWS Cognito path was built then removed — an external IdP is the wrong
  tool for an agent-served brain (more deps, wrong fit).

---

## Parity gap sweep (2026-06-30) — 16 findings, 14+1 shipped

A dynamic-workflow diff (9 subsystem readers + synthesis) surfaced 16 brain-only
findings. **Shipped (v1.53.0):** code_def / code_refs / code_blast / code_flow
(BFS over code_edges_symbol), whoami, since/until/lang/symbol_kind search filters
+ `documents.effective_date` (mig 055), intent-gated recency, slug-prefix
curation boost + hard-exclude, DSN/credential redaction, prompt-injection
sanitizer, eval Wilson CI + per-query isolation, frontmatter blank-key fix.
**Shipped (v1.54.0/.1):** conversation→facts extractor via paid Bedrock Sonnet
(default-OFF, $1 budget, IAM applied, proven live).

Genuinely deferred (one item, candidate for a future session):
- [ ] **`near_symbol` + `walk_depth` search expansion.** Anchor
  retrieval at a qualified symbol and expand through code_edges with
  `1/(1+hop)` decay (`core/search/two-pass.ts` + hybrid wiring). memex
  `core/search/two-pass.ts` exists but has NO nearSymbol/anchor/walkDepth
  machinery — this is a candidate-construction-stage (pre-fusion) integration,
  higher blast-radius than the post-hydrate `since/until/lang` filters already
  shipped. Reuses `core/code-walk.ts` (the BFS walker). Portable; deferred by
  risk, not by un-portability. Expose `near_symbol` + `walk_depth` on `search`/
  `query` once designed.

## Parity gap sweep (2026-06-28) — 6-subsystem dynamic-workflow diff

A fresh dynamic-workflow fan-out (6 brain-only subsystem readers + a completeness
critic) re-checked memex to confirm nothing shippable was
missed. 23 findings; 21 already done / north-star / gated / dormant. Genuinely
shippable brain-only gaps found:
- [x] **`last_retrieved_at` write-back — DONE (v1.40.0).** The column (mig 024) +
  consumer (`context/volunteer.ts` "used" stat) shipped with NO producer →
  always NULL → stat always 0. `core/last-retrieved.ts` `bumpLastRetrievedAt`
  wired at `page_get`. Throttled, best-effort, `MEMEX_TRACK_RETRIEVAL` opt-out.
  Producer is `source_id`-scoped (mig-047 pre-emption). FOLLOW-UP (mig-047): the
  consumer `context/volunteer.ts:255` joins `ON p.slug = e.slug` only — add a
  `source_id` axis to the volunteer-events join when the composite PK lands, or
  the "used" stat will cross-count same-slug pages across sources.
- [x] **`cycle_freshness` doctor check — DONE (v1.41.0).** `core/cycle-freshness.ts`
  `checkCycleFreshness` reads `MAX(captured_at)` (to_char ISO), warn >6h / fail
  >24h (`MEMEX_CYCLE_FRESHNESS_WARN_HOURS`/`_FAIL_HOURS`). Zero snapshots =
  informational. WARN-only by default; `MEMEX_CYCLE_FRESHNESS_ENFORCE=1` for
  hard exit-1 (code-reviewer HIGH: a cycle-off deploy would else cry wolf).
  PROD FINDING (immediately caught a 53h-stale cycle) ROOT-CAUSED + FIXED in
  v1.42.0: the loop deferred its first tick a full 6h interval, reset by every
  deploy/restart → starvation. First tick is now `min(interval, 60s)`.
  FOLLOW-UP (LOW): warn default 6h == the prod tick interval, so a healthy
  just-ticked cycle can momentarily read WARN — make the warn default relative
  to the cycle interval (≈2×) or raise it; operator can set
  `MEMEX_CYCLE_FRESHNESS_WARN_HOURS=12` meanwhile.
- [x] **RESOLVED (v1.47.0) — the cycle runs end-to-end with EVERY phase.** Root
  cause was empirical: anomalous docs with 18–30 MB `frontmatter` JSONB (436 MB
  across 658 docs); `frontmatter-inference`'s `SELECT d.frontmatter` over all of
  them parsed into multi-GB of JS objects → OOM-SIGKILL. Fix (one-doc-at-a-time
  inference, no recurring cycle phase):
  keyset-paginate (`MEMEX_CYCLE_FM_BATCH`) + skip docs whose frontmatter exceeds
  `MEMEX_CYCLE_FM_MAX_BYTES` (16 KB — the phase only fills MISSING fields, so a
  big frontmatter isn't missing them) + chunk-0 via `LIMIT 1` subquery capped at
  64 KB. Live-verified: frontmatter-inference now `done status=ok rss=1009MB`
  (was a SIGKILL), full tick completes, SNAP_COUNT 86→89, `cycle-freshness`
  "last cycle 0h ago". The `MEMEX_CYCLE_SKIP_PHASES` workaround is removed.
  REMAINING data follow-up: WHY do docs have 30 MB frontmatter? An ingest path is
  dumping content into the `frontmatter` JSONB — root-cause + clean the data.
- [~] (superseded by v1.47.0) earlier MOSTLY-RESOLVED-via-skip note — kept for
  history: As of v1.46.0 the live cycle ran END-TO-END and wrote snapshots again
  (`cycle-freshness` = "last cycle 0h ago", SNAP_COUNT rising, lock released,
  48 s/tick, peak RSS 1404 MB). The fix: `MEMEX_CYCLE_SKIP_PHASES=frontmatter-inference`
  (set in the host .env) drops the ONE phase whose start hard-SIGKILLs the tick.
  REMAINING (needs LOCAL heap-profile): root-cause WHY `frontmatter-inference`
  spikes anon memory enough to OOM-kill PID 1 on its `SELECT all docs + chunk-0`
  + 658-row UPDATE loop (the corpus is tiny — 658 docs/4303 chunks/≤21 KB — so
  it's an algorithmic/driver allocation, not data size; GC + 3000m reduced but
  did not eliminate it). Fix it, then drop the skip. Also add an
  INCREMENTAL extract (only changed slugs) — extract is the heaviest phase
  (1404 MB/31 s, re-processes ALL docs every tick). Full investigation below:
- [ ] **(investigation log) cycle crash — process EXIT mid-tick, root-caused to
  frontmatter-inference.** (The earlier "FIXED v1.43.0" note was wrong —
  withPhaseTimeout bounds a HANG but the real failure was a process EXIT a JS
  timeout can't catch.) 2026-06-28/29:
  - The live serve PID 1 EXITS mid-cycle → Docker `restart: unless-stopped`
    restarts it (restarts=1) → the cycle dies, lock strands, no snapshot. NOT a
    healthcheck restart (plain compose doesn't restart on unhealthy).
  - Worst case is a kernel OOM: a bun cycle process hit **3.48 GB RSS** on the
    ~3.7 GB host (dmesg `global_oom`, `task=bun`). CONTAINED v1.44.0 via
    `mem_limit` (2600m → clean cgroup kill + container restart, not host-wide).
  - Per-phase RSS telemetry (v1.44.0), lighter run: lint 1080MB, **extract
    1367MB / 38.3 s (heaviest)**, mirror-pages 563MB, …orphans-purge 1363MB —
    peak 1367MB (< 2600m, OOM=false), yet PID 1 STILL exited ~30 s into the next
    phase (`frontmatter-inference`). So there is a SECOND non-OOM crash path
    in/after frontmatter-inference (an unhandled native/WASM exit not caught by
    `runPhase`'s try/catch; event loop was alive — /health 0.00 s — and the 120 s
    phase timeout did not fire before the exit). Confirmed NOT the chunk-0 dup
    blowup (0 dups, old join = 658 rows, max chunk 21 KB) and NOT recompute-
    salience (links=4/pages=5, query 19 ms).
  - FIX TO BUILD: make extract INCREMENTAL (only changed
    slugs; "54K-page → sub-second"); memex re-extracts ALL docs every cycle (no
    LIMIT/cursor) — the heaviest phase. Make `extract` O(changed) per tick.
  - NEXT: reproduce locally — run `cycle` against a prod-shaped dataset under a
    2600m cgroup, watch which phase exits PID 1, fix the crash + port incremental
    extract. Standing detector: `cycle-freshness` (v1.41.0). Blast-radius bound:
    `mem_limit` (v1.44.0). Current state: degraded-but-serving — search works;
    the cycle attempts ~every 6 h, crashes once, restarts clean, idles (not a
    tight loop).
- [ ] **process-watchdog (LOW).** A worker_threads hard-deadline kill for an
  event-loop-starving sync loop. memex's docker healthcheck already restarts a
  hung container (this guard targets an unsupervised cron CLI), so
  near-zero marginal value. Build only if a real ReDoS-starvation case appears.
- [x] **Coverage blind spot — ingestion/sync write path** — RESOLVED. Every named
  sub-path now has dedicated tests: incremental re-sync → `extract_incremental.test.ts`,
  dedupe-on-reingest → `dedup_neardup.test.ts` + indexer idempotency, backfill
  resumability → `embed_backfill.test.ts`, the file→page→chunk→embed writer →
  `writeDocumentTransaction` exercised by ~15 tests incl. `well_form.test.ts`
  (scalar-frontmatter guard). Vault watcher: N/A — memex is on-demand reindex, no
  boot-time watcher.

---

## Deferred — full-parity follow-ups (2026-06-23)

> NOTE: the "brain-only" north-star elsewhere in this file is **superseded** as
> of 2026-06-23 — the operator opted into full parity. LLM synthesis,
> code-graph, push-context, advisor, and an OAuth app-layer all shipped
> (v1.10.0–v1.16.0). These are the remaining pieces, deferred because they need
> infra/provider decisions, not because they're out of scope.

### Multi-tenancy (company multi-user) — IN PROGRESS (2026-06-25)

Design + must-fix checklist: `docs/tenancy.md`. Operator decisions locked:
external IdP (Cognito) issues JWTs; tenant = a `sources` row; per-user private
source + shared org source via `federated_read[]`; app-layer `source_id` filter
+ RLS backstop.

- [x] Scope model `src/core/scope.ts` + tests (`tests/scope.test.ts`).
- [x] Additive auth tables — migration `046_oauth.sql` (clients/tokens/codes,
  access_tokens, mcp_request_log). Reviewed (security + architect).
- [ ] **Invasive `source_id` migration (047)** — gated. Per the reviews:
  - propagate `source_id` page→bridged-document→chunk (isolation is enforced on
    `documents.source_id`, the search-arm filter — pages must carry it through
    the bridge or they index as `default` and leak);
  - incremental PK path (keep `slug` PK + `UNIQUE(source_id, slug)`, defer the
    composite PK);
  - widen `sources.kind` CHECK to add `'tenant'`;
  - `source_id` in the query-cache key (mig 031) to stop cross-tenant cache
    poisoning;
  - filter the full surface (graph/links/facts/timeline/aliases/HNSW
    post-filter), make `sourceIds` a required builder param, add RLS backstop,
    validate `federated_read[]` against `sources`, CI grep gate on bare `slug =`.
- [ ] Port `oauth-provider.ts` (client-credentials + token verify/revoke), adapt
  to Bun/postgres.js; wire Cognito JWT → `AuthInfo{sourceId, allowedSources}`.
- [ ] Thread `AuthInfo` through `mcp/dispatch.ts` + `http/server.ts`.
- [ ] **Admin surface (`/admin`) — IN PROGRESS (operator asked for a full admin
  console, 2026-06-28).** A React 19 + Vite 6
  admin SPA (6 pages: Login, Dashboard, Agents, RequestLog, Calibration,
  JobsWatch) + 23 `/admin*` routes + magic-link/cookie auth, all adapted from
  express → memex's Bun.serve. memex already has the provisioning FUNCTIONAL core
  (`tenant` CLI: add/grant/list/revoke); this adds the web surface over it. Three
  serial increments (ship each):
  - **A — admin HTTP API + auth (backend):**
    - [x] **A1 — auth core (v1.30.0).** `http/admin.ts` `createAdminAuth`:
      `/admin/login`, `/admin/api/issue-magic-link`, `/admin/auth/:nonce`,
      `/admin/api/sign-out-everywhere` + `requireAdmin`; in-memory sessions +
      single-use magic-link nonces; HttpOnly/SameSite=Strict cookie; public-guard
      `/admin*` bypass; bootstrap token from `MEMEX_ADMIN_BOOTSTRAP`/ephemeral.
      codex + security-engineer reviewed (MEDIUM login rate-limit + LOWs fixed).
    - [x] **A2 — data + provisioning endpoints (v1.31.0).** `http/admin-api.ts`:
      `GET /admin/api/full-stats` (health + counts), `GET /admin/api/grants`,
      `POST /admin/api/sources` (= tenant add), `POST /admin/api/grants` (= tenant
      grant), `POST /admin/api/revoke-grant`. Wraps the same provisioning core the
      CLI uses; single requireAdmin gate + per-route defense-in-depth. codex +
      security-engineer reviewed (LOWs fixed). FOLLOW-UP (A2b, optional): the
      read-only feed pages — `/admin/api/requests` (mcp_request_log),
      `/admin/api/jobs/watch`, calibration, SSE `/admin/events` — add as the SPA
      needs them.
  - **B — admin SPA (frontend) — SCOPED, needs a focused frontend session.** The
    `admin/` SPA is a React 19 + Vite 6 project (~1860 lines: App, main,
    api.ts, index.css 359, + 6 pages — Login 96, Dashboard 137, Agents 633,
    RequestLog 150, Calibration 174, JobsWatch 174). Porting requires a new
    frontend toolchain in this backend repo (`admin/package.json` React+Vite,
    `bun install`, `vite build`) AND real DATA-SHAPE adaptation — the original
    SPA reads shapes (`stats`/`health`/SSE `/admin/events`/`oauth_clients`
    register-client) that memex's A2 does NOT have; memex exposes `full-stats` +
    `grants`/`sources`. So it keeps the STRUCTURE/design, with the
    data layer + the Agents page re-modeled to memex `source_grants`. Sub-plan:
    - [x] **B1 — scaffold + Login + Dashboard — DONE (source on main; builds).**
      `admin/` Vite project (package.json React19+Vite6, vite.config base
      `/admin/`, index.html, tsconfig, main.tsx, index.css copied), `api.ts`
      adapted to A2 (login/signOutEverywhere/fullStats/grants/registerSource/
      grant/revokeGrant), App.tsx sidebar + sign-out, Login.tsx + Dashboard.tsx
      (reads `/admin/api/full-stats`; SSE feed deferred to B3). `bun install` +
      `vite build` verified → dist (32 modules, ~200KB js). node_modules/dist
      gitignored; the main tsc (`include: src+tests`) ignores `admin/`. NOT YET
      SERVED — dormant until C wires the Docker `vite build` + the /admin static
      serve. Ships LIVE together with C.
    - **B2 — Agents page:** re-model the 633-line OAuth-client manager to memex's
      sources + grants provisioning UI over A2 (`/admin/api/sources`, `grants`,
      `revoke-grant`).
    - **B3 — feed pages + A2b endpoints:** RequestLog (`/admin/api/requests` over
      `mcp_request_log`), JobsWatch (`/admin/api/jobs/watch`), Calibration, SSE
      `/admin/events`. Each page + its backend endpoint together.
  - [x] **C — serve (v1.32.0).** `http/admin-static.ts` serves the built
    `admin/dist` at `/admin` with an `index.html` SPA fallback (GET-only, after
    auth + the data API); a `resolve()`+`relative()` boundary guards traversal.
    Dockerfile gains an `admin-builder` stage (`bun install` + `vite build`) and
    COPYs only `/admin/dist` → `/app/admin/dist`; `.dockerignore` keeps the
    context lean. codex reviewed (traversal string-prefix → boundary fix applied).
    The admin dashboard (Login + Dashboard) is now LIVE at `/admin`.
  - [x] **B2 — Agents page (v1.33.0).** `admin/src/pages/Agents.tsx` + nav: lists
    grants, register-source + provision-grant modals, per-row revoke — over the
    A2 endpoints (no new backend). The OAuth-client manager re-modeled to
    memex sources/grants. codex reviewed (no XSS; dup-key LOW fixed).
  - [x] **B3 — Request Log + Jobs Watch (v1.34.0).** A2b endpoints
    `/admin/api/requests` (paginated `mcp_request_log`) + `/admin/api/jobs/watch`
    (status counts + recent jobs) + `RequestLog.tsx` / `JobsWatch.tsx` pages +
    nav. Bound LIMIT/OFFSET, capped error text. codex reviewed. **Admin SPA is
    feature-complete (5 pages).**
    - [x] **SSE /admin/events live feed — DONE (v1.36.0).** http/admin-events.ts
      pub/sub bus (cap 50) + publishToolCallEvent (redacted, hot-path-safe) +
      GET /admin/events (requireAdmin, text/event-stream) + Dashboard EventSource
      tail. codex + security-engineer clean.
    - [x] **Calibration page — DONE (v1.37.0).** GET /admin/api/calibration/profile
      over getCalibrationProfile (synth_calibration_profile scorecard) + Calibration.tsx
      (accuracy/breakdown/bias tags/pattern statements). SVG charts = follow-on.
      ADMIN SPA FEATURE-COMPLETE (6 pages).
    - [ ] FOLLOW-ON (cosmetic): SVG calibration charts (— — needs infra memex lacks): the SSE
      `/admin/events` live feed (no event bus — Dashboard's 30s refresh + Jobs
      Watch's 15s poll cover live-status) and the Calibration page (no
      calibration backend). `mcp_request_log` has no writer yet (memex logs the
      JSONL audit trail instead) — add a DB-sink request logger to populate the
      Request Log page, or leave it for when the request-log feed is wanted.
- [ ] **Live deploy is a separate gated step** — terraform ingress + RDS
  migration only on explicit operator "deploy".

#### Tenancy pre-deploy MUST-FIX (security review 2026-06-25) — block go-live
- [x] **All four tenancy MUST-FIX items DONE** — JWT entitlement floor
  (server-side `source_grants` keyed by `sub`, claims untrusted), get_chunks +
  relational_recall source filter, `source_id` stamped on derived writes, and
  readSources threaded into the insight/code/synthesis read tools. Verified in
  code (migration 048 `source_grants`, `http/server.ts` grant resolution,
  `tenant_isolation.test.ts` 11/11). The earlier unchecked duplicates of these
  were removed to stop false-open CRITICAL/HIGH signal on every audit; the
  checked completion notes below are authoritative.
- [x] **RLS enable** migration (049) — DONE:
  a `DO`-block guarded on `rolbypassrls` flips `relrowsecurity` on across every
  content + auth table (`migrations` excluded). No policy + no `FORCE`, so it is
  inert today (the migrating bypass-role is exempt; a non-bypass managed-Postgres
  role gets a NOTICE and no change) — isolation stays app-layer. PGLite-safe
  (verified) + `tests/rls_enable.test.ts`. **NOT done (intentionally —
  unnecessary for the current single-role deploy):** per-row policies and the
  per-connection `SET app.current_sources`
  pool GUC. Revisit only if the operator wants DB-level enforcement beyond the
  defensive enable.
  - Follow-up (LOW, security review): the migration's ELSE branch (non-BYPASSRLS
    role → NOTICE, no change) is only reachable on a real managed Postgres, so
    it has no PGLite test coverage. And 049 is safe ONLY for the single-role
    deploy (migrate role == runtime role == table owner) — if role separation is
    ever introduced, add permissive policies before granting a migration-only
    role BYPASSRLS (documented in the migration header).
- [x] Extend `tests/tenant_isolation.test.ts` to cover get_chunks,
  relational_recall, the insight tools, and derived-write stamping — DONE
  (11/11; 4 leak-lock cases added).
- [x] Wire get_chunks/relational_recall/insights/code/synthesis read handlers +
  stamp derived writes (mentions/typed-links/fence-facts/wikilinks) — DONE.
- [x] JWT entitlement floor — DONE: migration 048 `source_grants` (sub→source +
  federated_read); `http/server.ts` resolves the grant server-side by `sub`;
  token claims are NOT trusted for tenancy.
- [ ] **Operator policy decision** — an authenticated JWT `sub` with NO
  `source_grants` row currently gets unscoped **redacted** whole-brain read
  (back-compat default). For a company brain, consider fail-closed (deny until
  provisioned) instead. Decide before go-live.
- [ ] `list_concepts` / `get_calibration_profile` are global synthesis
  aggregates (no `source_id`, mig 045) — confirm acceptable that they are not
  per-tenant, or give the synth tables a source axis.

### Retrieval / resilience backlog (found by the 2026-06-25 re-audit)

Small, deterministic, brain-internal — safe to ship incrementally:
- [x] Compute + pass `floorThreshold` in `hybrid.ts` so the graph-signals gate
  stops being a no-op — DONE. `computeFloorThreshold` (graph-signals.ts) derives
  a relative floor `topScore × MEMEX_GRAPH_SIGNALS_FLOOR` (ratio 0..1, fail-loud
  parse); `hybrid.ts` threads it into `applyGraphSignals`; unset → `-Infinity`
  (inert, ranking unchanged); ratio folded into the cache ranking signature
  (RANKING_VERSION 4). Tests in `search_graph_signals.test.ts`.
- [x] Wire alias-hop (`page_aliases`, mig 034) into `hybridSearch` — DONE.
  `core/search/alias-hop.ts` `applyAliasHop`: exact-full-query alias match
  (≤6 tokens, unique resolution) → ×1.10 boost if the canonical page is present,
  else inject its representative chunk at the head; source-scoped +
  visibility-filtered; default ON (`MEMEX_ALIAS_HOP=0` to disable); folded into
  the cache ranking signature (v5). Tests: `search_alias_hop.test.ts`. NOTE: a
  separate `slug_aliases` concept-redirect boost is a distinct
  feature memex lacks (no concept-redirect pages) — out of scope.
  - Follow-up (LOW, review): `resolveAliasUnique` filters `deleted_at IS NULL`
    but not `archived`; an archived page already in the result set could be
    alias-boosted (the inject path is safe — `fetchPageHeadHit` applies the full
    visibility filter). Pre-existing (the main hydration doesn't filter archived
    either), not an alias-hop regression. Tighten by adding `AND NOT p.archived`
    to the shared resolver if/when the hydration gap is closed.
- [x] Bounded query-embed deadline (AbortSignal) → keyword fallback on stall —
  DONE (v1.21.0). Adds `embedQueryBounded` /
  `makeQueryEmbedDeadline` / `QueryEmbedDeadline`: `hybridSearch` races the query
  embed against `MEMEX_QUERY_EMBED_TIMEOUT_MS` (default 6000, 2s-min budget) via
  `AbortSignal.timeout`; `embedText` accepts the signal so the Bedrock request is
  cancelled. Timeout/error → vector arm dropped, retrieval proceeds keyword-only.
  Files: `core/embedding.ts`, `core/search/hybrid.ts`. HIGH fix applied: a
  degraded keyword-only result is NOT cached.
- [x] **Retry-After on 429** — DONE (v1.21.0). Standard 429
  response shape: the per-caller token-bucket limiter exposes a read-only
  `retryAfterSeconds` (seconds until the bucket refills one token, ≥1, clamped to
  avoid `Infinity`); the MCP 429 carries it as a `Retry-After` header. Files:
  `mcp/rate_limit.ts`, `mcp/http_transport.ts`. (Inbound header only — an
  outbound-client `max(2s, Retry-After, reset)` backoff is N/A.)
  - MEDIUM follow-up (pre-existing, NOT introduced here): JSON-RPC batch
    amplification — the limiter charges 1 token per HTTP POST, but a batch body
    runs N distinct dispatches under that single token. Tighten by charging per
    sub-request if batch abuse ever shows up.
- [x] **Cycle concurrency lock** — DONE (v1.21.0). Adds a
  `db-lock` (a dedicated lock table, NOT memex's existing
  worker_lock): `core/db-lock.ts` (`tryAcquireDbLock` + `DbLockHandle`, TTL upsert
  + heartbeat steal-grace, `holder_pid` scoped refresh/release) over migration
  `050_cycle_locks.sql`. The maintenance cycle acquires `memex-cycle`, refreshes
  every 10m mid-run, releases in `finally`; a crashed holder is reclaimed after
  TTL/grace. MEDIUM fix applied: lock refreshes mid-run.
  - LOW follow-up: the release/refresh `WHERE` uses `id`+`holder_pid` only (no
    `holder_host`) — single-container so collision risk
    is nil. Add `holder_host` if a multi-host deploy ever lands.
- [x] `LINK_EXTRACTOR` bare-wikilink + verb-context resolution — bare-wikilink
  DONE/parity (v1.28.0): already covered by `extractWikilinks` + the
  `slug-canonicalize` exact-tail/prefix basename stages (no port needed).
  verb-context inference CORE done (v1.28.0): `core/link-verb-infer.ts`
  (`inferLinkType` + verbatim verb regexes + context window + `MEMEX_LINK_VERB_INFER`
  opt-in, default-OFF). codex: faithful/verbatim.
  - [x] **verb-context live wiring — DONE (v1.29.0).** `syncVerbLinksForPage`
    (links.ts) + migration 053 (`link_kind='verb_ner'` discriminator) + wired at
    page_put/append/revert behind `MEMEX_LINK_VERB_INFER` (default OFF). Owns +
    DELETE-replaces only its verb_ner set; yields to explicit/frontmatter edges
    via ON CONFLICT DO NOTHING. Reviewed: codex (no blockers — DELETE collision-
    free, CHECK swap lock-safe, yield-loop stable) + code-reviewer. LOW
    (page_revert unscoped delete) is pre-existing to the revert path + latent
    until the mig047 composite PK; LinkKind type kept plain|typed_ner
    (verb_ner is internal raw-SQL only, documented). **Closes the bare-wikilink +
    verb-context item → full link-extraction coverage.**
  - [x] Write `chunker_version` — DONE (v1.27.0). Per-document
    `documents.chunker_version` SMALLINT (migration 052, grandfather DEFAULT 1);
    `MARKDOWN_CHUNKER_VERSION`/`CODE_CHUNKER_VERSION` consts (both 1); stamped in
    the index UPSERT; `countStaleChunkerDocs` (kind-branched) + informational
    `chunker-version-lag` doctor check. Reviewed: codex (no blockers) +
    ai-engineer (faithful, no CRIT/HIGH; LOW two-kind-predicate + INFO detect-only
    both documented). Cost-prompt not ported (Bedrock, not OpenAI). Distinct from
    the inert `sources.chunker_version` source-level stub (mig024).
  - [x] **SHARED FOLLOW-UP (chunker_version + LINK_EXTRACTOR_VERSION) — DONE.**
    Both halves auto-remediate now instead of detect-only. LINKS: v1.38.0
    (`memex extract --stale`). CHUNKER: v1.39.0 (`memex reindex --rechunk-stale`)
    — `listStaleChunkerDocIds` + `sweepVault({forceStaleChunker})` re-index ONLY
    stale docs (re-chunk + re-embed the subset, not `--all`'s whole corpus).
    Stack note: memex stores no full doc body, so it re-reads the source file
    (vault). FOLLOW-UP (LOW): extend `--rechunk-stale` to the code corpus
    (`sweepCodeRoots`) — markdown/vault only today; code is ~0 live chunks.
  - [x] `LINK_EXTRACTOR_VERSION` staleness watermark — DONE (v1.26.0). Migration
    051 `pages.links_extracted_at`; `LINK_EXTRACTOR_VERSION_TS` +
    `stampLinksExtracted` (slug+source_id keyed) + `countStalePagesForExtraction`
    in core/links.ts; stamped after the full link-sync set at the 3 dispatch put
    paths; informational `links-extraction-lag` doctor check. Reviewed (workflow):
    fidelity + correctness SHIP; LOW source_id-keying fixed; LOW index/NOW left
    (faithful).
  - [x] **FOLLOW-UP (watermark review, MEDIUM) — DONE (v1.38.0).** Ported the
    batch `extract --stale` sweep so a `LINK_EXTRACTOR_VERSION_TS` bump
    auto-remediates untouched pages (re-sync edges + re-stamp). The version-bump
    arm is no longer detect-only. `core/links-stale-sweep.ts` +
    `listStalePagesForExtraction`/`markPagesExtractedBatch`. Approach:
    listStalePagesForExtraction + markPagesExtractedBatch stamping the read
    `updated_at` (the race fix).
  - [x] Stamp `content_flag` on results — DONE (v1.24.0). Adds
    `getContentFlagsByPageIds` + `stampContentFlags`:
    `core/search/content-flag.ts` reads `reason`/`detail` via `->>` and stamps
    `SearchHit.content_flag` post-fusion on both the live + cache-hit paths,
    fail-open. Doc-keyed over `documents.frontmatter` (stack adaptation).
  - [x] `embed_skip` frontmatter — DONE (v1.23.0). `core/embed-skip.ts`
    (`isEmbedSkipped` + `embedSkipFilterFragment`, sibling to quarantine.ts);
    gated at the inline indexer + embed-backfill (cycle re-embed inherits via
    indexDocument). Chunk-scoped; embed-coverage
    metric still counts the chunks. Operator-declared path only
    — the oversized auto-writer is the deferred content-sanity increment.
    ai-engineer: no CRIT/HIGH; 2 LOW (facts arm out-of-scope by design,
    future-stamper reindex contract) documented in the module header.
- [x] Advisor `collectUsageShape`: add orphan-pages + dead-links checks — DONE
  (v1.22.0). New `collectUsageShape` collector emits `orphan_pages` (islanded —
  no inbound AND no outbound live edge) + `dead_links` (live-source link whose
  target is not a live page); one read-only round trip, explicit-advisor only.
  Soft-delete adaptation gates every edge on a live page at both ends so the
  counts match hard-delete semantics. Live-verified on prod
  (4 orphans + 4 dead links). code-reviewer: SQL-safe, MEDIUM (zombie-source
  dead links) fixed by the live-source gate.

- [ ] **Brain federation** (deferred — operator, 2026-06-23). A network of
  memex brains (multi-source / multi-holder), likely on Supabase or a similar
  backend. Needs a per-source/per-user data model (memex is single-holder today
  — no `user_id` on documents/pages), cross-brain read grants, and an infra
  story. A *separate project*, not an increment — start with a design doc
  (tenancy + sync/clock + auth) before any code.
- [x] **Embedding 1024→1536** — DECIDED 2026-06-29: keep Bedrock Titan v2 (1024).
  A switch needs a paid provider change + full corpus re-embed + column migration,
  all against the cost-first rule with no measured retrieval-quality problem. The
  only adaptation to carry over when embeddings are next touched is making the
  dimension a config value. See the "Roadmap decisions" block at the top.
- [ ] **Enable OAuth in production** (operator action — code shipped default-OFF
  in v1.16.0). Before flipping `auth.oauth.enabled`: (a) terraform public ingress
  (ALB/SG/TLS + JWKS egress) via the ops dir; (b) decide tenancy (today every
  validated token maps to the one shared redacted scope); (c) pick an IdP + fill
  `auth.oauth`; (d) add a negative / per-IP cache to the JWKS fetch.

---

## Fidelity re-audit dispositions (2026-06-27)

A 6-unit re-audit of the shipped increments for implementation fidelity (not
freehand). Outcomes:
- **advisor usage-shape (v1.22)** — sound, no change.
- **alias-hop (v1.21)** — FIXED (v1.24.1): removed the `LIMIT 8`, added
  `ORDER BY` for an unbounded `resolveAliases`.
- **content_flag (v1.24.0)** — re-derived faithfully mid-flight (dropped an
  invented `normalizeContentFlag`; now mirrors `getContentFlagsByPageIds`'s
  `->>` extraction).
- **embed_skip (v1.23)** — `isEmbedSkipped` uses key-existence (`Object.hasOwn`)
  instead of `value !== null`. KEPT memex's: it is consistent with
  memex's own SQL fragment (`? 'embed_skip'`), whereas aligning would re-import
  a known JS/SQL mismatch. Defensible improvement, documented.
- **embed-deadline (v1.21)** — the `embedQuery` test-seam is memex test infra;
  KEPT (the production path is correct; the seam is how
  memex's hermetic tests inject a deterministic embedder).
- **Retry-After header (v1.21)** — audit flagged a missing `?? 60` fallback;
  FALSE POSITIVE — memex's `retryAfterSeconds` is total (always a clamped
  number ≥1, 3600 cap when refill≤0), so it already delivers the intended
  behavior without dead code.
- **Rate-limit policy (pre-existing, NOT a port)** — memex sustains 1 token/s
  (capacity 30, not 0.5/s), and is single-stage (public/internal) rather than
  two-stage (pre-auth IP + post-auth token-id). These predate
  the Retry-After increment (the v1.3.x limiter). Operator policy decision —
  left as-is pending an explicit call.
- [x] **db-lock — FULL implementation done (v1.25.0).** Built the full
  db-lock core + safety/ops surface: `classifyHolderLiveness`/
  `isHolderDeadLocally`/`isLockHolderLive`, auto-takeover in `tryAcquireDbLock`,
  cleanup-registration via new `process-cleanup.ts`, `inspectLock`/
  `listStaleLocks`/`deleteLockRow`(+`IfStale`/`Exact`), `reapDeadHolderLocks`.
  `startCycleLoop.stop()` releases the in-flight lock; reap runs at tick start.
  Reviewed (parallel workflow): fidelity + security SHIP, one correctness HIGH
  (process-cleanup SIGTERM racing serve's graceful shutdown) fixed by scoping
  process-cleanup to abnormal signals only. Omitted
  `syncLockId`/`liveSyncStatus`/`withRefreshingLock`/`tryWithDbElection`/
  `buildTenantLockId` (no memex consumer — building it = dead code).
  - NOTE (docker deploy model): memex runs one container; each new container
    has a fresh hostname, so the SAME-HOST auto-takeover + `reapDeadHolderLocks`
    rarely fire across a deploy (PID-1 death = container death = new hostname).
    The practically-active release-on-deploy path is the hostname-independent
    cleanup-registration + `cycle.stop()` release. The same-host pieces are
    fully wired (active if a process ever dies WITHIN a living container);
    a TTL-expired row from a pre-fix container is reclaimed by the upsert on the
    next tick regardless. If a stable-host or multi-host model ever lands, the
    same-host paths become load-bearing.


## Parity gap backlog (2026-06-09)

Source: a full subsystem-by-subsystem review of this brain's
retrieval implementation. memex stays **brain-only** — the
agent/LLM-synthesis/auth/voice/self-upgrade half is deferred (north-star
gated), recorded below but not planned. Capabilities are described
generically.

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
  tradeoff (by design): a doc NOT in the result set that becomes
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
  uniform error handling + source-scope a base class would provide — a
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
  entry, passing the booleans down. A `buildOperationContext()` pattern
  would carry multi-source scoping + OAuth auth-tiers + budgets + source
  allow-lists — none of which memex has (single-source, single-holder bearer).
  Wrapping memex's one `isPublic` bit in a formal context OBJECT would be
  ceremony with zero functional benefit, against "don't refactor what isn't
  broken". Revisit only if a real second context dimension (tenancy/auth-tier)
  ever lands.
- [x] **Qrels format** (eval, medium) — DONE/moot. The adapter's only stated
  trigger is "before reusing external qrels" — which won't happen (those
  qrels are a private eval corpus; not importable). memex's own
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

#### From the 2026-06-13 EXHAUSTIVE re-comparison (5-agent subsystem fan-out vs `4ee530f v0.42.42.0`)
A full subsystem-by-subsystem diff (schema/chunkers/embeddings · retrieval/ranking/eval
· MCP/CLI/jobs/config · facts/links/graph · cycle/security/redaction). Security
swept clean — **no redaction-parity gap, no CRITICAL**: memex has a single public
ingress (`dispatchTool`), allowlist field redaction, and is strictly stronger than
an OAuth-scope-only model (no field redaction). The genuine
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
  Adapted to memex (char-bounded, no tokenizer): a 5-level
  delimiter cascade + CJK word-counting NOT ported (CJK = no live non-Latin
  corpus; the cascade is a token-aware refinement memex's char-greedy splitter
  doesn't need). codex caught the before-mergeShort count-shift; fixed.
- [x] **Graph-signals post-fusion stage** — ASSESSED → DOCUMENT-DEFER (evidence).
  The three graph signals map onto memex as: (a) **session-cluster
  diversification (~0.95x MMR-lite) = REDUNDANT** — memex already applies
  per-document dedup `maxPerDoc:1` (`search/hybrid.ts:414`), a HARD one-chunk-
  per-document cap that's strictly stronger than a 0.95x demote; (b)
  **cross-source boost = DORMANT** — memex is single-source, so this signal is
  "dormant on single-source brains"; (c) **adjacency-hub
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

#### From the 2026-06-12 NIGHT re-comparison (v0.42.37 → v0.42.42)
Fetched the clone to `4ee530f v0.42.42.0` and diffed. Conclusion: **NO new
brain-only LLM-free candidate for memex** — every advance is already-done, N/A
to memex's architecture, or north-star:
- `v0.42.40` well-form lone UTF-16 surrogates → ALREADY DONE (memex v1.3.34).
- `v0.42.41` triage-wave: `venv/` skip in the code walker → ALREADY DONE
  (`sweep-code.ts` skips `.venv`/`venv`/`__pycache__`); OAuth authorize-scope
  default + legacy-token-scope → N/A (no OAuth, public-bearer model); AI-SDK
  asymmetric `input_type` on the wire → N/A (memex embeds via Bedrock Titan v2,
  symmetric, no AI-SDK adapter); **config `DATABASE_URL` cwd-`.env` hijack →
  N/A** (the hijack targets the GENERIC `DATABASE_URL` that any web-app
  `.env` sets; memex reads ONLY the namespaced `MEMEX_POSTGRES_URL`, which a
  random checkout's `.env` never contains, and the container `/app` has no cwd
  `.env` — verified). timeline-dedup-repair / extract-facts → LLM/north-star.
- `v0.42.42` CLI bounded-teardown for txn-mode poolers → infra N/A (memex's
  serve/CLI lifecycle differs; not a pooler-teardown shape).
- `v0.42.39` Retrieval Reflex (teach the agent when/what to retrieve) →
  AGENT-LAYER north-star (the agent is the MCP client), out of brain-only scope.
- `v0.42.37` jobs stale-lock reap → infra N/A (assessed earlier).

#### From the 2026-06-12 comparison (03ffc6e → ecd6ae8)
- [x] **Well-form lone UTF-16 surrogates before `::jsonb` (ingest, HIGH)** —
  DONE v1.3.34 (`core/well-form.ts`; applied at indexer-tx frontmatter +
  frontmatter-inference + pages compiled_truth; lone surrogate→U+FFFD + NUL
  dropped, valid pairs kept; integration proof test; code-reviewer CLEAN).
  Original note kept below for context.
- [ ] (context) the same bug class, seen elsewhere: a text window
  sliced by raw UTF-16 index (an `excerpt()` link-context) can leave an
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
- A separate `Retrieval Reflex` capability (teach the
  agent when/what to retrieve), is AGENT-LAYER (north-star, out of brain-only
  scope — the agent is Claude Code). Not planned. `v0.42.37.0` jobs stale-lock
  reap was already assessed N/A (infra memex doesn't run).

#### From the 2026-06-10 comparison (4-agent subsystem diff)
- [x] **Evidence + create_safety stamping** (retrieval, high) — DONE v1.3.19.
  `core/search/evidence.ts`; arm-membership adaptation (cosine
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
  `doc_comment`/`symbol_name_qualified` weight-A inputs don't exist
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
  table-row primitives). `| # | claim | confidence | source |`,
  strikethrough=inactive, memex-namespaced markers. Pure, INERT until
  `extract_facts`. Adapted to memex's simpler fact model (entity_facts);
  kind/visibility/notability/typed-claim columns NOT ported. Escape
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
- [x] **`symbol_name_qualified` column** (high) — DONE. The column lands in
  migrations 030 (weighted FTS) + 041 (code edges), with writers/readers in
  `indexer-tx.ts` + `cycle/resolve-symbol-edges.ts`. Dormant on the current
  markdown corpus (~0 code chunks) but fully wired for when a code-heavy corpus
  lands; the FTS weight-A sub-clause is redundant (same lexemes).
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
  `syncWikilinksForPage`. ADAPTED for memex: the usual cascade earns
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
  it is opt-in (not default-on) until the operator confirms
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
- [x] **Score-cliff autocut** (medium) — REJECTED by design. memex's hybrid score
  is RRF-fused (rank-reciprocal), which has no stable separatrix to cut on. The
  win (tight result sets) ships instead as the intent-aware adaptive return cap in
  `core/search/return-policy.ts` — see its header comment naming this exact
  rejection.
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
  OPTIONAL fact-text embedding (a find_trajectory enrichment, falls
  open) is a deferred follow-on; recompute_emotional_weight (page salience
  [0..1]) is a SEPARATE deferred item below. Original deferred design note: extract_facts is NOT
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
  falls-open by design). recompute_emotional_weight (page salience
  [0..1] from tags/takes) is a SEPARATE follow-on, also LLM-free.
- [x] **Page salience (recompute_emotional_weight equivalent)** (high) — DONE
  (migration 036). `pages.salience` REAL [0..1] recomputed by the new
  `recompute-salience` cycle phase. `computeSalience` (`core/salience-score.ts`)
  = high-emotion-tag boost (max 0.5, configurable seed set via
  `MEMEX_SALIENCE_HIGH_TAGS`) + ln-scaled link-degree boost (max 0.5, saturating
  at degree 20). ADAPTED for memex: the standard formula scores tags + "takes"; this
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
- [~] **Per-handler timeout_ms + deterministic stagger** (medium) — timeout_ms is
  DONE (jobs `timeout_ms` migration 039 + `parseWithBudget` for code parses). Only
  the FNV-1a cron stagger half remains, and it is MOOT today: a single cron-driven
  recipe has nothing to decorrelate. Revisit only at >1 concurrent recipe or a
  multi-worker fleet (mirrors `core/backoff.ts`). Deferred, not a gap.
- [x] **Code-chunk wall-clock timeout** (low) — DONE. `parseWithBudget`
  (`core/chunkers/parsers.ts`) runs every code parse under a wall-clock budget
  via tree-sitter's `progressCallback` (returning truthy from the periodic
  callback cancels the sync WASM parse → null → chunkCode throws → sweep-code
  skips the file). Default 5s, `MEMEX_PARSE_TIMEOUT_MS` override (0 disables).
  ADAPTED: the `setTimeoutMicros` approach mis-marshals its i64 arg under
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
  `source_chunk_id='meeting-timeline:<slug>'` — covers the
  `(page_id, date, summary, source)` intent (slug=page, occurred_at=date, the
  source key carries summary+source). Append-only: a removed attendee leaves a
  stale event (by-design timeline immutability), which is why it is opt-in.

### Schema / code-graph (in-scope, larger)
- [~] **`code_edges_chunk` (resolved) + `code_edges_symbol` (unresolved)** +
  **resolve_symbol_edges** (high) — ASSESSED 2026-06-13: **MOOT for memex as a
  dedicated-table re-model.** memex ALREADY has a working call graph via the
  entity-mention model: `extractCodeEntities` (core/code-entities.ts) extracts
  `call_expression`-derived `code-caller`/`code-callee`/`code-ref` entity
  mentions at INDEX time (the "unresolved code_edges_symbol"
  equivalent), and `code-callers`/`code-callees`/`code-refs`
  (commands/code.ts) RESOLVE name→defining-chunk at QUERY time by joining
  `chunks → entity_mentions → entities` through the `code-def` entity (the
  "resolved code_edges_chunk" equivalent, computed lazily). So the
  capability EXISTS; the only delta is a design that PERSISTS resolved edges in
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
  allow-list; token→client lookup. (This is the equivalent of
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

### Parity OK (no action)
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

### Cycle lock 5-min TTL — starvation-margin note (v1.48.0, review)
LOW/MEDIUM: with the lock TTL dropped 30→5 min, a cycle phase that blocks the
event loop SYNCHRONOUSLY for >5 min would stop the 30s refresher firing → the
TTL lapses → a concurrent same-host invocation (manual `memex cycle`, deploy
overlap) could steal the lock past the 100s steal-grace and run two cycles.
Narrow: phases are await-heavy (per-chunk Bedrock) so the loop yields, and the
deploy runs a single container with one loop; steal-grace is the backstop.
Acceptable for the single-instance deploy. Revisit (raise TTL or add a
worker-thread watchdog) only if a multi-instance or a known long-sync phase lands.

### Structural parity ports — DONE (v1.48.0–v1.50.0, 2026-06-29)
Operator ask: "build it exactly to spec, don't freehand."
A dynamic-workflow structure map produced detailed build specs; shipped:
- **v1.48.0 (#1 ingest size cap)** — the ROOT CAUSE of the 30MB frontmatter:
  cap content at 5MB on BOTH the file path AND the in-memory content
  path (a content-import guard); memex had only the file path. `indexDocument` now
  rejects >5MB (covers the remote `index` tool / page mirror / embed-stale).
- **v1.48.0 (#2 lock TTL 30→5min)** — a short-TTL+sub-TTL-refresh model
  so a crashed cross-host holder's lock frees in 5min; skipped tick re-arms within TTL.
- **v1.49.0 (#3 frontmatter at ingest)** — infer per-file at import,
  has NO frontmatter cycle phase. New `core/frontmatter-inference.ts` (empty
  DIRECTORY_RULES — that table is vault-specific) wired into `indexDocument`;
  the recurring DB phase DELETED (cycle now 12 phases). The OOM band-aids retired.
- **v1.50.0 (#4 incremental extract)** — extract only changed slugs; memex
  has no cycle sync phase, so migration 054 `documents.entities_extracted_at`
  watermark (its own mig-051 idiom) gates the cycle's extract to stale docs only.
  Extract RSS 1404MB→626MB, faster cycle. `extract --all` forces a full walk.
DATA cleanup — DONE (2026-06-29): 32 rows had `frontmatter` of `jsonb_typeof =
'string'` — a giant JSON scalar holding a whole file/email body (code docs,
`gmail:*`, `gcal`, `ops/*`), 420MB total. Reset to `'{}'::jsonb` in a txn (search
unaffected — metadata reads return NULL on a string anyway; bodies/chunks
untouched), then `VACUUM (ANALYZE)`. Max frontmatter 30MB→949KB, oversized rows 0.

### Frontmatter-as-scalar-string ingest bug — TODO (code, found 2026-06-29)
P2: the 32 cleaned rows prove an ingest path writes a whole file/email body into
`documents.frontmatter` as a JSON **scalar string** instead of a metadata object.
The v1.48 5MB cap only blocks rows ABOVE 5MB; the same parser path can still
mis-store sub-5MB content as a string frontmatter (post-cleanup max is already
949KB). Root cause is upstream of the cap — a frontmatter parser/fallback that
emits a scalar when YAML parse doesn't yield a mapping. Investigate the code-graph
indexer + gmail/gcal recipe ingest; reject/normalize non-object frontmatter at
`indexDocument` (coerce to `{}` or parse correctly). Harmless to the cycle today
(cap + incremental-extract + tags-only projection), so not urgent.

## Parity recompare backlog (2026-07-06) — ready to build

Full recompare done; v1.82–v1.84 live, v1.85/1.86 (parallel) tagged,
v1.87 built+pushed (deploy pending SSO). Remaining, ranked:

### Wave 2 — last core item (specced, not built)
- **Fenced-code extraction** (`chunk_source='fenced_code'`). Migration 093:
  `ALTER TABLE chunks ADD COLUMN chunk_source TEXT` (nullable). In `indexer.ts`
  after `chunkMarkdown`, extract each ```lang fence; if the tag is in the
  6-grammar set (parsers.ts CodeLanguage: typescript/tsx/python/bash/go/sql — map
  aliases ts/py/sh) run `chunkCode(source, pseudoPath, lang)` and append the
  code chunks as `ChunkWrite`s stamped `chunk_source='fenced_code'` with
  language/symbol/start-end lines; other tags fall through as prose. Extend
  `ChunkWrite` + the indexer-tx INSERT with `chunk_source`. Cap fences/page
  (`MEMEX_MAX_FENCES_PER_PAGE` default 100 — embed-cost DOS guard). Bypass
  contextual-retrieval wrapping for fenced_code chunks (like whole-code docs).
  HIGH risk to hot ingest path → deploy + reindex + verify with SSO up.

### Wave 3 — admin observability
- `/admin/api/agents/spend` (per-OAuth-client daily spend vs budget — ledger
  exists), `/admin/api/stats` + `/admin/api/health-indicators` (active tokens,
  tokens expiring 24h, 24h error-rate), `/admin/api/requests` filters
  (agent/op/status) + params column, per-token post-auth rate-limiter + env knobs.

### Wave 4 — DB receipt/cache tables
- drift_decisions (apply/audit trail), calibration holder-scoping, page-level
  FTS / searchable timeline, code_traversal_cache, conversation_parser_llm_cache,
  think_ab_results, eval_* receipt tables (mostly marginal).

### Wave 5 — CLI DX breadth
- op-registry CLI bridge, `publish` single-page HTML export, self-update family,
  jobs --follow, generic backfill runner, frontmatter tooling, features scan.

### Wave 6 — evals (non-CI, billable)
- longmemeval harness, takes-quality judge eval, contradiction eval,
  conversation-parser eval.

### Wave 7 — ASK-items (operator approved all)
- unified LLM gateway (retry/backoff/timeout/inflight/isAvailable), unified
  model-routing resolver + deep/Opus tier, sense connectors + integrations CLI,
  brainstorm/lsd/data-research paid slices, retrieval-reflex ambient layer.

### Pre-existing red (investigate)
- tests/facts_decay.test.ts "forces decay OFF on the public bearer path" returns
  0 world facts (expected 3) — fails on baseline a3ebe89 (parallel rerank/doctor
  commits), NOT from the recompare batch. Visibility-floor public path.

## Deferred real gap (Wave 4, 2026-07-07) — page/timeline FTS
memex FTS indexes only chunks.search_vector; second-brain `pages`
(compiled_truth+markdown_body) and `timeline_events` text are NOT keyword/recall
searchable (only exact-slug or graph walk). Real blind spot. Build = pages.search_vector
(weighted title A / truth+body B / timeline C, trigger-maintained) + a new page arm in
core/search/hybrid.ts alongside the chunk arm. MEDIUM-HIGH risk (touches live ranking) —
needs its own spec + careful eval, not a schema-only change. HIGH value.

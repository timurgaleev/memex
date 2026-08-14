# TODO — memex-stack

Forward-looking work that is intentionally deferred. Items already
shipped live in [`CHANGELOG.md`](./CHANGELOG.md); items rejected as
out-of-scope live under "NOT in scope" in the design doc that
introduces them.

---

## Open — lint backlog (2026-08-13)

A linter was run over the daemon source for the first time. The raw run reported
2375 problems; roughly 2000 were house conventions this codebase made
deliberately (bracket env access, import order, `require("process")` in an ESM
Bun daemon), and `eslint.config.js` turns each of those off with its reason
written next to it. **252 remain**, measurable with `make lint-ts`.

**CORRECTION (2026-08-14). The "zero defects" line that stood here was wrong,
and it was wrong for a specific, repeatable reason: the sample was eight
patterns, measured in isolation.** Widening to 48 sites and driving the REAL
exported functions instead of the bare regexes found seven genuinely quadratic
scans, all reachable at the input sizes the code itself permits. Worst was
`extractWikilinks`: 1 MB of `[[a|` held the daemon for 243 seconds, on a path
with no cap on body length. Seven are fixed and pinned by linearity tests; see
CHANGELOG. Do not re-derive the old conclusion from a small sample.

Measuring in isolation moved sites in BOTH directions and must not be trusted
alone: `slugifyTarget` read 7.8 s isolated and 12 ms through the real function,
because a preceding `.replace()` makes the bad input unreachable.

What actually fixes this shape: a length bound on the offending class. Making
the run atomic does nothing when the cost is the forward scan rather than
give-back — that was tried twice on `links.ts` and measured as still quadratic
both times.

- **Zero defects from the other rules.** Three real slips, fixed: a `timeout`
  alternative already covered by the `timed?\s?out` beside it, `round` listed
  twice in one alternation, and a module imported on three separate lines. The
  four `no-dupe-disjunctions` / `no-contradiction-with-assertion` findings were
  each checked against 3,019 targeted strings plus 300,000 fuzz cases: all four
  were harmless redundancy, none changed an outcome.
- **86 findings remain**, all from the two super-linear rules and all at sites
  NOT yet measured (28 of the 76 distinct sites were never benchmarked). The
  rules stay at `error` — they earned it. Closing this means measuring each
  remaining site and either fixing it or disabling it at the line WITH ITS
  NUMBER, never a blanket switch in the config.

The value is forward as well as retrospective: it gates the unused binding,
duplicate import and dead alternative in code written tomorrow, which `tsc`
cannot see. Cost: +86 MB of node_modules, 28 top-level packages to 281.

## Open — push-bench follow-ups (2026-08-12)

The push benchmark (v1.119.0) shipped with one metric family. Recorded here
rather than left implied:

- **Two extraction blind spots it found**, pinned as expected misses in
  `src/core/bench/corpus/extraction-blind-spots.json`: an all-lowercase mention
  produces no entity candidates at all, and a sentence-opening capitalized
  stopword glues to the name (`"Did Dana ever hear back"` → candidate
  `"Did Dana"`), which fires for any `Did/Can/Will/Should <Name>` phrasing — a
  very common user shape. Fixing either SHOULD break the pinned scores; update
  the pin, not the label.
- **The other three metric families are not built**: know-to-ask (as a paired
  rate), cross-session continuity (a decision written in one session, recalled
  in a later one through a different client identity), and write-back fidelity
  (does the conversation→memory pipeline preserve the facts it claims, gradeable
  with a stubbed extractor at zero model cost).
- **No CLI command, no MCP tool, no persistence.** The harness returns results
  and the test asserts them. A `memex bench-push` wrapper needs entries in
  `src/cli-args.ts` and the derived-command test; persisting a trend needs a
  migration.

## New candidates — 2026-08-11 sweep

Surfaced after the 2026-08-10 backlog was frozen. CLI-4 shipped in v1.112.0; BENCH-1 is open.

- **[BENCH-1, L] Nothing measures the agent-facing behaviour of the brain —
  only its retrieval.** `eval-probe` scores hit-rate and rank over a golden
  query set into `eval_snapshots`, which grades *search*. It says nothing about
  the four things an MCP client actually experiences: whether volunteered
  context is precise and complete (`push_precision` / `push_recall` over
  gold-labelled turns), whether the brain surfaces something when it should and
  stays silent when it should not (a failure rate paired with a false-fire rate,
  so "always inject" cannot game the score), whether a decision written in one
  session is recalled in a later session through a *different* client
  (continuity), and whether the conversation→memory write-back preserves the
  facts it claims to (fidelity, gradeable with a stubbed gold extractor so the
  shipped pipeline runs end to end at zero LLM cost, with an opt-in live-model
  mode for extraction precision/recall).
  - Why it matters here: memex already ships every mechanism being graded —
    `volunteer_context`, push-context, `extract-conversation-facts`,
    `source_session` — and none of them has a number attached. A regression in
    injection quality is currently invisible.
  - Shape: fixtures of labelled turns + one in-memory PGLite reused across the
    whole run with table resets between fixtures (per-fixture WASM cold boots
    blow any CI budget — the same heap-growth constraint that forces
    `test:sharded`), plus a scoreboard. Deterministic and free by default.

- **[CLI-4, S] SHIPPED v1.112.0.** `--help` on a subcommand errored instead of printing help.
  Verified 2026-08-11: `memex search --help` → "`<query>` is required",
  `memex jobs --help` → "subcommand required", `memex auth --help` → a usage
  line on stderr with a non-zero exit. `doctor --help` and `embed --help` are
  fine, so the handling is per-command rather than central. Intercept `--help`
  in `parseArgs` before required-argument validation.

---

## Open — no surface reports what the advisor counts (2026-08-11)

Two advisor findings count a condition no command or tool can list, which is why
both of their `fix_command` pointers were wrong twice over — every candidate
measures an adjacent but different set. The findings now state the condition in
`detail` and carry no fix_command. Closing this properly means giving each
condition a first-class surface:

- **Islanded pages.** Advisor counts a live page with no live inbound AND no
  live outbound link. `find_orphans` (core/insights.ts:117-127) checks only
  `NOT EXISTS (SELECT 1 FROM links WHERE target_slug = p.slug)` — it ignores
  outbound links entirely and does not require the linking source to be live.
  Either widen `find_orphans` with an opt-in `strict` mode matching the advisor
  definition (additive, no wire break), or add a dedicated surface.
- **Dead links.** Advisor counts a `links` row whose source is a live page and
  whose target has no live page. `memex reconcile-links` compares wikilink
  ENTITIES against DOCUMENTS — different tables, different condition, so it can
  report clean while the count stands. Needs its own check, most naturally a
  doctor probe (this is the DOC-1 shape).

Found by the cross-model review pass, after two in-house rounds had accepted the
wrong pointers.

## LOW backlog (CLI, 2026-08-11)

- **`-h` never reaches the short-help branch.** `src/cli.ts:536` tests
  `flags.has("-h")`, but `parseArgs` only collects `--`-prefixed tokens, so a
  bare `-h` lands in `positional` and the branch is dead. Either accept `-h` in
  the parser as an alias for `--help`, or drop the branch. Pre-existing.

## LOW backlog (millisecond-tie orderings, 2026-08-10)

`listFacts` was fixed to end every ordering in `id DESC` — `written_at` is
`DEFAULT NOW()` at millisecond resolution, so rows written in the same
millisecond tie and the scan decides the order. The same pattern is still
open in six sibling queries; none is asserted by a test today, so each is a
latent flake plus an agent-visible "most recent" that isn't stable:

- `core/hot_memory.ts:192` (`effective_confidence DESC, written_at DESC`) and
  `:237` (`written_at DESC`) — the latter feeds the `_meta.brain_hot_memory`
  injection, i.e. the "most recent" an MCP client sees.
- `core/links.ts:420`, `core/links-read.ts:74`, `:82` — `links.written_at`
  (migration 016).
- `core/cycle/embed-facts.ts:55` and `core/cycle/consolidate-facts.ts:225` —
  the exact `entity_facts.written_at DESC` pattern just fixed in `listFacts`.

Each is a one-line `, id DESC` append. Batch them rather than one at a time,
and note the same index caveat: `(entity_slug, written_at DESC)` no longer
satisfies the ordering on its own — immaterial at these table sizes.

---

## Review-accepted follow-ups (2026-08-02 triple review: security + retrieval + correctness)

Findings from the v1.106.0 review pass that were deliberately accepted or
deferred (everything CRITICAL/HIGH and one-touch MEDIUM was fixed in the
same batch):

- **Contextual re-embed uses the deterministic tier only.** The backfill
  re-wrap cannot reproduce an LLM-blurb prefix (the `contextual_embedded`
  marker records no tier), so a re-embed of an LLM-tier chunk downgrades it
  to the deterministic prefix. Recording the tier needs a column; until
  then `reindex --contextual --force` re-runs the configured tier.
- **Phantom flattened entity keys are not backfilled.** Facts previously
  keyed under `people-bob` (the flattened form of `people/bob`) stay under
  the old key until the source page's facts re-extract; a merge migration
  cannot distinguish genuinely-hyphenated entities from flattened paths.
- **ANN boost/max-pool orderings defeat HNSW.** The curation-boost and
  max-pool arm variants order by expressions the index cannot serve (full
  scan); the ef_search raise deliberately skips them. Emitting the plain
  `ORDER BY vector <=> $1` when the curation map is empty would restore
  index service for the common case — measurable, larger change.
- **Unpriced (non-Claude) synthesis model now skips paid phases** at the
  pre-flight with "budget exhausted" instead of running and failing at
  settle. Bedrock-Claude-only is the standing posture, so this is the
  intended fail-cheap direction; revisit only if the model roster widens.
- ~~**`pg_trgm` similarity over non-Latin slugs depends on DB locale**~~ —
  VERIFIED on the live RDS 2026-08-03: `similarity()` over a Cyrillic slug
  pair returned 0.46 (non-zero), so the trgm canonicalize stage works for
  Cyrillic slugs. Closed.
- **Alias claims are not fenced per client** — an in-prefix page can claim
  an alias norm an out-of-prefix page owns; `resolveAliasUnique` then
  returns null for both (silent mutual kill). Low blast radius; needs an
  ownership rule in `setPageAliases`.
- **DCR (`MEMEX_ENABLE_DCR_INSECURE=1`) mints unbounded clients** — with
  the flag on, self-registration sidesteps the slug fence by design.
  Default-off; the flag's name already carries the warning.
- **Chat importer emits no per-message ids** — the conversation-parser
  body format has no citation lane; `conversation_id` frontmatter is the
  provenance anchor for now.

## Deferred sweep tail (2026-07-27)

- **`set_take_status` can flip a zero-yield memo into a belief.** The memo the
  takes phase writes for a document that extracted no claims is fenced out of
  every read that lists or counts takes, but `set_take_status` addresses a row
  by `take_key`, so a caller that knows (or recomputes) a memo's key can mark it
  `accepted`; `recompute-salience` then counts it because it ignores `active`.
  No surface hands that key out, so this needs the caller to derive the hash
  itself — internal-only, not a leak. Closing it means either fencing the
  mutator or teaching salience the `active` axis, which widens the diff past the
  batch it was found in. Deferred deliberately.
- **A forced re-index re-pays one atom extraction.** The indexer replaces
  `documents.frontmatter` wholesale, so a rechunk or re-embed of unchanged
  content clears the `atoms_scan_hash` stamp and the phase scans that document
  once more. This fails in the safe direction (a re-scan, never permanent
  suppression); revisit only if
  forced re-indexes become routine.

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

## Prod-audit findings (2026-07-07 session 2)

A live prod audit (SSM → container + RDS) found prod **healthy and in sync**:
container healthy/running/restarts=0 (OOM resolved, cycle rss 122MB), doctor all
green (brain 12/0, ops 7/0), migrations prod hi=94 == code 094, 0 NULL-source
docs, 8 sources, no errors in 24h logs. Follow-ups surfaced:

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
- **[RESOLVED 2026-07-13] `source_grants=0`.** Moot: the brain is
  single-person by decision — the second tenant was removed from prod and the
  `source_grants` table dropped (migration 098).
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
buildable has been shipped (see CHANGELOG).

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

## LOW backlog (v1.81.0 build review, 2026-07-06)

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

## 2026-07-02 — capability + tiers session (v1.57 → v1.72) DONE

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

### Structural ingest + lock work — DONE (v1.48.0–v1.50.0, 2026-06-29)
Operator ask: "build it exactly to spec, don't freehand."
A dynamic-workflow structure map produced detailed build specs; shipped:
- **v1.48.0 (#1 ingest size cap)** — the ROOT CAUSE of the 30MB frontmatter:
  the cap covered the file path only, so anything arriving in memory was
  unbounded. Content is now capped at 5MB on BOTH paths; `indexDocument`
  rejects >5MB (covers the remote `index` tool / page mirror / embed-stale).
- **v1.48.0 (#2 lock TTL 30→5min)** — a short-TTL+sub-TTL-refresh model
  so a crashed cross-host holder's lock frees in 5min; skipped tick re-arms within TTL.
- **v1.49.0 (#3 frontmatter at ingest)** — infer per-file at import instead of
  in a recurring cycle phase. New `core/frontmatter-inference.ts` (empty
  DIRECTORY_RULES — that table is vault-specific) wired into `indexDocument`;
  the recurring DB phase DELETED (cycle now 12 phases). The OOM band-aids retired.
- **v1.50.0 (#4 incremental extract)** — extract only changed slugs. With no
  cycle sync phase to hang it off, migration 054 adds a
  `documents.entities_extracted_at` watermark that gates the cycle's extract to
  stale docs only. Extract RSS 1404MB→626MB, faster cycle. `extract --all`
  forces a full walk.
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

## Deferred real gap (2026-07-07) — page/timeline FTS
memex FTS indexes only chunks.search_vector; second-brain `pages`
(compiled_truth+markdown_body) and `timeline_events` text are NOT keyword/recall
searchable (only exact-slug or graph walk). Real blind spot. Build = pages.search_vector
(weighted title A / truth+body B / timeline C, trigger-maintained) + a new page arm in
core/search/hybrid.ts alongside the chunk arm. MEDIUM-HIGH risk (touches live ranking) —
needs its own spec + careful eval, not a schema-only change. HIGH value.

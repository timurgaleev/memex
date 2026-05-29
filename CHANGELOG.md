# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

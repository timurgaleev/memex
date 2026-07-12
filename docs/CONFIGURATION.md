# Configuration reference

Every runtime knob memex reads is an environment variable prefixed `MEMEX_`.
This page is the authoritative list: each row gives the variable, its default,
what it does, and whether it costs money.

## How configuration flows

There are two gates between a value you type and the running process:

1. **The host `.env` file** — `/opt/memex/.env` on the live instance (generated
   by `scripts/init.sh`, then extended by `scripts/bootstrap.sh` at boot). This
   is what `docker compose --env-file .env` reads.
2. **The compose allowlist** — the `environment:` block in
   `deploy/docker-compose.yml`. **Only variables listed there are passed into
   the container.** A flag set in `.env` but absent from the allowlist does
   nothing — compose never forwards it.

So enabling a flag is a two-step operation: put it in `.env`, and make sure the
same key appears in the compose `environment:` block. The secret-backed values
(`MEMEX_POSTGRES_URL`, `MEMEX_PUBLIC_BEARER`) arrive by a third path — the
`env_file: .secrets/memex.env` written by `deploy/secrets/fetch-secrets.sh` —
not the allowlist.

The tables below mark each variable's allowlist status:

- **allowlisted** — already in the compose `environment:` block; set it in
  `.env` and recompose.
- **code-only** — read by the source but *not* in the default allowlist. To use
  it you must **add the key to the compose `environment:` block yourself**, then
  set it in `.env`. These are mostly retrieval-tuning knobs left at their
  built-in defaults.

## How to enable a flag

```bash
# 1. On the live host, add the flag to /opt/memex/.env
echo 'MEMEX_DREAM_SYNTHESIS=1' >> /opt/memex/.env

# 2. Confirm the key is in the compose allowlist (environment: block).
#    If it is "code-only" below, add a line to deploy/docker-compose.yml:
#      - MEMEX_MYFLAG=${MEMEX_MYFLAG:-}
#    and commit/deploy that change first.
grep MEMEX_DREAM_SYNTHESIS deploy/docker-compose.yml

# 3. Recompose only the memex service so it picks up the new env.
docker compose --env-file .env -f deploy/docker-compose.yml up -d memex

# 4. Verify the process actually sees it, and the brain is healthy.
docker exec deploy-memex-1 sh -c 'echo "$MEMEX_DREAM_SYNTHESIS"'
curl -s http://127.0.0.1:18790/health   # -> {"ok":true,...}
```

A boolean flag is "on" only for the exact value the code checks (usually `=1`).
Numeric knobs fail **loud** on a malformed value — a typo aborts the process at
boot rather than silently falling back, so a bad edit is caught immediately.

---

## Quality & cost tiers (pick one)

memex's **runtime code ships everything paid OFF by default** — a bare
`git clone` is a pure retrieval brain that never makes a billable model call
beyond embeddings, so cloning the repo can never surprise you with a bill. The
opt-in happens one layer up: **`scripts/init.sh` defaults to the Max quality
tier** and writes those flags into the generated (gitignored) `.env`, so a real
operator install gets the full-featured experience by default. Pick `balanced`
or `free` at the init prompt, or set `MEMEX_INIT_TIER=free|balanced|max` for the
non-interactive path. **More spend buys more quality** — the paid tiers below are
what the project is capable of at its best, and Max is the *recommended* setup.
Change tiers any time by editing the flags in `.env` (all are in the compose
allowlist) and recomposing.

| Tier | What you get | Flags | ~Cost/mo* |
|------|--------------|-------|-----------|
| **Free — Retrieval** (default) | Hybrid search + graph + code intel. No LLM calls beyond embeddings. | *(none)* | infra only (~$52) |
| **Balanced — Haiku** *(best value)* | + Haiku two-pass rerank on every search, nightly note synthesis, per-source health, tenant fail-closed. Sharper ranking + a self-thinking brain, cheaply. | `MEMEX_RERANK` `MEMEX_DREAM_SYNTHESIS` `MEMEX_DOCTOR_PER_SOURCE` `MEMEX_TENANT_FAIL_CLOSED` | +$5–15 |
| **Max quality — Sonnet** *(recommended for best results)* | Everything. Sonnet graph-aware rerank on every search, relational reasoning, `think`, scheduled deep-synth, take-ensemble grading, conversation→facts, per-chunk LLM contextual embeddings. The full-fat brain. | all of the above **plus** `MEMEX_GRAPH_RERANK` `MEMEX_RELATIONAL_LLM` `MEMEX_THINK` `MEMEX_DEEP_SYNTH` `MEMEX_TAKE_ENSEMBLE` `MEMEX_FACTS_EXTRACTION` `MEMEX_CONTEXTUAL_LLM` | +$25–390 |

\* Above the ~$52/mo fixed infra (one small EC2 + RDS). Variable cost is
dominated by **`MEMEX_GRAPH_RERANK`** — a paid Sonnet call on *every* search, so
it scales with query volume (the swing between the $25 and $390 ends of the Max
tier). If you want Max-tier reasoning everywhere *except* the per-search Sonnet
cost, run the **Balanced** tier's `MEMEX_RERANK` (Haiku, ~$1–3/mo) in place of
`MEMEX_GRAPH_RERANK` — near-identical ranking quality at a fraction of the cost.
Every paid Sonnet slice is independently bounded by a `*_BUDGET_USD` cap
(default `1.0`), so no single call or run can run away.

---

## 1. Core / required

The values a working install cannot start without. The first three come from
Secrets Manager (via `fetch-secrets.sh`), not the compose allowlist.

| Variable | Default | What it does | Cost |
|---|---|---|---|
| `MEMEX_POSTGRES_URL` | *(none — required)* | RDS Postgres connection URL (`postgres://…?sslmode=require`). Injected from the `<prefix>/memex-postgres-url` secret via `.secrets/memex.env`. Without it the index has nowhere to live. | free |
| `MEMEX_PUBLIC_BEARER` | *(none)* | Bearer token that authenticates incoming public `/mcp` requests. Injected from `<prefix>/memex-public-bearer`. Rotated daily by `scripts/rotate-memex-public-bearer.sh`. | free |
| `MEMEX_INTERNAL_TOKEN` | *(none)* | Shared bearer authenticating peer containers on the internal docker bridge to memex's mutating routes. From `<prefix>/memex-internal-token`. | free |
| `MEMEX_HOST` | `127.0.0.1` | Bind host / public hostname for the server. `init.sh` sets it to `<subdomain>.<domain>`; the CLI `--host` flag overrides. | free |
| `MEMEX_SUBDOMAIN` | `brain` | The public MCP subdomain. Consumed by `init.sh`/`bootstrap.sh` to compose `MEMEX_HOST`; it is *not* read directly by the server at runtime (the terraform var `memex_subdomain` is the source of truth). | free |
| `MEMEX_VAULT_PATHS` | `/memory` (compose) | CSV of directory roots the indexer may sweep and the path-guard treats as in-bounds. Mounted read-only into the container. | free |
| `MEMEX_CODE_PATHS` | `/repo-source` (compose) | CSV of repo checkouts the code-chunkers index (call/def/ref graph). Empty → boot warns "0 indexable files" and continues. | free |

`MEMEX_VAULT_PATH` (singular) is a legacy fallback read only by the `integrity`
command; prefer the plural `MEMEX_VAULT_PATHS`.

---

## 2. Retrieval & ranking (free)

Pure-retrieval tuning. All run locally against Postgres + the Titan embedding
already computed — no per-call model cost. Most are **code-only**: they have
sensible built-in defaults and are not in the compose allowlist, so add the key
to `environment:` before overriding.

| Variable | Default | What it does | Cost |
|---|---|---|---|
| `MEMEX_GRAPH_SIGNALS` | off (`=1` on) | Fold graph centrality signals into the ranking score. | free |
| `MEMEX_GRAPH_SIGNALS_FLOOR` | unset (gate off) | Ratio in `0..1`; hits below the floor are excluded from the graph boost. Unset → every hit stays eligible. Fail-loud on out-of-range. | free |
| `MEMEX_RECENCY_DECAY` | built-in map | Per-path-prefix half-life/floor overrides, merged over the default decay map (`prefix:halfLifeDays:floor`, CSV). Recency weighting is on by default. | free |
| `MEMEX_ALIAS_HOP` | on (`=0` off) | Inject up to 3 alias/redirect hops so a query for an alias also surfaces the canonical page. | free |
| `MEMEX_NEARDUP_JACCARD` | `0.85` | Jaccard threshold for near-duplicate collapse in results. A value `> 1.0` disables dedup. | free |
| `MEMEX_TITLE_BOOST` | `1.25` (on) | Multiplier applied to hits whose title matches the query. A value in `(0,1)` is inert (boost only multiplies up). | free |
| `MEMEX_CURATION_BOOST` | built-in map | Per-prefix score multipliers (`prefix:factor`, CSV). Set replaces the default map entirely. | free |
| `MEMEX_BACKLINK_BOOST` | on (`=0` off) | Always-on log-scaled backlink-count boost (`1 + 0.05·ln(1+in_degree)`, floor-gated) so hub pages carry a standing lift. `=0` disables. | free |
| `MEMEX_COSINE_RESCORE` | off (`=1` on) | Blend a query-chunk cosine term into the fused score (`0.7·RRF + 0.3·cosine`). Inert on the keyword-only fallback path. | free |
| `MEMEX_SEARCH_EXCLUDE` | empty | CSV of path prefixes to exclude from search results (e.g. `.raw/`). | free |
| `MEMEX_QUERY_CACHE` | on (`=0` off) | Cache query→results within a process. | free |
| `MEMEX_QUERY_CACHE_SEMANTIC` | off (`=1` on) | Adds a paraphrase arm to the query cache — a near-identical query hits on query-embedding cosine instead of an exact-string match. Only ever *adds* hits; never suppresses a fresh search. (mig 065.) | free |
| `MEMEX_QUERY_EMBED_TIMEOUT_MS` | `6000` | Wall-clock budget for the query-embed Bedrock call; on timeout search falls back to keyword-only (non-fatal). Floor 2000ms. | free |
| `MEMEX_EMBED_DIM` | `1024` | Embedding vector width. Must match the `vector(...)` column width — changing it requires a schema migration + full re-embed. Fail-loud on a non-positive-integer value. | free |
| `MEMEX_CHUNK_OVERLAP` | `0` (off) | Characters of tail-of-previous-chunk to prepend to each chunk. `0` = byte-identical to no overlap. Capped at half the previous chunk. | free |
| `MEMEX_TRACK_RETRIEVAL` | on (`=0` off) | Write-back `last_retrieved` timestamps on hit. | free |
| `MEMEX_ANOMALY_SIGMA` | `2` | k in `mean + k·stddev` for usage-insight anomaly flags. | free |

`near_symbol` and `walk_depth` are **search-tool parameters**, not env vars —
pass them per call (`walk_depth` 1–2, capped at 2; inert unless `walk_depth > 0`
or `near_symbol` is set). They drive the structural call-graph expansion pass.

---

## 3. Agent-layer synthesis (cheap — Claude Haiku)

Opt-in synthesis chain (atoms → concepts → takes → grade → calibration) written
to the isolated `synth_*` store and read via `list_concepts` / `list_takes`.
Runs on Bedrock **Claude Haiku** (the utility tier — Amazon Nova was removed).
Cost is low but non-zero; all default OFF, so the brain is pure-retrieval unless
you opt in.

| Variable | Default | What it does | Cost |
|---|---|---|---|
| `MEMEX_RERANK` | off (`=1` on) | Two-pass rerank — reorders the top hybrid hits with one Claude Haiku call per search. The budget alternative to the paid Sonnet `MEMEX_GRAPH_RERANK`; near-identical ranking quality. | cheap (Haiku, ~$1–3/mo) |
| `MEMEX_DREAM_SYNTHESIS` | off (`=1` on) | Appends the Haiku synthesis chain to quiet-hours cycle ticks only. Idempotent, count-capped. | cheap (Haiku) |
| `MEMEX_DREAM_SYNTHESIS_MAX_DOCS` | `25` | Max source docs fed per synthesis run. | — |
| `MEMEX_DREAM_SYNTHESIS_MAX_CONCEPTS` | `30` | Max concepts produced per run. | — |
| `MEMEX_DREAM_SYNTHESIS_MAX_TAKES` | `25` | Max takes produced per run. | — |
| `MEMEX_DREAM_SYNTHESIS_MIN_GRADED` | `5` | Minimum graded takes before the run is considered complete. | — |
| `MEMEX_GRADE_MIN_AGE_DAYS` | `182` | Minimum age a take must reach before it becomes eligible for grading — lets a take settle before it is judged. `0` disables the gate. Fail-loud on a negative value. | free |
| `MEMEX_TAKE_EMBED` | off (`=1` on) | Embed each synthesized take so takes are semantically searchable; off leaves the take's embedding column NULL. | cheap (embed) |
| `MEMEX_DREAM_INTERVAL_S` | `21600` (6h) | Maintenance-cycle interval. | free |
| `MEMEX_DREAM_STALE_DAYS` | `30` | Re-embed docs older than this many days during the cycle. | free |
| `MEMEX_UTILITY_MODEL` | `eu.anthropic.claude-haiku-4-5-20251001-v1:0` | Overrides the Haiku utility-tier model id (intent classification, query expansion, synthesis). | cheap (Haiku) |

---

## 4. Paid opt-in Bedrock Sonnet slices

**Every flag here triggers a PAID Claude Sonnet call when set.** Each is bounded
by its own `*_BUDGET_USD` companion (default `1.0`) via a USD `BudgetTracker`
that stops making calls once the budget is spent. All default OFF.

| Variable | Default | What it does | Cost |
|---|---|---|---|
| `MEMEX_THINK` | off | Enables `memex think <q>` deep synthesis — **CLI-only**, does not fire on search. | **paid (Sonnet)** |
| `MEMEX_THINK_BUDGET_USD` | `1.0` | USD ceiling for `think`. | — |
| `MEMEX_THINK_AUTO_ANCHOR` | on (`=0` off) | When a temporal question ("when did X change, is it still…") names no anchor, `think` derives candidate entity slugs from the question + retrieved pages and anchors on them. Temporal/knowledge-update intents only, fail-soft. A behavior toggle inside the `think` flow — no extra billable call beyond `think` itself. | — |
| `MEMEX_RELATIONAL_LLM` | off | Sonnet fallback for the relational retrieval arm when the cheap path is inconclusive. | **paid (Sonnet)** |
| `MEMEX_RELATIONAL_LLM_BUDGET_USD` | `1.0` | USD ceiling for the relational arm. | — |
| `MEMEX_GRAPH_RERANK` | off | Sonnet rerank over graph-expanded candidates — **fires on every search**, so the highest-frequency paid path. Enable deliberately. | **paid (Sonnet)** |
| `MEMEX_GRAPH_RERANK_BUDGET_USD` | `1.0` | USD ceiling for graph rerank. | — |
| `MEMEX_DEEP_SYNTH` | off | Scheduled `think` over the top concepts during the cycle. | **paid (Sonnet)** |
| `MEMEX_DEEP_SYNTH_BUDGET_USD` | `1.0` | USD ceiling for deep-synth. | — |
| `MEMEX_DEEP_SYNTH_MAX_QUESTIONS` | built-in | Cap on questions per deep-synth run. | — |
| `MEMEX_TAKE_ENSEMBLE` | off | N-judge Sonnet grading of takes. | **paid (Sonnet)** |
| `MEMEX_TAKE_ENSEMBLE_BUDGET_USD` | `1.0` | USD ceiling for the ensemble. | — |
| `MEMEX_TAKE_ENSEMBLE_JUDGES` | `3` | Judges per take. | — |
| `MEMEX_FACTS_EXTRACTION` | off | Conversation → structured facts extraction via Sonnet. | **paid (Sonnet)** |
| `MEMEX_FACTS_BUDGET_USD` | `1.0` | USD ceiling for facts extraction. | — |
| `MEMEX_FACTS_MODEL` | `eu.anthropic.claude-sonnet-4-6` | Overrides the paid-tier Sonnet model id for the slices above. | **paid (Sonnet)** |
| `MEMEX_REFLECTIONS` | off | `reflections` cycle phase: one budget-capped Sonnet pass over recent un-reflected transcripts writes cited `reflections/<topic-slug>` pages, giving the `patterns` phase a source to mine. Runs before `patterns`. | **paid (Sonnet)** |
| `MEMEX_REFLECTIONS_BUDGET_USD` | `1.0` | USD ceiling for the reflections pass. | — |
| `MEMEX_REFLECTIONS_LOOKBACK_DAYS` | `14` | How far back the pass scans for un-reflected transcripts. | — |
| `MEMEX_REFLECTIONS_MAX_TRANSCRIPTS` | `20` | Max transcripts fed into one reflections pass. | — |
| `MEMEX_PATTERNS` | off | `patterns` cycle phase: one budget-capped Sonnet pass mines recent `reflections/` pages for themes recurring across ≥`MIN_EVIDENCE` distinct reflections and writes one `patterns/<topic-slug>` page each (citing its evidence). The one synthesis phase that writes real pages; reads/writes pinned to a single `source_id` (no cross-tenant mining). | **paid (Sonnet)** |
| `MEMEX_PATTERNS_BUDGET_USD` | `1.0` | USD ceiling for the patterns pass. | — |
| `MEMEX_PATTERNS_REFLECTION_PREFIX` | `reflections/` | Slug prefix the miner reads (kept in lockstep with what the reflections phase writes). | — |
| `MEMEX_PATTERNS_MIN_EVIDENCE` | `3` | Minimum distinct reflections a theme must span before a pattern page is written. | — |
| `MEMEX_PROBE_CONTRADICTIONS` | off | Latent-contradiction probe (mig 064): a paid cycle phase that caches LLM-suspected fact conflicts so `find_contradictions` can surface them. Paired candidates stay `source_id`-scoped (no cross-tenant pairing). | **paid (Sonnet)** |
| `MEMEX_PROBE_CONTRADICTIONS_BUDGET_USD` | `1.0` | USD ceiling for the contradiction probe. | — |
| `MEMEX_FACTS_BACKFILL` | off | `conversation-facts-backfill` cycle phase: extracts facts from historical transcripts that predate on-write extraction. Synthesis-written pages (`reflections/`, `patterns/`) are excluded from the selector. No-ops unless set truthy. | **paid (Sonnet)** |
| `MEMEX_FACTS_BACKFILL_BUDGET_USD` | `1.0` | Brain-wide USD ceiling for the backfill. | — |
| `MEMEX_CONTEXTUAL_RETRIEVAL` | off | **LLM-free** contextual-embed wrapper. ⚠️ Enabling it changes only *future* embeds — **run a full re-embed after enabling**, or the vector space becomes a mix of wrapped and unwrapped vectors and search quality degrades. | free (but forces re-embed) |
| `MEMEX_CONTEXTUAL_LLM` | off | **PAID per-chunk** contextual tier (Haiku): asks a utility model to write a short blurb situating EACH chunk within its whole document, replacing the deterministic synopsis before embedding. Fail-open — budget/errors fall back to the deterministic prefix. ⚠️ Same re-embed caveat as above; run `reindex --contextual` after enabling. | **paid (Haiku)** |
| `MEMEX_CONTEXTUAL_LLM_BUDGET_USD` | `5.0` | USD ceiling for the per-chunk LLM tier. Shared across a whole `reindex --contextual` run; when spent mid-run, remaining chunks fall back to deterministic. A later `--force` re-run with more budget upgrades them. | — |

---

## 5. Multi-tenancy & auth

| Variable | Default | What it does | Cost |
|---|---|---|---|
| `MEMEX_TENANT_FAIL_CLOSED` | off (`=1` on) | When on, an authenticated PUBLIC principal with no source grant reads/writes **nothing** instead of the redacted whole brain. The static bearer (no `authInfo`) is unaffected. Flip once a real remote OAuth tenant with a grant exists. | free |
| `MEMEX_PUBLIC_WRITE` | `0` | When `1`, the public `/mcp` path may call the constructive write tools (`index`, `page_put`, `page_append`, `add_fact`, `add_timeline_event`, `add_tag`, `link`). Destructive ops + privacy-sensitive reads stay internal-only regardless. Pair with daily bearer rotation. | free |
| `MEMEX_PUBLIC_READ_BODIES` | off (redacted) | When on, public reads return full page bodies instead of redacted snippets. Leave off on a shared brain. | free |
| `MEMEX_ADMIN_BOOTSTRAP` | unset | Admin-panel bootstrap token consumed by `serve.ts` at start. Must be 32+ chars from `[A-Za-z0-9_-]` or the server refuses to boot; unset ⇒ an ephemeral per-run token is printed to stderr. | free |
| `MEMEX_ENABLE_DCR` | off (`=1` on) | Dynamic Client Registration. Default OFF: `POST /register` returns 404 and discovery omits `registration_endpoint`, so no one can self-register a client — an operator creates clients via `memex auth register-client`. Turn on only if a client must self-register. | free |
| `MEMEX_OAUTH_REQUIRE_LOGIN` | off (`=1` on) | When on, `GET /authorize` requires a logged-in operator (admin session) before issuing an authorization code; off (default) auto-approves. Needs `MEMEX_ADMIN_BOOTSTRAP` set to be usable. | free |
| `MEMEX_PUBLIC_URL` | unset (request host) | External base URL (Cloudflare tunnel origin). When set, the OAuth discovery document + issuer advertise this `https://…` origin so a cloud MCP client auto-configures against the real host. | free |
| `MEMEX_HOT_MEMORY_META` | off (`=1` on) | Surface a `_meta` block on `hot_memory` responses (non-public calls only). Stays dark — empty payload — until an operator opts in. | free |
| `MEMEX_DOCTOR_PER_SOURCE` | off (`=1` on) | Makes `doctor` WARN per-source (per-tenant) when a single source has chunks but zero embeddings. | free |
| `MEMEX_REQUEST_LOG_DB` | off (`=1` on) | Persist per-request MCP logs to the DB (in addition to stderr). | free |
| `MEMEX_LOG_REQUESTS` | off | Emit redacted per-request MCP param logs to stderr. Nothing is logged unless set. | free |

See `docs/tenancy.md` for the full multi-tenant model.

---

## 6. Maintenance cycle & ingest / ops

Knobs for the 6-phase maintenance cycle, the file/code sweeps, migrations, and
job timeouts. The compose-allowlisted ones carry explicit defaults in
`deploy/docker-compose.yml`; the rest are code-only.

| Variable | Default | What it does | Cost |
|---|---|---|---|
| `MEMEX_CYCLE_PHASE_TIMEOUT_MS` | `900000` (15m) | Per-cycle-phase wall-clock cap so a hung phase can't wedge the tick and strand the cycle lock. | free |
| `MEMEX_CYCLE_SKIP_PHASES` | none | CSV of cycle phase names to skip every tick — operator escape hatch to isolate a phase with a live defect. | free |
| `MEMEX_CYCLE_FIRST_TICK_DELAY_MS` | built-in | Delay before the first cycle tick after boot (lower on a tiny instance). | free |
| `MEMEX_CYCLE_FRESHNESS_ENFORCE` | off (`=1` on) | Enforce (vs warn) the cycle-freshness staleness gate. | free |
| `MEMEX_CYCLE_FRESHNESS_WARN_HOURS` | `6` | Hours of cycle staleness before a WARN. Clamped ≤ the fail threshold. | free |
| `MEMEX_CYCLE_FRESHNESS_FAIL_HOURS` | `24` | Hours of cycle staleness before a failure. | free |
| `MEMEX_CYCLE_GC` | on (`=0` off) | Run the manual GC step each cycle. | free |
| `MEMEX_CYCLE_RSS_LOG` | on (`=0` off) | Log per-phase RSS memory during the cycle. | free |
| `MEMEX_SWEEP_DELAY_MS` | `50` (compose) | Delay between files during the content sweep. | free |
| `MEMEX_SWEEP_MAX_FILES` | `1000` (compose) | Max files swept per pass. | free |
| `MEMEX_CODE_SWEEP_DELAY_MS` | `20` (compose) / `0` | Delay between files during the code-index sweep. | free |
| `MEMEX_PARSE_TIMEOUT_MS` | `5000` (5s) | Per-file chunker parse cap; `0` disables the cap. | free |
| `MEMEX_JOB_TIMEOUT_MS` | off | Per-job wall-clock cap. Off unless set. | free |
| `MEMEX_MAX_BODY_BYTES` | `1048576` (1 MiB) | HTTP request-body size cap; over-cap requests get 413. | free |
| `MEMEX_NO_SANITY` | off (`=1` on) | Kill switch for the content-sanity ingest gate. Set truthy to skip junk/oversize/markup assessment entirely. The gate runs unless this is set. | free |
| `MEMEX_SANITY_DISPOSITION` | `quarantine` | How a junk-flagged doc is handled: default quarantines + stamps `content_flag` (still stored, embed-skipped); `reject` hard-rejects it at ingest. | free |
| `MEMEX_SANITY_LITERALS_FILE` | unset | Path to an operator literals file (one case-insensitive literal per line, blanks/`#` ignored) so site-specific boilerplate the built-in patterns miss is quarantined. Fail-open. | free |
| `MEMEX_PAGE_WARN_BYTES` | `50000` | Byte size above which a page crosses into the markup prose-check window. | free |
| `MEMEX_PAGE_BLOCK_BYTES` | `500000` | Byte size above which an oversize page is soft-blocked (no junk match required). | free |
| `MEMEX_MAX_MARKUP_RATIO` | `0.85` | Markup-to-prose ratio above which a page is flagged `markup_heavy` (flagged, not hidden). | free |
| `MEMEX_MIGRATION_LOCK_TIMEOUT` | `10s` | Per-migration advisory-lock timeout (e.g. `10s`, `500ms`, `5min`). Fail-loud on a malformed value. | free |
| `MEMEX_LOCK_STEAL_GRACE_SECONDS` | `600` | Grace before a stale cycle-lock holder can be taken over. Auto-derived from TTL when unset. | free |
| `MEMEX_EXTRACT_STALE_BATCH` | `50` | Batch size for the stale-links re-extract sweep. | free |
| `MEMEX_EXTRACT_TIME_BUDGET_MS` | `1800000` (30m) | Wall-clock budget for one stale-extract invocation. `--catch-up` removes the cap. | free |
| `MEMEX_EMBED_CONCURRENCY` | `8` | Max in-flight embed calls in the backfill fan-out pool; a full backfill is ~pool-size faster than serial. | free |
| `MEMEX_REEMBED_ON_SIGNATURE_CHANGE` | off (`=1` on) | Re-embed a chunk when the embed signature (model/dim/wrapper) changes, not just when its text changes. Opt-in by design — a bare toggle can trigger a large re-embed. | free (Bedrock embed) |
| `MEMEX_FACT_DECAY` | off (`=1` on) | Apply confidence decay to aging facts. | free |
| `MEMEX_FACTS_DEDUP` | off (`=1` on) | Insert-time fact dedup/supersede: a cosine-0.95 fast-path collapses near-identical tuples; off means exact-tuple dedup only. | free |
| `MEMEX_FACTS_DEDUP_LLM` | off (`=1` on) | Adds a paid classifier step to `MEMEX_FACTS_DEDUP` for the ambiguous near-duplicates the cosine fast-path can't decide. Inert unless `MEMEX_FACTS_DEDUP` is also on. | **paid (LLM)** |
| `MEMEX_FACTS_FENCE` | on (`=0` off) | Fence guard: a dedup supersede never suppresses an operator's fenced fact claim. Kill switch — leave on. | free |
| `MEMEX_TYPED_LINKS` | off (`=1` on) | Infer typed relations on links (opt-in; a wrong inferred relation is worse than none). | free |
| `MEMEX_LINK_VERB_INFER` | off (`=1` on) | Infer link verbs from surrounding text. | free |
| `MEMEX_GAZETTEER` | off (`=1` on) | Gazetteer-based auto-linking of known entities. | free |
| `MEMEX_MEETING_TIMELINE` | off (`=1` on) | Extract meeting entries into the timeline during the cycle. | free |
| `MEMEX_WIKILINK_CANONICALIZE` | built-in | Canonicalize wikilink slugs to their target pages. | free |
| `MEMEX_WIKILINK_TRGM` | built-in | Use trigram similarity to resolve fuzzy wikilink slugs. | free |
| `MEMEX_SALIENCE_HIGH_TAGS` | built-in | CSV of tags treated as high-emotion/high-salience in salience recompute. | free |
| `MEMEX_CONFIG_PATH` | built-in | Override path to the on-disk config file. | free |
| `MEMEX_AUDIT_DIR` | built-in | Directory for the weekly audit file. | free |
| `MEMEX_WASM_DIR` | built-in | Override path to the tree-sitter WASM parser directory. | free |

---

## 7. Terraform infrastructure variables

Set in `terraform/terraform.tfvars` (generated by `scripts/init.sh`). Full
schema in `terraform/variables.tf`.

| Variable | Default | Description |
|---|---|---|
| `aws_region` | `eu-west-1` | AWS region for the stack. |
| `aws_profile` | `default` | AWS CLI profile (matches `~/.aws/config`). |
| `tfstate_region` | `eu-central-1` | Region of the S3 bucket holding terraform state (often differs from `aws_region`). |
| `domain` | `""` | Public root domain (e.g. `example.com`). Used by the Cloudflare Tunnel and OAuth flows. |
| `memex_subdomain` | `brain` | Subdomain serving the public MCP (e.g. `brain` → `brain.example.com`). |
| `github_owner` | `""` | GitHub username/org owning the public repo. |
| `repo_name` | `memex` | Public repo name; used for tags, S3 keys, tfstate prefix. |
| `secrets_prefix` | `memex` | Secrets Manager namespace — every secret is `<secrets_prefix>/<name>`. |
| `use_ssh_deploy_key` | `false` | Only true while migrating from a private SSH-clone flow. Public installs leave false (HTTPS clone). |
| `ssh_public_key` | `""` | Public key to register as the EC2 key pair. Empty skips key-pair creation (SSM replaces SSH). |
| `project_name` | `memex` | Prefix for AWS resource names + on-host paths (`/opt/<project>`, `/mnt/<project>-efs`). |
| `instance_type` | `t4g.medium` | EC2 instance type (Graviton ARM64). Must be ARM64-compatible unless you also change the AMI filter. |
| `ebs_volume_size` | `20` | Root EBS volume size (GB). |
| `vpc_cidr` | `10.0.0.0/16` | VPC CIDR block. |
| `public_subnet_cidr` | `10.0.1.0/24` | Public subnet CIDR for the primary AZ. |
| `availability_zone` | `eu-west-1b` | AZ for the primary subnet. |
| `multi_az_subnet_cidrs` | `{eu-west-1a=10.0.2.0/24, eu-west-1c=10.0.3.0/24}` | Extra subnets to satisfy the RDS multi-AZ subnet group. |
| `bedrock_allowed_regions` | EU family + `us-east-1` | Regions where the instance role may invoke the expensive Claude models; an IAM Deny blocks `anthropic.claude-*` elsewhere. |
| `bedrock_model_id` | `global.amazon.nova-2-lite-v1:0` | Bedrock CRIS inference-profile id for the primary model, validated against an allowed list. The **runtime** utility tier is set separately via `MEMEX_UTILITY_MODEL` (Claude Haiku); this terraform var governs IAM/output scope. |
| `alarm_email` | `""` | Email for the EC2 status-check CloudWatch alarm. Empty skips email (alarm still fires). |
| `ssh_allowed_cidr` | `""` | CIDR allowed inbound SSH. Empty disables SSH — use SSM Session Manager. |
| `enable_vpc_endpoints` | `false` | Enable interface VPC endpoints (Bedrock, SM, SSM, Logs). ~$43/mo — off for personal use. |
| `enable_cloudtrail` | `true` | Enable CloudTrail API auditing (logs in S3, 90-day retention). |
| `repo_url` | `""` | Git URL the EC2 clones at first boot. HTTPS for public repos; SSH form needs `use_ssh_deploy_key = true`. |

> The `bedrock_model_id` default still names Nova at the terraform/IAM layer, but
> the **retrieval brain calls only Anthropic models via Bedrock at runtime** —
> Claude Haiku for the utility tier (`MEMEX_UTILITY_MODEL`) and Claude Sonnet for
> the paid slices (`MEMEX_FACTS_MODEL`). Amazon Nova was removed from the request
> path.

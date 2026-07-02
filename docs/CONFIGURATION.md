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
| `MEMEX_RERANK` | off (`=1` on) | Enable the cross-encoder-style rerank pass over hybrid hits. | free |
| `MEMEX_GRAPH_SIGNALS` | off (`=1` on) | Fold graph centrality signals into the ranking score. | free |
| `MEMEX_GRAPH_SIGNALS_FLOOR` | unset (gate off) | Ratio in `0..1`; hits below the floor are excluded from the graph boost. Unset → every hit stays eligible. Fail-loud on out-of-range. | free |
| `MEMEX_RECENCY_DECAY` | built-in map | Per-path-prefix half-life/floor overrides, merged over the default decay map (`prefix:halfLifeDays:floor`, CSV). Recency weighting is on by default. | free |
| `MEMEX_ALIAS_HOP` | on (`=0` off) | Inject up to 3 alias/redirect hops so a query for an alias also surfaces the canonical page. | free |
| `MEMEX_NEARDUP_JACCARD` | `0.85` | Jaccard threshold for near-duplicate collapse in results. A value `> 1.0` disables dedup. | free |
| `MEMEX_TITLE_BOOST` | `1.25` (on) | Multiplier applied to hits whose title matches the query. A value in `(0,1)` is inert (boost only multiplies up). | free |
| `MEMEX_CURATION_BOOST` | built-in map | Per-prefix score multipliers (`prefix:factor`, CSV). Set replaces the default map entirely. | free |
| `MEMEX_SEARCH_EXCLUDE` | empty | CSV of path prefixes to exclude from search results (e.g. `.raw/`). | free |
| `MEMEX_QUERY_CACHE` | on (`=0` off) | Cache query→results within a process. | free |
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
| `MEMEX_DREAM_SYNTHESIS` | off (`=1` on) | Appends the Haiku synthesis chain to quiet-hours cycle ticks only. Idempotent, count-capped. | cheap (Haiku) |
| `MEMEX_DREAM_SYNTHESIS_MAX_DOCS` | `25` | Max source docs fed per synthesis run. | — |
| `MEMEX_DREAM_SYNTHESIS_MAX_CONCEPTS` | `30` | Max concepts produced per run. | — |
| `MEMEX_DREAM_SYNTHESIS_MAX_TAKES` | `25` | Max takes produced per run. | — |
| `MEMEX_DREAM_SYNTHESIS_MIN_GRADED` | `5` | Minimum graded takes before the run is considered complete. | — |
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
| `MEMEX_CONTEXTUAL_RETRIEVAL` | off | **LLM-free** contextual-embed wrapper. ⚠️ Enabling it changes only *future* embeds — **run a full re-embed after enabling**, or the vector space becomes a mix of wrapped and unwrapped vectors and search quality degrades. | free (but forces re-embed) |

---

## 5. Multi-tenancy & auth

| Variable | Default | What it does | Cost |
|---|---|---|---|
| `MEMEX_TENANT_FAIL_CLOSED` | off (`=1` on) | When on, an authenticated PUBLIC principal with no source grant reads/writes **nothing** instead of the redacted whole brain. The static bearer (no `authInfo`) is unaffected. Flip once a real remote OAuth tenant with a grant exists. | free |
| `MEMEX_PUBLIC_WRITE` | `0` | When `1`, the public `/mcp` path may call the constructive write tools (`index`, `page_put`, `page_append`, `add_fact`, `add_timeline_event`, `add_tag`, `link`). Destructive ops + privacy-sensitive reads stay internal-only regardless. Pair with daily bearer rotation. | free |
| `MEMEX_PUBLIC_READ_BODIES` | off (redacted) | When on, public reads return full page bodies instead of redacted snippets. Leave off on a shared brain. | free |
| `MEMEX_ADMIN_BOOTSTRAP` | unset | One-shot admin/tenant bootstrap value consumed by `serve.ts` at start. | free |
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
| `MEMEX_MIGRATION_LOCK_TIMEOUT` | `10s` | Per-migration advisory-lock timeout (e.g. `10s`, `500ms`, `5min`). Fail-loud on a malformed value. | free |
| `MEMEX_LOCK_STEAL_GRACE_SECONDS` | `600` | Grace before a stale cycle-lock holder can be taken over. Auto-derived from TTL when unset. | free |
| `MEMEX_EXTRACT_STALE_BATCH` | `50` | Batch size for the stale-links re-extract sweep. | free |
| `MEMEX_EXTRACT_TIME_BUDGET_MS` | `1800000` (30m) | Wall-clock budget for one stale-extract invocation. `--catch-up` removes the cap. | free |
| `MEMEX_FACT_DECAY` | off (`=1` on) | Apply confidence decay to aging facts. | free |
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

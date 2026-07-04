# ARCHITECTURE.md

> Source-of-truth diagram + inventory for the `memex` stack.
> Updated alongside every terraform / compose / systemd change.

## Topology

```
              MCP clients (Claude Code, Cursor, Codex)
                            │
                  https://brain.<domain>/mcp
                            ▼
                   cloudflared (sidecar)
                            │
            ┌── docker-compose internal bridge ──┐
                            │
                          memex  (GET /health · POST /mcp)
                            │
        Bedrock Titan v2 (embeddings) + Claude Haiku (intent/expansion)
                  + opt-in Claude Sonnet (LLM synthesis)
                            │
                  RDS Postgres + pgvector
                            │
                  EFS (container runtime state)
                            │
                  AWS Secrets Manager
```

The stack runs as one VPC + one EC2 + one RDS + one EFS in a single
AWS region. There are no autoscaling groups, no orchestrator, no
external message broker — the whole runtime fits in `t4g.medium`.

## Container inventory

| Container | Image | Owns |
|---|---|---|
| `memex` | built from `deploy/memex/` (Bun + Alpine) | Knowledge brain: hybrid search (+ graph-signals ranking), entity + code call graph, code/markdown chunkers, fact extraction, push-context, advisor, MCP server (63 tools), a maintenance cycle (~15 deterministic phases + 8 opt-in LLM-synthesis phases). Two HTTP routes only: `GET /health` and `POST /mcp` — MCP is the contract (the legacy REST routes were removed in A.7). Bedrock: Titan v2 embeddings + Claude Haiku (intent/expansion) + the opt-in, off-by-default Claude Sonnet note synthesis. Answer synthesis is the MCP client's job. |
| `cloudflared` | `cloudflare/cloudflared:2025.4.0` (upstream) | Public HTTPS ingress (Cloudflare Tunnel). The dashboard routes `brain.<domain>/mcp` to memex on the internal docker bridge. |

Inter-container ports are not exposed to the host. `cloudflared`
reaches the memex MCP server over the compose `internal` bridge
network on `memex:18790`.

## memex daemon — internal modules

Beyond the per-recipe code under `deploy/memex/src/recipes/`, the
daemon ships a handful of focused infrastructure modules. Listed here
so future contributors don't reach for them blindly.

| Module | Responsibility |
|---|---|
| `core/engine/{factory,pglite,postgres,interface}.ts` | Engine abstraction. `factory.makeEngine(config)` returns either a PGLite (dev fallback) or postgres-js adapter; both implement the same `transaction()` surface so the migration runner can be atomic on either backend. |
| `core/path_guard.ts` | Confines the `index` MCP tool's `path` argument to `MEMEX_VAULT_PATHS` / `MEMEX_CODE_PATHS`. Uses `realpathSync` so a symlink inside the vault that points outside is resolved + rejected. Dotfile / `.env` / `.git` / `.obsidian` / `.ssh` / `credentials` deny-list applies even inside an allowed root. |
| `core/concurrency.ts` | Tiny FIFO `Semaphore` used by the file sweep to bound concurrent `indexFile()` calls. Avoids the busy-wait + non-deterministic ordering of `while inFlight.size >= N: await sleep`. |
| `http/body_limit.ts` | `parseJsonBody<T>(req)` — 1 MiB POST body cap (override via `MEMEX_MAX_BODY_BYTES`). Returns either parsed JSON or a ready-built `413`/`400` Response. Every POST handler uses this. |
| `http/public_guard.ts` | Detects a public Cloudflare-tunnel request (presence of `Cf-Connecting-Ip`), enforces bearer auth via `crypto.timingSafeEqual` on equal-length Buffers, and rejects mutating tools unless `MEMEX_PUBLIC_WRITE=1`. |
| `mcp/http_transport.ts` | MCP JSON-RPC POST handler. Public and internal traffic key into separate `RateLimiter` instances — public uses Cloudflare's `Cf-Connecting-Ip`, internal collapses to a single "internal" bucket (XFF / X-Real-IP are attacker-controlled and would defeat per-IP limits). |
| `mcp/rate_limit.ts` | Token-bucket limiter with periodic idle-bucket eviction + `maxKeys` cap — bounded memory under high public IP variety. |
| `core/migrate.ts` | Single-tx migration runner: `engine.transaction(tx => { tx.exec(sql); tx.query("INSERT INTO migrations …") })`. A crash between the two phases used to leave the migration applied-but-unrecorded → re-run on next boot, breaking non-idempotent SQL. |
| `core/code-graph.ts` + `core/code-edges.ts` + `core/code-entities.ts` + `core/code-walk.ts` + `core/chunkers/code.ts` | Code intelligence: indexing + call graph. `memex index` auto-detects source files (TS/Python), and the `code_callers` / `code_callees` / `code_def` / `code_refs` tools answer who-calls-what over `entity_mentions`, and `code_flow` / `code_blast` do a bounded transitive traversal (`walk_depth`). |
| `core/context/*` | Push-context (deterministic, no LLM): `volunteer.ts` extracts entities from a conversation window and resolves them to pages by alias/title/slug; `volunteer-events.ts` logs what was volunteered for a feedback metric. Backs the `volunteer_context` tool + `memex watch`. |
| `core/advisor/*` | Read-only diagnostics: ranks pending migrations / stalled jobs / low embed coverage / setup smells into `{severity, fix_command}` findings (the `advisor` tool). Reuses the doctor/status/jobs primitives. |
| `core/synthesis/*` + `core/llm/{haiku,sonnet}.ts` | **Opt-in, off-by-default** LLM synthesis phases: `extract-atoms → synthesize-concepts → propose-takes → grade-takes → calibration-profile`, plus `reflections`, `patterns` (theme miner), `probe-contradictions`, and `deep-synth`. `think` runs the same relational-LLM pass **CLI-only** (`memex think`, not an MCP tool) with an entity-extract auto-anchor. Output is written ONLY to dedicated `synth_*` tables — `documents`/`chunks`/`pages` are never mutated. `haiku.ts` (utility) and `sonnet.ts` (paid slices) are the shared Bedrock helpers, each with an injectable seam so tests run with zero Bedrock calls. |
| `core/facts*` (`facts-extract` · `facts-classify` · `facts-reconcile` · `facts-recall` · `facts-decay` · `facts-fence` · `facts-queue`) | Structured entity facts. On-write extraction pulls `{subject, predicate, object}` triples into `entity_facts`; `facts-fence.ts` renders the deterministic "facts fence" block appended to a page; reconcile dedups + supersedes stale facts (with a `forgotten_cause` audit) and decays confidence over time. Paid Sonnet tier, default-OFF; the `entity_facts` tool reads them back and `add_fact` / `forget_fact` mutate them. |
| `core/content-sanity.ts` | Ingest quality gate. Scores incoming chunk text against junk/boilerplate patterns (plus an operator literal channel, `MEMEX_SANITY_LITERALS_FILE`) and quarantines scraper garbage before it is embedded. Fail-open. |
| `core/contextual-reembed.ts` + `core/search/contextual-llm.ts` | **Opt-in** contextual retrieval (LLM tier): before embedding, a Haiku pass prepends a short document-situating blurb to each chunk so the vector carries whole-doc context. Tracked by `chunks.contextual_embedded` (migration 057); `memex reindex --contextual` re-embeds the corpus. |
| `core/search/query-cache.ts` | Semantic query cache (migration 065): a normalized-query + embedding-nearest lookup that returns a prior result set when a new query is semantically close enough, saving a full hybrid retrieval + embed round-trip. |
| `core/embed-backfill.ts` + `core/embedding.ts` | Embed provenance. Every vector is stamped with an `embedding_signature` (model + dim + contextual flag, migration 066); the opt-in `MEMEX_REEMBED_ON_SIGNATURE_CHANGE` auto-invalidates + re-embeds any row whose stored signature drifts from the current one. `core/embed-skip.ts` marks oversize / junk frontmatter as keyword-only (indexed, never embedded). Re-indexing a doc reuses a chunk's stored vector when its text is unchanged, so an edit only pays to embed the chunks that actually moved. |
| `core/scope.ts` + `core/tenant-grants.ts` + `core/visibility.ts` | Tenancy / scope. Every row carries a `source_id` tenant key; Postgres RLS (migration 049) + write-time fail-closed checks isolate tenants, `tenant-grants.ts` records cross-tenant read grants, and `scope.ts` defines the OAuth scope hierarchy (`read`/`write`/`admin`/`sources_admin`/`users_admin`/`agent`) the ingress gate enforces. |
| `http/oauth.ts` | **Default-OFF** optional OAuth/JWT bearer path. When `auth.oauth.enabled`, a Bearer JWT is verified against the issuer JWKS (RS256/ES256 via WebCrypto, no new dep); a valid token maps to the **public, redacted** read scope only — never internal, never a write path. |

## Access — MCP only

memex has no chat surface. Clients reach it exclusively over MCP:

```
MCP client (Claude Code / Cursor / Codex)
      │  Authorization: Bearer <public-bearer>
      ▼
https://brain.<domain>/mcp   →  cloudflared  →  memex:18790  POST /mcp
      │
      └─ tools/call { name: "search", arguments: { q, k } }  → hybrid retrieval
         (memex returns cited chunks; the MCP client composes the answer)
```

Hard guarantees:

- **Bearer-gated public ingress.** Every public `/mcp` request needs
  `Authorization: Bearer <public-bearer>`; the token rotates daily.
  Write tools are filtered from discovery and rejected from the public
  surface; internal write tools require `MEMEX_INTERNAL_TOKEN`.
- **Body redaction.** Public read tools omit note bodies unless
  `MEMEX_PUBLIC_READ_BODIES=1` — a leaked bearer can't exfil the vault.
- **Prompt-injection scrubs.** Retrieved chunks are wrapped in `<note>`
  tags; literal `<note>` / `<system>` / `[INST]` / `</s>` tokens inside
  chunk text are neutralised before going to Bedrock.

## AWS resource inventory

| Layer | Resource | Created by | Notes |
|---|---|---|---|
| Network | VPC, public subnet, IGW, route table | `terraform/vpc.tf` | Single AZ for the live instance; multi-AZ CIDRs reserved for future ASG. |
| Network | Security group | `terraform/ec2.tf` | Conditional SSH egress (only when `use_ssh_deploy_key = true`). |
| Compute | EC2 (t4g.medium, on-demand) | `terraform/compute.tf` | `lifecycle.ignore_changes = [ami, user_data]` — never replace on plan. |
| Compute | EIP | `terraform/compute.tf` | Public IP for Cloudflare Tunnel edge port (7844). |
| Storage | EFS file system + mount target | `terraform/efs.tf` | Backs container runtime state (memex config + recipe state). |
| Storage | RDS Postgres 16 (`db.t4g.micro`) | `terraform/rds.tf` | Hosts the memex index; `pgvector` extension enabled. |
| Storage | S3 — terraform state | `terraform/main.tf` (partial backend) | Bucket supplied via `terraform/backend.hcl` from `make init`. |
| Storage | S3 — scripts | `terraform/ec2.tf` | `<project>-scripts-<account_id>`; holds `scripts/bootstrap.sh`. |
| Identity | IAM role + instance profile | `terraform/iam.tf` | Bedrock invoke (Titan + Claude Haiku/Sonnet), Secrets Manager read/rotate, CloudWatch Logs write. |
| Secrets | AWS Secrets Manager | `terraform/secrets.tf` | All credentials live here. Naming: `<secrets_prefix>/<name>`. |
| Observability | CloudWatch log group | `terraform/cloudwatch.tf` | `/<project>/app`, 14-day retention. |
| Observability | SNS topic + email subscription | `terraform/cloudwatch.tf` | Conditional on `alarm_email != ""`. |
| Audit | CloudTrail | `terraform/cloudtrail.tf` | Conditional on `enable_cloudtrail = true`. Multi-region trail by default — captures IAM/STS calls regardless of source region. |

## Scheduled work (host-side systemd timers)

Installed once per deploy from `deploy/systemd/*.{service,timer}`.
Static checks in `tests/test_systemd_units.py` ensure every shipped
unit references a script that exists in the repo.

| Unit | Cadence | Owns |
|---|---|---|
| `memex-rotate-bearer.timer` | `*-*-* 06:00:00 Europe/Berlin` (daily) | Rotate `<secrets_prefix>/memex-public-bearer`, restage `.secrets/memex.env`, restart `memex` so it re-reads the new value. |
| `memex-eval-probe.timer` | `*-*-* 04:30:00 Europe/Berlin` (daily) | Nightly retrieval-quality probe: replays a golden query set, records hit-rate / rank metrics into `eval_snapshots`, and surfaces the latest snapshot in `memex doctor`. Staggered clear of the 06:00 rotation so the two units never contend for the container; `Persistent=true` reruns a missed slot. Takes a per-run USD ceiling (`--max-usd`). |

## Storage layout

```
/mnt/<project>-efs/<project>/      # EFS mount on the EC2 host
└── memex/                         # memex runtime config + soul templates

/opt/<project>/                    # repo checkout (cloned by bootstrap.sh)
├── .env                           # rendered by bootstrap.sh on every boot
├── deploy/                        # compose + container build contexts
├── scripts/                       # bootstrap, init, audit, helpers
└── terraform/                     # infra-as-code
```

The "code source" mount at `/mnt/<project>-efs/<project>-repo/` is a
second git checkout used by the memex code chunkers as their index
source. `scripts/bootstrap.sh` keeps it in sync on every boot.

The authoritative store is RDS Postgres, evolved by the numbered
migration runner (`core/migrate.ts`, through ~068). Beyond the core
`documents` / `chunks` / `pages` / `entity_mentions` tables, the schema
carries:

- `synth_*` — the opt-in LLM-synthesis output (atoms, concepts, takes,
  take grades, calibration profile, `synth_contradictions`); never mixed
  into the source note tables.
- `entity_facts` — structured `{subject, predicate, object}` facts with a
  consolidation + `forgotten_cause` audit trail, rendered back onto pages
  via the facts fence.
- `slug_aliases` (migration 067) — canonical-slug redirects so a renamed
  page keeps resolving from its old links.
- `eval_snapshots` (migration 068) — per-run retrieval-quality metrics
  from the nightly `eval-probe`.
- `query_cache` (migration 065) — the semantic query cache.
- typed `links` — edges carry a `kind`/`verb` (NER-inferred, migration
  053) plus a `source_id` tenant key, and every row is tenant-scoped
  under Postgres RLS (migration 049).

## Secrets — what goes where

| Secret name (under `<secrets_prefix>/`) | Consumer | Set by |
|---|---|---|
| `cloudflared-tunnel-token` | cloudflared | Manual; from Cloudflare Zero Trust dashboard. |
| `memex-postgres-url` | memex | terraform — auto-populated from RDS endpoint. |
| `memex-public-bearer` | memex | terraform — `random_password` resource generates at apply. memex validates incoming public `/mcp` bearers against it. Rotated daily by `memex-rotate-bearer.timer`. |
| `memex-internal-token` | memex (internal MCP write tools) | Manual; gates write `tools/call` on the internal path. |
| `github-deploy-key` | bootstrap | terraform — conditional, only when `use_ssh_deploy_key = true`. |

`deploy/secrets/fetch-secrets.sh` reads these into the on-host
`deploy/.secrets/*.env` files. Containers `env_file:` mount those at
container start; memex reads `MEMEX_PUBLIC_BEARER` from `memex.env`.

## Deploy flow

```bash
# From a maintainer laptop:
git push origin main

# From any shell on the EC2 (use AWS SSM Session Manager):
cd /opt/<project>
git pull --ff-only
bash deploy/secrets/fetch-secrets.sh                   # only if a secret changed
docker compose --env-file .env -f deploy/docker-compose.yml up -d --build
```

The boot flow (cold start from a new instance):

1. cloud-init writes `/etc/stack-env` from terraform user_data vars.
2. cloud-init downloads `scripts/bootstrap.sh` from the scripts S3 bucket.
3. `bootstrap.sh` installs docker, mounts EFS, clones the repo,
   conditionally fetches the SSH deploy key, renders `/opt/<project>/.env`,
   runs `fetch-secrets.sh`, and brings up the two-container compose
   stack (`memex`, `cloudflared`).

## Why this shape

- **Single EC2, no orchestrator.** One personal workload doesn't need a
  scheduler. The whole stack survives a `docker compose up -d --build`.
- **EFS for state, RDS for index.** EFS preserves runtime state
  (memex config, recipe checkpoints) across instance
  replacements. RDS preserves the memex index across container
  rebuilds (PGLite on EFS lost data on SIGKILL — the move to RDS
  fixed that class of failure).
- **Cloudflare Tunnel, no public ports.** The EC2 SG opens nothing
  inbound. cloudflared dials out on tcp/7844 only. SSH is opt-in via
  `ssh_allowed_cidr`; SSM Session Manager is the default access path.
- **Bedrock for inference (Anthropic-only + Titan).** Titan v2 supplies
  embeddings; Claude Haiku is the utility model (intent classification +
  query expansion); the opt-in, default-OFF synthesis + facts slices use
  Claude Sonnet. Answer synthesis is the MCP client's job. The
  deterministic core costs ~$25-30/mo even with daily use; the paid LLM
  slices only spend when explicitly enabled.
- **MCP only, no agent framework.** memex speaks plain MCP JSON-RPC and
  nothing else — no chat surface, no bot, no bespoke API. One contract.
- **Single-operator default, multi-tenant-capable.** The default deploy
  is one user's brain on one account. The substrate is nonetheless
  tenant-isolated: every row carries a `source_id` tenant key enforced by
  Postgres RLS + write-time fail-closed checks, so multiple sources can
  share one instance without leaking across the boundary.

## Out-of-scope (deferred — see `TODO.md`)

- Multi-region failover.
- A managed multi-tenant control plane (self-service onboarding, per-tenant
  billing). Row-level tenant isolation (`source_id` + RLS) ships today; the
  operator surface for running memex *as* a multi-tenant service does not.
- Read replicas / horizontal scaling.
- ASG + spot fleet (a multi-instance variant not built today; the
  current shape is one on-demand instance with
  `lifecycle.ignore_changes`).
- GitHub Pages docs site.
- Standalone memex publishing (npm package + container image).

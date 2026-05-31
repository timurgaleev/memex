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
                  Bedrock Haiku 4.5 (synthesis) + Titan v2 (embeddings)
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
| `memex` | built from `deploy/memex/` (Bun + Alpine) | Knowledge brain: hybrid search, entity graph, code chunkers, MCP server, 6-phase maintenance cycle. Two HTTP routes only: `GET /health` and `POST /mcp` — MCP is the contract (the legacy REST routes were removed in A.7). Synthesises answers via Bedrock Claude Haiku 4.5 + embeds via Titan v2. |
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
| `core/concurrency.ts` | Tiny FIFO `Semaphore` used by the obsidian recipe to bound concurrent `indexFile()` calls. Avoids the busy-wait + non-deterministic ordering of `while inFlight.size >= N: await sleep`. |
| `http/body_limit.ts` | `parseJsonBody<T>(req)` — 1 MiB POST body cap (override via `MEMEX_MAX_BODY_BYTES`). Returns either parsed JSON or a ready-built `413`/`400` Response. Every POST handler uses this. |
| `http/public_guard.ts` | Detects a public Cloudflare-tunnel request (presence of `Cf-Connecting-Ip`), enforces bearer auth via `crypto.timingSafeEqual` on equal-length Buffers, and rejects mutating tools unless `MEMEX_PUBLIC_WRITE=1`. |
| `mcp/http_transport.ts` | MCP JSON-RPC POST handler. Public and internal traffic key into separate `RateLimiter` instances — public uses Cloudflare's `Cf-Connecting-Ip`, internal collapses to a single "internal" bucket (XFF / X-Real-IP are attacker-controlled and would defeat per-IP limits). |
| `mcp/rate_limit.ts` | Token-bucket limiter with periodic idle-bucket eviction + `maxKeys` cap — bounded memory under high public IP variety. |
| `core/migrate.ts` | Single-tx migration runner: `engine.transaction(tx => { tx.exec(sql); tx.query("INSERT INTO migrations …") })`. A crash between the two phases used to leave the migration applied-but-unrecorded → re-run on next boot, breaking non-idempotent SQL. |

## Access — MCP only

memex has no chat surface. Clients reach it exclusively over MCP:

```
MCP client (Claude Code / Cursor / Codex)
      │  Authorization: Bearer <public-bearer>
      ▼
https://brain.<domain>/mcp   →  cloudflared  →  memex:18790  POST /mcp
      │
      └─ tools/call { name: "search", arguments: { q, k } }  → hybrid retrieval
         (memex synthesises grounded answers via Bedrock Claude Haiku 4.5)
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
| Identity | IAM role + instance profile | `terraform/iam.tf` | Bedrock invoke (Nova + Titan + Haiku), Secrets Manager read/rotate, CloudWatch Logs write. |
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
- **Bedrock for inference.** Haiku 4.5 composes grounded answers from
  retrieved chunks; Titan v2 supplies embeddings; the stack costs
  ~$25-30/mo even with daily heavy use.
- **MCP only, no agent framework.** memex speaks plain MCP JSON-RPC and
  nothing else — no chat surface, no bot, no bespoke API. One contract.
- **Solo-deploy.** No multi-tenancy. The "stack" is one user's brain on
  one account, by design.

## Out-of-scope (deferred — see `TODO.md`)

- Multi-region failover.
- Multi-tenant deploy.
- Read replicas / horizontal scaling.
- ASG + spot fleet (a multi-instance variant not built today; the
  current shape is one on-demand instance with
  `lifecycle.ignore_changes`).
- GitHub Pages docs site.
- Standalone memex publishing (npm package + container image).

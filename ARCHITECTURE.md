# ARCHITECTURE.md

> Source-of-truth diagram + inventory for the `memex` stack.
> Updated alongside every terraform / compose / systemd change.

## Topology

```
                       ┌──────── public ────────┐
                       │                        │
                  Telegram bot          https://<chat>.<domain>
                       │                        │
                       ▼                        ▼
              telegram-bridge              cloudflared (sidecar)
                       │                        │
            ┌────── docker-compose internal bridge ──────┐
            │            │              │                 │
        memex     openclaw     obsidian-sync          ...
            │            │              │
            │   ┌────────┴─────┐        │
            │   │              │        │
            │  Bedrock        Helpers   Obsidian Sync
            │  (Nova + Titan) (HA, gcal) (encrypted vault)
            │
       RDS Postgres            EFS (Obsidian vault, runtime state,
       + pgvector              soul templates)
            │
        AWS Secrets Manager
```

The stack runs as one VPC + one EC2 + one RDS + one EFS in a single
AWS region. There are no autoscaling groups, no orchestrator, no
external message broker — the whole runtime fits in `t4g.medium`.

## Container inventory

| Container | Image | Owns |
|---|---|---|
| `memex`   | built from `deploy/memex/` (Bun + Alpine) | Knowledge brain: hybrid search, entity graph, code chunkers, MCP server, 6-phase maintenance cycle |
| `openclaw`   | built from `deploy/openclaw/` (npm `openclaw@2026.4.29` on Alpine) | Chat agent: web UI gateway, cron scheduler, skill execution. Telegram channel disabled by default (`OPENCLAW_TELEGRAM_DISABLED=1`) so the bridge owns the bot's long-poll cleanly. |
| `telegram-bridge` | built from `deploy/telegram-bridge/` (Python 3 stdlib + aws-cli on Alpine) | Always-on two-way Telegram surface. Long-polls the Bot API, routes slash-commands (`/today`, `/week`, `/weather`, `/search`, …) to the `gcal` / `ha` helpers, and answers free text with a RAG pipeline (`memex /search` → Bedrock Nova Lite). Keeps the bot replying even when `openclaw` is restarting or stuck on a paired-device approval. |
| `cloudflared` | `cloudflare/cloudflared:2025.4.0` (upstream) | Public HTTPS ingress (Cloudflare Tunnel) for `<subdomain>.<domain>` and `brain.<domain>` |
| `obsidian-sync` *(deprecated)* | built from `deploy/obsidian-sync/` (Alpine + headless Obsidian) | Bidirectional sync to a hosted Obsidian vault. **Slated for removal in a future release** — vault sync will become user-provided. |

Inter-container ports are not exposed to the host. `cloudflared` reaches
the openclaw gateway over the compose `internal` bridge network on
`127.0.0.1:18789` (gateway port pinned in `deploy/openclaw/config.template.json`).

## AWS resource inventory

| Layer | Resource | Created by | Notes |
|---|---|---|---|
| Network | VPC, public subnet, IGW, route table | `terraform/vpc.tf` | Single AZ for the live instance; multi-AZ CIDRs reserved for future ASG. |
| Network | Security group | `terraform/ec2.tf` | Conditional SSH egress (only when `use_ssh_deploy_key = true`). |
| Compute | EC2 (t4g.medium, on-demand) | `terraform/compute.tf` | `lifecycle.ignore_changes = [ami, user_data]` — never replace on plan. |
| Compute | EIP | `terraform/compute.tf` | Public IP for Cloudflare Tunnel edge port (7844). |
| Storage | EFS file system + mount target | `terraform/efs.tf` | Backs the Obsidian vault and chat-agent runtime state. |
| Storage | RDS Postgres 16 (`db.t4g.micro`) | `terraform/rds.tf` | Hosts the memex index; `pgvector` extension enabled. |
| Storage | S3 — terraform state | `terraform/main.tf` (partial backend) | Bucket supplied via `terraform/backend.hcl` from `make init`. |
| Storage | S3 — scripts | `terraform/ec2.tf` | `<project>-scripts-<account_id>`; holds `scripts/bootstrap.sh`. |
| Identity | IAM role + instance profile | `terraform/iam.tf` | Bedrock invoke, Secrets Manager read/rotate, CloudWatch Logs write. |
| Secrets | AWS Secrets Manager | `terraform/secrets.tf` | All credentials live here. Naming: `<secrets_prefix>/<name>`. |
| Observability | CloudWatch log group | `terraform/cloudwatch.tf` | `/<project>/app`, 14-day retention. |
| Observability | SNS topic + email subscription | `terraform/cloudwatch.tf` | Conditional on `alarm_email != ""`. |
| Audit | CloudTrail | `terraform/cloudtrail.tf` | Conditional on `enable_cloudtrail = true`. Multi-region trail by default — captures IAM/STS calls regardless of source region. |

## memex daemon — internal modules

Beyond the per-recipe code under `deploy/memex/src/recipes/`, the
daemon ships a handful of focused infrastructure modules. Listed here
so future contributors don't reach for them blindly.

| Module | Responsibility |
|---|---|
| `core/engine/{factory,pglite,postgres,interface}.ts` | Engine abstraction. `factory.makeEngine(config)` returns either a PGLite (dev fallback) or postgres-js adapter; both implement the same `transaction()` surface so the migration runner can be atomic on either backend. |
| `core/path_guard.ts` | Confines the `/index` (HTTP + MCP) `path` argument to `MEMEX_VAULT_PATHS` / `MEMEX_CODE_PATHS`. Uses `realpathSync` so a symlink inside the vault that points outside is resolved + rejected. Dotfile / `.env` / `.git` / `.obsidian` / `.ssh` / `credentials` deny-list applies even inside an allowed root. |
| `core/concurrency.ts` | Tiny FIFO `Semaphore` used by the obsidian recipe to bound concurrent `indexFile()` calls. Avoids the busy-wait + non-deterministic ordering of `while inFlight.size >= N: await sleep`. |
| `http/body_limit.ts` | `parseJsonBody<T>(req)` — 1 MiB POST body cap (override via `MEMEX_MAX_BODY_BYTES`). Returns either parsed JSON or a ready-built `413`/`400` Response. Every POST handler uses this. |
| `http/public_guard.ts` | Detects a public Cloudflare-tunnel request (presence of `Cf-Connecting-Ip`), enforces bearer auth via `crypto.timingSafeEqual` on equal-length Buffers, and rejects mutating routes unless `MEMEX_PUBLIC_WRITE=1`. |
| `mcp/http_transport.ts` | MCP JSON-RPC POST handler. Public and internal traffic key into separate `RateLimiter` instances — public uses Cloudflare's `Cf-Connecting-Ip`, internal collapses to a single "internal" bucket (XFF / X-Real-IP are attacker-controlled and would defeat per-IP limits). |
| `mcp/rate_limit.ts` | Token-bucket limiter with periodic idle-bucket eviction + `maxKeys` cap — bounded memory under high public IP variety. |
| `core/migrate.ts` | Single-tx migration runner: `engine.transaction(tx => { tx.exec(sql); tx.query("INSERT INTO migrations …") })`. A crash between the two phases used to leave the migration applied-but-unrecorded → re-run on next boot, breaking non-idempotent SQL. |

## Scheduled work (host-side systemd timers)

Installed once per deploy from `deploy/systemd/*.{service,timer}`.
Static checks in `tests/test_systemd_units.py` ensure every shipped
unit references a script that exists in the repo.

| Unit | Cadence | Owns |
|---|---|---|
| `memex-gcal-poll.timer` | `*-*-* *:30:00 Europe/Berlin` (hourly) | Google Calendar poll → memex signal-detect → index. |
| `memex-gmail-poll.timer` | `*-*-* *:15:00 Europe/Berlin` (hourly) | Gmail recipe poll. |
| `memex-rotate-bearer.timer` | `*-*-* 06:00:00 Europe/Berlin` (daily) | Rotate `<secrets_prefix>/memex-public-bearer`, restage `.secrets/memex.env`, restart memex. |
| `memex-morning-briefing.timer` | `*-*-* 07:00:00 Europe/Berlin` (daily) | Compose a four-line briefing (HA weather + presence + house, GCal today), optionally render via Bedrock Nova Lite, deliver via Telegram Bot API. Falls back to a static template on any Bedrock error so the daily delivery never silently misses. |

## Storage layout

```
/mnt/<project>-efs/<project>/      # EFS mount on the EC2 host
├── vault/                          # Obsidian vault (mounted by obsidian-sync)
│   └── <write-allowed-root>/       # operator-chosen write subtree (journal/memory/inbox)
├── memex/                          # memex runtime config + soul templates
├── workspace/                      # openclaw session memory
├── tasks/, agents/, flows/, cron/  # openclaw runtime state
├── credentials/                    # device pairings + tokens
└── .obsidian-headless-config/      # headless Obsidian state (survives container)

/opt/<project>/                     # repo checkout (cloned by bootstrap.sh)
├── .env                            # rendered by bootstrap.sh on every boot
├── deploy/                         # compose + container build contexts
├── scripts/                        # bootstrap, init, audit, helpers
└── terraform/                      # infra-as-code
```

The "code source" mount at `/mnt/<project>-efs/<project>-repo/` is a
second git checkout used by the memex code chunkers as their index
source. `scripts/bootstrap.sh` keeps it in sync on every boot.

## Secrets — what goes where

| Secret name (under `<secrets_prefix>/`) | Owner | Set by |
|---|---|---|
| `telegram-bot-token` | openclaw | Manual: `aws secretsmanager put-secret-value` after creation. |
| `home-assistant-token` | helpers | Manual. |
| `obsidian-sync` | obsidian-sync | Manual JSON: `{email,password,totp_secret?}`. |
| `cloudflared-tunnel-token` | cloudflared | Manual; from Cloudflare Zero Trust dashboard. |
| `google-calendar` | openclaw helper | Manual; written by `scripts/gcal-oauth-bootstrap.py`. |
| `gateway-token` | openclaw | Manual; `openssl rand -hex 32`. |
| `memex-postgres-url` | memex | terraform — auto-populated from RDS endpoint. |
| `memex-public-bearer` | memex | terraform — `random_password` resource generates at apply. |
| `github-deploy-key` | bootstrap | terraform — conditional, only when `use_ssh_deploy_key = true`. |

`deploy/secrets/fetch-secrets.sh` reads these into the on-host
`deploy/.secrets/*.env` files. Containers `env_file:` mount those at
container start.

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
   runs `fetch-secrets.sh`, and brings up the compose stack.
4. `openclaw onboard` runs once on a fresh EFS; `scripts/post-onboard.sh`
   applies production config (control UI origins, model picker, etc.).

## Why this shape

- **Single EC2, no orchestrator.** One personal workload doesn't need a
  scheduler. The whole stack survives a `docker compose up -d --build`.
- **EFS for state, RDS for index.** EFS preserves the Obsidian vault and
  chat-agent runtime across instance replacements. RDS preserves the
  memex index across container rebuilds (PGLite on EFS lost data on
  SIGKILL — the move to RDS fixed that class of failure).
- **Cloudflare Tunnel, no public ports.** The EC2 SG opens nothing
  inbound. cloudflared dials out on tcp/7844 only. SSH is opt-in via
  `ssh_allowed_cidr`; SSM Session Manager is the default access path.
- **Bedrock for inference.** Nova family is credit-eligible; the stack
  costs ~$28/mo even with daily heavy use.
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

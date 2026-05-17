# AGENTS.md — Working in this Repo as an AI Agent

> Companion to `llms.txt` (which is the doc map). This file is how to *work*: build, test, deploy, commit. Read `CLAUDE.md` first — it carries the user's irrevocable rules.

## TL;DR

- Always confirm before destructive ops (commit, terraform apply, EC2 recreate).
- TDD where the logic is testable; smoke-test where the network is the test.
- Containers run on a single EC2; deploy = `git pull && docker compose up -d --build` over SSM.
- memex's brain index is rebuildable from the Obsidian vault; if RDS is wiped, re-sweep restores it (~5-10 min, $0 — Titan is credit-eligible).

## Build & test (memex)

```bash
cd deploy/memex
bun install               # frozenLockfile=true; never commit lock drift
bun test                  # ~70s end-to-end
bun run src/cli.ts --help # CLI surface
```

There is no `bun run build` step for runtime — the daemon starts via `bun run src/cli.ts serve`. The `build` script in `package.json` exists for diagnostic bundling, not deployment.

## Build & test (full stack — Docker)

The simplest "does my change build" check uses Docker locally (matches the EC2 architecture):

```bash
cd deploy
docker compose build memex            # ~30s on warm cache
docker compose build openclaw         # ~90s (npm openclaw + aws-cli + git)
docker compose build telegram-bridge  # ~25s
```

Full local up requires the secrets — they're gitignored and only fetched on the EC2. Don't try to bring up the stack on your laptop; smoke-test on EC2.

## Deploy

Always: `git push origin main` → SSH/SSM into EC2 → `cd /opt/<project> && git pull && docker compose --env-file .env -f deploy/docker-compose.yml up -d --build` → wait ~3 min for openclaw to stage plugin deps → `curl https://<subdomain>.<domain>/healthz`.

Never:
- `terraform taint aws_instance.memex`
- `terraform apply` without showing plan + getting explicit "yes apply"
- `docker compose down` (it's a no-op for state but cuts traffic; use `restart` instead)

## Commit etiquette

- One coherent change per commit. Migration in one, command in another, MCP in another, docs in another.
- Conventional-commit prefixes: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`.
- Never `--no-verify`, never `--amend` to a published commit.
- The user must say "commit it" / "go" / "yes commit" before `git commit`. Same for `git push`.

## Testing patterns we use

| What | How |
|---|---|
| Pure logic (chunker, RRF, entity extractor) | Bun tests, deterministic, ~10ms each |
| Storage + DB shape | tmp PGLite, seeded directly, no Bedrock (PGLite is dev-only; prod runs Postgres) |
| HTTP routes | `Bun.serve` on port 0, real fetch round-trip |
| MCP transport | `Bun.serve` on port 0 + JSON-RPC client via fetch |
| Bedrock-touching paths | Mocked at the embedding boundary; smoke-test live separately |

## Env vars worth knowing

```
AWS_REGION=<your-region>          # required
AWS_PROFILE=default               # required, not optional
SECRETS_PREFIX=memex              # AWS Secrets Manager namespace
MEMEX_VAULT_PATHS=/vault,/memory
MEMEX_SWEEP_DELAY_MS=50
MEMEX_SWEEP_MAX_FILES=1000
MEMEX_DREAM_INTERVAL_S=21600
MEMEX_DREAM_STALE_DAYS=30
MEMEX_HOST=0.0.0.0                # in the container; loopback off-EC2
BRAIN_PORT=18790
TUNNEL_TOKEN=<cloudflared>        # NOT CLOUDFLARE_TUNNEL_TOKEN — that's a different alias
```

## Failure modes to recognise

| Symptom | Likely cause |
|---|---|
| Telegram replies are npm error stack traces | `git` missing in openclaw image |
| `gcal` helpers ENOENT | `aws-cli` missing in openclaw image |
| Cloudflared retries forever, no traffic | `--protocol http2` not set; SG blocks UDP |
| openclaw won't open port 18789 after boot | Stale `plugin-runtime-deps/openclaw-X` from EFS full-home mount |
| memex `EACCES` reading `/memory` | Container running as uid 1000 (alpine `bun`); needs root |
| SSM `ConnectionLost`, healthz down | Likely OOM on too-small instance during sweep |

## When you don't know what to do

1. Read CLAUDE.md.
2. Read llms.txt for orientation.
3. `git log --oneline | head -20` — what was the last thing done?
4. `cat .ai-context/*.md` if you have local access — last session's handoff.
5. Ask the user — don't guess on irreversible ops.

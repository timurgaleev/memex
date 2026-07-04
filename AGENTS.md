# AGENTS.md — Working in this Repo as an AI Agent

> Companion to `llms.txt` (which is the doc map). This file is how to *work*: build, test, deploy, commit. Read `CLAUDE.md` first — it carries the user's irrevocable rules.

## TL;DR

- Always confirm before destructive ops (commit, terraform apply, EC2 recreate).
- TDD where the logic is testable; smoke-test where the network is the test.
- Containers run on a single EC2; deploy = `git pull && docker compose up -d --build` over SSM.
- memex's brain index is rebuildable from source content; if RDS is wiped, re-sweep restores it (~5-10 min, $0 — Titan is credit-eligible).
- memex is reached over MCP only (`POST /mcp` via cloudflared). No chat surface, no bot — just MCP clients (Claude Code, Cursor, …).

## Required workflow — run the skill for every change

No change is "done" until the skills have run. For **every** change —
features, fixes, refactors, docs, infra — in order:

1. **Self-review skill/agent.** Dispatch the review agent whose
   specialty matches what you changed (the table in `CLAUDE.md` →
   "Self-review after each implementation"): `security-engineer` for
   auth / secrets / ingress, `code-reviewer` for logic / refactor,
   `quality-guard` for new tests, `devops-automator` for CI / docker /
   terraform, `ai-engineer` for engine / MCP / retrieval,
   `reality-checker` for "it's live now" claims, `bug-hunter` for
   adversarial sweeps, `technical-writer` for docs. Act on every
   CRITICAL / HIGH finding before declaring done.
2. **Ship workflow.** Follow `CLAUDE.md` → "Ship workflow":
   **test → push → deploy → verify → release**, in that order, every
   time. A change is not shipped until the live EC2 is running it and
   `/health` + the MCP smoke-test pass; user-facing version bumps
   end with a SemVer tag + GitHub release (see "Release" below).

Both are non-negotiable and apply even to one-line fixes — the cost of
one extra skill/agent run is cheaper than a production regression.

## Build & test (memex)

```bash
cd deploy/memex
bun install               # frozenLockfile=true; never commit lock drift
bun test                  # ~70s end-to-end
bun run src/cli.ts --help # CLI surface
```

There is no `bun run build` step for runtime — the daemon starts via `bun run src/cli.ts serve`. The `build` script in `package.json` exists for diagnostic bundling, not deployment.

## CLI commands worth knowing

`bun run src/cli.ts <cmd>` (aka `memex <cmd>` in the container). `--help` lists them all; the ones you'll reach for most:

```
export [--dir DIR] [--source ID]     # dump every live page to a markdown tree (frontmatter + body,
                                      #   slug dirs); --source scopes to one tenant. Backup / portability
                                      #   escape hatch for the DB-only substrate.
eval-probe [--limit N] [--max-usd N] # replay the eval set, append a row to eval_snapshots (nightly
                                      #   probe); --max-usd caps per-run spend (converts to a query cap).
cycle [--phases a,b,c] [--stale-days N]  # run one maintenance cycle on demand. Now takes the daemon's
                                      #   `memex-cycle` advisory lock — a one-shot skips (with a message)
                                      #   when the periodic loop holds it, so the two can't double-spend.
```

The take-review lifecycle is exposed over MCP, not the CLI: `list_takes` / `takes_search` (trigram search over take claims) to find takes, `set_take_status` to flip one to `accepted` / `rejected`.

## Build & test (full stack — Docker)

The simplest "does my change build" check uses Docker locally (matches the EC2 architecture):

```bash
cd deploy
docker compose build memex            # ~30s on warm cache
```

Full local up requires the secrets — they're gitignored and only fetched on the EC2. Don't try to bring up the stack on your laptop; smoke-test on EC2.

## Deploy

Always: `git push origin main` → SSH/SSM into EC2 → `cd /opt/<project> && git pull && docker compose --env-file .env -f deploy/docker-compose.yml up -d --build` → wait for `memex` to report `Up <N> (healthy)` → smoke-test the MCP surface from inside the network:

```bash
docker exec deploy-memex-1 sh -c '
  echo "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"stats\"}}" \
    | wget -qO- --post-file=/dev/stdin --header=Content-Type:application/json http://127.0.0.1:18790/mcp
'
```

Then confirm `brain.<domain>/mcp` answers an MCP client (Claude Code).

Never:
- `terraform taint aws_instance.memex`
- `terraform apply` without showing plan + getting explicit "yes apply"
- `docker compose down` (it's a no-op for state but cuts traffic; use `restart` instead)

## Release

For a user-facing version bump, after deploy + verify are green:

1. Roll `[Unreleased]` in `CHANGELOG.md` into `## [X.Y.Z] — <date>`
   (SemVer), leaving an empty `[Unreleased]` on top.
2. Tag the shipped commit and push it: `git tag vX.Y.Z && git push
   origin vX.Y.Z`.
3. Publish the release: `gh release create vX.Y.Z --title vX.Y.Z
   --notes "<the changelog section>"`.

The tag must point at a CI-green commit that is already live on the
EC2 — never tag ahead of deploy. `package.json` versions are decoupled
and are not bumped as part of a release.

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
MEMEX_VAULT_PATHS=/memory         # paths memex sweeps for content
MEMEX_SWEEP_DELAY_MS=50
MEMEX_SWEEP_MAX_FILES=1000
MEMEX_DREAM_INTERVAL_S=21600
MEMEX_DREAM_STALE_DAYS=30
MEMEX_HOST=0.0.0.0                # in the container; loopback off-EC2
BRAIN_PORT=18790
MEMEX_PUBLIC_BEARER=<token>       # validated on public /mcp; rotated daily
MEMEX_INTERNAL_TOKEN=<token>      # gates MCP write tools on the internal path
TUNNEL_TOKEN=<cloudflared>        # NOT CLOUDFLARE_TUNNEL_TOKEN — that's a different alias
```

## Failure modes to recognise

| Symptom | Likely cause |
|---|---|
| Public `/mcp` returns 401 | `MEMEX_PUBLIC_BEARER` missing/stale in `memex.env`; rotation didn't restart memex |
| memex healthcheck flaps `starting → unhealthy` | PGLite cold-init / RDS unreachable; check `docker logs deploy-memex-1` |
| MCP write tool returns -32001 on internal path | `MEMEX_INTERNAL_TOKEN` not configured or not sent |
| Cloudflared retries forever, no traffic | `--protocol http2` not set; SG blocks UDP |
| memex `EACCES` reading `/memory` | Container running as uid 1000 (alpine `bun`); needs root or correct EFS chown |
| SSM `ConnectionLost`, healthz down | Likely OOM on too-small instance during sweep |
| MCP returns `401` for tools/call | Bearer in `Authorization: Bearer <token>` header doesn't match `MEMEX_PUBLIC_BEARER` env on the memex container; rotation may have advanced AWSCURRENT |

## When you don't know what to do

1. Read CLAUDE.md.
2. Read llms.txt for orientation.
3. `git log --oneline | head -20` — what was the last thing done?
4. `cat .ai-context/*.md` if you have local access — last session's handoff.
5. Ask the user — don't guess on irreversible ops.

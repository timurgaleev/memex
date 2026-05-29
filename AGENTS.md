# AGENTS.md — Working in this Repo as an AI Agent

> Companion to `llms.txt` (which is the doc map). This file is how to *work*: build, test, deploy, commit. Read `CLAUDE.md` first — it carries the user's irrevocable rules.

## TL;DR

- Always confirm before destructive ops (commit, terraform apply, EC2 recreate).
- TDD where the logic is testable; smoke-test where the network is the test.
- Containers run on a single EC2; deploy = `git pull && docker compose up -d --build` over SSM.
- memex's brain index is rebuildable from source content; if RDS is wiped, re-sweep restores it (~5-10 min, $0 — Titan is credit-eligible).
- The chat path is `telegram-bridge` → memex MCP + Bedrock Haiku 4.5. There is no agent framework in the middle.

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
   `/health` + the bridge smoke-test pass; user-facing version bumps
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

## Build & test (full stack — Docker)

The simplest "does my change build" check uses Docker locally (matches the EC2 architecture):

```bash
cd deploy
docker compose build memex            # ~30s on warm cache
docker compose build telegram-bridge  # ~25s
```

Full local up requires the secrets — they're gitignored and only fetched on the EC2. Don't try to bring up the stack on your laptop; smoke-test on EC2.

## Deploy

Always: `git push origin main` → SSH/SSM into EC2 → `cd /opt/<project> && git pull && docker compose --env-file .env -f deploy/docker-compose.yml up -d --build` → wait for `telegram-bridge` to report `Up <N> (healthy)` → smoke-test from inside the bridge:

```bash
docker exec deploy-telegram-bridge-1 sh -c '
  BEARER=$(cat /run/secrets/memex-public-bearer.txt)
  curl -fsS -X POST http://memex:18790/mcp \
    -H "Authorization: Bearer $BEARER" -H "Content-Type: application/json" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"search\",\"arguments\":{\"q\":\"hello\",\"k\":1}}}"
'
```

Then send a real message to the bot in Telegram.

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
| Bridge command dispatch | Load `main.py` in-process; mock `search_memex` + helpers via `monkeypatch.setattr` |

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
MEMEX_BRIDGE_ALLOWED_CHAT_IDS=<n> # required for the bridge; comma-separated
MEMEX_BRIDGE_LLM_MODEL=eu.anthropic.claude-haiku-4-5-20251001-v1:0
TUNNEL_TOKEN=<cloudflared>        # NOT CLOUDFLARE_TUNNEL_TOKEN — that's a different alias
```

## Failure modes to recognise

| Symptom | Likely cause |
|---|---|
| Bridge replies "no matches" for everything | Bearer file `/run/secrets/memex-public-bearer.txt` missing or stale; rotation didn't restart the bridge |
| Bridge replies "helper not installed" | `deploy/helpers/{gcal,ha}` didn't COPY into `/opt/memex/bin/` — check Dockerfile build context |
| Bridge healthcheck flaps `starting → unhealthy` | `aws sts get-caller-identity` failing in entrypoint — IAM role not assumable from the container |
| `MEMEX_BRIDGE_ALLOWED_CHAT_IDS` unset → daemon won't boot | The `:?` interpolation in compose is intentional: better to fail boot than open the bot |
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

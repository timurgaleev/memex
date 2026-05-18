# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
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
  `openclaw` service definitions in `deploy/docker-compose.yml`.
  EFS now carries only container runtime state (workspace, cron,
  devices, recipe-state, telegram-bridge state).

### Changed
- ARCHITECTURE.md, README.md, AGENTS.md updated to reflect the
  four-container topology (`memex` + `openclaw` + `telegram-bridge`
  + `cloudflared`).

## [1.1.0] — 2026-05-17

### Added
- **`telegram-bridge` container — always-on two-way Telegram surface.**
  Long-polls the Bot API independently of openclaw so the bot keeps
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
  Telegram Bot API directly. Bypasses the openclaw gateway pairing
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
- **`openclaw` entrypoint accepts `OPENCLAW_TELEGRAM_DISABLED=1`**
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
- `openclaw@2026.4.29` chat agent surface (Telegram + web UI via
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

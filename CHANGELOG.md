# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `telegram-bridge` container — standalone two-way Telegram surface.
  Long-polls the Bot API, routes slash-commands (`/today`,
  `/tomorrow`, `/week`, `/weather`, `/search`, `/health`, `/help`,
  `/ask`) to the existing helpers, and answers free text with a RAG
  pipeline (`memex /search` for retrieval, Bedrock Nova Lite for
  synthesis). Falls back to retrieval-only when Bedrock is
  unavailable so the bot never goes silent. Allowlisted by numeric
  chat id via `MEMEX_BRIDGE_ALLOWED_CHAT_IDS`. Persists
  `last_update_id` so restarts don't replay history.
- Pytest coverage for the bridge: command parsing, allowlist
  validation, hit-formatting, RAG payload contract, state
  round-trip, unallowed-chat refusal (one-shot), routing surface —
  19 new assertions in `tests/test_telegram_bridge.py`.

### Changed
- `openclaw` entrypoint accepts `OPENCLAW_TELEGRAM_DISABLED=1`
  (default in compose) and removes the `channels.telegram` block
  before booting. Prevents the 409 Conflict that occurs when two
  consumers race for the same bot's `getUpdates` long-poll.

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

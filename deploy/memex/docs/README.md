# memex — Personal-Knowledge Brain

Hybrid vector + keyword + entity-graph search over your Obsidian vault
and code. Single contract: MCP JSON-RPC at `POST /mcp`. Any
MCP-compatible client (Claude Code, Cursor, Codex) calls the public
surface at `https://brain.<your-domain>/mcp`; in-stack callers reach it
on the internal Docker network.

Bun + TypeScript runtime. Storage: **RDS Postgres 16.13** + pgvector +
tsvector. Embeddings: Bedrock Titan v2 (1024-dim).

## What it does

- Indexes markdown documents from configured vault paths (currently
  `/memory`) into a hybrid index — vectors for semantic recall,
  tsvector for keyword precision, RRF fuse.
- Maintains an entity graph (`[[wikilinks]]`, `#hashtags`, dates,
  frontmatter `tags:`) so we can answer "what links to X" and
  "documents tagged Y".
- Runs a 6-phase maintenance cycle every 6 h (`embed-stale`,
  `extract`, `reconcile-links`, `orphans-purge`,
  `frontmatter-inference`, `snapshot`).
- Exposes 25 MCP tools (search, index, backlinks, stats,
  page_{put,append,delete,get,list,versions}, link, unlink,
  graph_{neighbors,query}, entity_{facts,timeline,recall},
  add_fact, add_timeline_event, jobs_{submit,list,get,cancel,logs},
  log_friction). Reads gate on the public bearer; writes gate on
  `MEMEX_INTERNAL_TOKEN`.
- Two HTTP routes by contract: `GET /health` + `POST /mcp`. The
  legacy `/pages/*`, `/graph/*`, `/entities/*`, `/timeline/*`,
  `/jobs/*`, `/search`, `/index`, `/friction` routes shipped during
  phases A.1-A.4 were removed in Phase A.7 — everything is reachable
  via `tools/call` on `/mcp`.

## What it isn't

- Not a public-facing API by default. The internal Docker network is
  the primary route. The optional public MCP HTTPS surface
  (`https://brain.<your-domain>/mcp`, bearer-auth, read-only) is the
  remote AI client path.
- Not a generic vector DB. The data model is markdown-shaped:
  `documents` → `chunks` → `embeddings` + `entities` + `entity_mentions`,
  layered with `pages`, `links`, `entity_facts`, `timeline_events`,
  `hot_memory`, `jobs`, and `subagent_*` ledgers added in phases
  A.1–A.5.
- Not a multi-tenant system. Single user, single source-of-truth vault.

## Quick CLI surface

| Command | Purpose |
|---|---|
| `init --pglite` | bootstrap config + db + 4 soul templates (used at first install only) |
| `serve --http --port 18790` | start the daemon |
| `index <path>` / `search <q>` | one-shot indexing / retrieval |
| `reindex [--all] [--vault P]` | walk a vault, re-ingest changed files |
| `extract` | re-run the regex entity extractor over all chunks (no Bedrock) |
| `backlinks <name>` | docs that mention this wikilink target |
| `reconcile-links [--limit N]` | broken `[[wikilinks]]` |
| `orphans` | DB hygiene (delete safe orphans, flag suspicious) |
| `pages [--limit N] [--filter S]` | full catalog of known wikilink targets |
| `lint` | frontmatter conformance |
| `reports [--since H]` | trend report from cycle_snapshots |
| `doctor` | self-diagnostics, exit non-zero on any failed check |
| `integrity [--vault P]` | vault-vs-index drift report |
| `eval [--k N]` | retrieval quality harness against `tests/eval/qrels.json` |
| `eval-replay {capture\|list\|run\|delete}` | regression harness from captured production queries; `run --promote` sets the new baseline |
| `check-resolvable [--limit N] [--threshold P]` | wikilink coverage report; exits 1 when orphan-rate exceeds `P` % |
| `skillify "<prompt>" [--out P] [--slug S] [--dry-run]` | draft a skill `*.md` via Bedrock Nova Lite + deterministic linter |
| `skillpack [--out P]` | bundle skills as tar.gz with manifest (for downstream agent loaders that consume skill packs) |
| `jobs {list\|stats\|show\|retry\|cancel}` | inspect / reset / cancel rows in the durable job queue |
| `friction {analyze\|propose-fix}` | counts + recents (`analyze`); Nova-Lite-suggested skill-text edits (`propose-fix`) |
| `migrate-engine --from X --to Y` | one-shot copy between Engine adapters |

## Read more

- `ARCHITECTURE.md` — internals, schema, cycle phases, search pipeline
- `API.md` — HTTP routes + MCP JSON-RPC tool reference
- `OPERATIONS.md` — deploy, restart, troubleshoot, rollback

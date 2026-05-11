# memex — Personal-Knowledge Brain

Vector + keyword search over the operator's Obsidian vault and the
chat agent's session memory, with a JSON-RPC MCP transport for the
chat agent.

Bun + TypeScript runtime. Storage: **RDS Postgres 16.13** + pgvector +
tsvector. Embeddings: Bedrock Titan v2 (1024-dim).

## What it does

- Indexes markdown documents from configured vault paths (currently
  `/vault` and `/memory`) into a hybrid index — vectors for semantic
  recall, tsvector for keyword precision, RRF fuse.
- Maintains an entity graph (`[[wikilinks]]`, `#hashtags`, dates,
  frontmatter `tags:`) so we can answer "what links to X" and
  "documents tagged Y".
- Runs a 6-phase maintenance cycle every 6 h (`embed-stale`,
  `extract`, `reconcile-links`, `orphans-purge`,
  `frontmatter-inference`, `snapshot`).
- Exposes HTTP routes (`/health`, `/index`, `/search`, `/backlinks`,
  `/friction`) and an MCP JSON-RPC transport at `POST /mcp` with 5
  tools (search / index / backlinks / stats / log_friction).
- Runs as a daemon inside Docker, internal-only — exposed to openclaw
  via `http://memex:18790` on the Docker bridge network.

## What it isn't

- Not a public-facing API by default. The internal Docker bridge is
  the primary route. The optional public MCP HTTPS surface
  (`https://brain.<your-domain>`, bearer-auth, read-only) is live;
  deferred / future work is catalogued under
  "External-dependency roadmap" in the repo-root `TODO.md`.
- Not a generic vector DB. The data model is markdown-shaped:
  `documents` → `chunks` → `embeddings` + `entities` + `entity_mentions`.
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
| `skillpack [--out P]` | bundle openclaw skills as tar.gz with manifest |
| `jobs {list\|stats\|show\|retry\|cancel}` | inspect / reset / cancel rows in the durable job queue |
| `friction {analyze\|propose-fix}` | counts + recents (`analyze`); Nova-Lite-suggested skill-text edits (`propose-fix`) |
| `migrate-engine --from X --to Y` | one-shot copy between Engine adapters |

## Read more

- `ARCHITECTURE.md` — internals, schema, cycle phases, search pipeline
- `API.md` — HTTP routes + MCP JSON-RPC tool reference
- `OPERATIONS.md` — deploy, restart, troubleshoot, rollback

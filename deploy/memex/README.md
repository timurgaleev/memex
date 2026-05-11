# memex

Personal-knowledge brain — vector + keyword search over the Obsidian
vault and openclaw session memory. Bun + TypeScript daemon backed by
RDS Postgres + pgvector. Reachable internally on
`http://memex:18790` and externally on `https://brain.<your-domain>`
(read-only, bearer-auth).

For all human-readable docs see **`docs/`**:

- [`docs/README.md`](docs/README.md) — start here
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — internals + schema
- [`docs/API.md`](docs/API.md) — HTTP routes + MCP tool reference
- [`docs/OPERATIONS.md`](docs/OPERATIONS.md) — deploy, restart, recover

The plugin manifest is `openclaw.plugin.json`; the optional runtime
config overlay template is `memex.yml.example`.

## Local development

PGLite is kept as a cheap dev backend for tests and local exploration.
Production runs Postgres.

```bash
cd deploy/memex
bun install --frozen-lockfile
bun test                         # 202 tests, ~4-5 min
bun run src/cli.ts --help        # CLI surface
```

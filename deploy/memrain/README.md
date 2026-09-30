# Memrain

Personal-knowledge brain — hybrid vector + keyword + entity-graph
search over your markdown notes and code. Bun + TypeScript daemon
backed by RDS Postgres + pgvector. Reachable internally on
`http://memrain:18790/mcp` and externally on
`https://brain.<your-domain>/mcp` (MCP JSON-RPC, bearer-auth,
read-only by default).

For all human-readable docs see **`docs/`**:

- [`docs/README.md`](docs/README.md) — start here
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — internals + schema
- [`docs/API.md`](docs/API.md) — MCP tools + the two HTTP routes (`/health`, `/mcp`)
- [`docs/OPERATIONS.md`](docs/OPERATIONS.md) — deploy, restart, recover

The optional runtime config overlay template is `memrain.yml.example`.

## Local development

PGLite is kept as a cheap dev backend for tests and local exploration.
Production runs Postgres.

```bash
cd deploy/memrain
bun install --frozen-lockfile
bun run test:sharded             # full suite; a bare `bun test` exhausts PGLite
bun run src/cli.ts --help        # CLI surface
```

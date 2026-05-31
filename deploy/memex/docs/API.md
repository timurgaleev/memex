# memex — API Reference

The memex daemon binds `0.0.0.0:18790` inside its container but is
**reachable only on the Docker `internal` bridge** for in-stack
callers (telegram-bridge → memex via Docker DNS as
`http://memex:18790`) and through Cloudflare Tunnel for the public
MCP surface at `https://brain.<your-domain>/mcp`.

The contract is exactly two routes:

- `GET /health` — operational probe (no auth).
- `POST /mcp` — JSON-RPC 2.0 entry point; all read/write capability
  lives here via `tools/call`.

> The legacy REST routes (`/index`, `/search`, `/backlinks`,
> `/friction`, `/pages/*`, `/graph/*`, `/entities/*`, `/timeline/*`,
> `/jobs/*`) shipped in phases A.1–A.4 were **removed in Phase A.7**.
> Every behaviour is reachable via `tools/call name=<tool>` on `/mcp`.

## `GET /health`

Liveness + DB stats + active engine kind. No auth.

```jsonc
// 200 OK
{
  "ok": true,
  "db": "postgres",   // or "pglite"
  "version": "0.1.0",
  "stats": { "documents": 114, "chunks": 244, "embeddings": 244 }
}
```

## MCP JSON-RPC transport — `POST /mcp`

Standard JSON-RPC 2.0, `Content-Type: application/json`. Single-request
or batched (array).

### `initialize`

```jsonc
// request
{ "jsonrpc": "2.0", "id": 1, "method": "initialize" }

// response
{
  "jsonrpc": "2.0", "id": 1,
  "result": {
    "protocolVersion": "2025-03-26",
    "serverInfo": { "name": "memex", "version": "0.1.0" },
    "capabilities": { "tools": {} }
  }
}
```

### `tools/list`

```jsonc
{ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }
```

Returns every registered tool, each with a JSON-Schema draft-7
`inputSchema`. The set spans search/retrieval (`search`, `backlinks`,
`stats`), the page store (`page_get`/`page_list`/`page_versions` +
writes `page_put`/`page_append`/`page_delete`), the typed graph
(`graph_neighbors`/`graph_query` + `link`/`unlink`), entity facts &
timeline (`entity_facts`/`entity_timeline`/`entity_recall` + `add_fact`/
`add_timeline_event`), the jobs DAG (`jobs_list`/`get`/`logs` +
`jobs_submit`/`jobs_cancel`), plus `index` and `log_friction`.

On the **public** ingress the write tools are filtered out of
`tools/list` entirely and rejected from `tools/call` — see Auth below.

### `tools/call`

```jsonc
{
  "jsonrpc": "2.0", "id": 3,
  "method": "tools/call",
  "params": {
    "name": "search",
    "arguments": { "q": "your query", "k": 5 }
  }
}
```

Returns:
```jsonc
{
  "jsonrpc": "2.0", "id": 3,
  "result": {
    "content": [
      { "type": "text", "text": "<JSON-stringified tool result>" }
    ],
    "isError": false   // true if the tool errored — JSON-RPC error envelope is reserved for protocol failures
  }
}
```

### `ping`

```jsonc
{ "jsonrpc": "2.0", "id": 99, "method": "ping" }
// → { "jsonrpc": "2.0", "id": 99, "result": {} }
```

### Error codes

Standard JSON-RPC + two server-defined:

| Code | Meaning |
|---|---|
| -32700 | parse error (malformed JSON) |
| -32600 | invalid request (missing `jsonrpc: "2.0"`/`method`, or a write tool called from the public ingress) |
| -32601 | method not found |
| -32603 | internal error |
| -32000 | rate limit exceeded (per-IP token bucket) |
| -32001 | unauthorized — a write tool was called on the internal path without `MEMEX_INTERNAL_TOKEN` |

Tool-call errors (a tool throwing) are returned as `result.isError =
true`, NOT as JSON-RPC errors — that's per the MCP spec.

## Calling from the bridge

The `telegram-bridge` container reaches memex on the internal Docker
bridge. From inside it:

```bash
docker exec deploy-telegram-bridge-1 sh -c '
  BEARER=$(cat /run/secrets/memex-public-bearer.txt)
  curl -fsS -X POST http://memex:18790/mcp \
    -H "Authorization: Bearer $BEARER" -H "Content-Type: application/json" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"search\",\"arguments\":{\"q\":\"hello\",\"k\":1}}}"
'
```

The `/opt/memex/bin/memex` shell helper (`deploy/helpers/memex`) wraps
this for ad-hoc CLI use (it talks to `/mcp`):

```bash
docker exec deploy-telegram-bridge-1 /opt/memex/bin/memex search "hello" 1
docker exec deploy-telegram-bridge-1 /opt/memex/bin/memex health
```

## Auth & exposure

- **Internal traffic** (no `Cf-Connecting-Ip`) keys into a single
  "internal" rate-limit bucket; the trust boundary is the Docker bridge.
  Read tools are open. **Write tools require
  `Authorization: Bearer <MEMEX_INTERNAL_TOKEN>`** — without it a write
  `tools/call` returns JSON-RPC `-32001` (closes the compromised-sibling
  kill-chain). When the token is unconfigured the gate falls through open
  (legacy single-node mode, with a startup warning).
- **Public traffic** arrives via Cloudflare Tunnel
  (`https://brain.<your-domain>/mcp`). Cloudflare injects
  `Cf-Connecting-Ip`; the per-IP rate limiter keys on that. Public
  callers must present `Authorization: Bearer <public-bearer>`; the
  mutating tools are filtered from discovery and blocked from dispatch
  via `FORBIDDEN_MCP_TOOLS_FROM_PUBLIC` (in `mcp/dispatch.ts` /
  `http/public_guard.ts`) unless `MEMEX_PUBLIC_WRITE=1`. Public read
  tools additionally redact note bodies unless `MEMEX_PUBLIC_READ_BODIES=1`.

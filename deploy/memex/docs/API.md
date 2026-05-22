# memex — API Reference

The memex daemon binds `0.0.0.0:18790` inside its container but is
**reachable only on the Docker `internal` bridge** for in-stack
callers (telegram-bridge → memex via Docker DNS as
`http://memex:18790`) and through Cloudflare Tunnel for the public
MCP surface at `https://brain.<your-domain>/mcp`.

The contract is two routes:

- `GET /health` — operational probe (no auth).
- `POST /mcp` — JSON-RPC 2.0 entry point (bearer auth on public traffic).

> **Legacy notice.** The routes documented below under "REST routes"
> (`/index`, `/search`, `/backlinks`, `/friction`, plus
> `/pages/*`, `/graph/*`, `/entities/*`, `/timeline/*`, `/jobs/*`
> shipped in phases A.1-A.4) are scheduled for deletion in Phase A.7.
> Every behaviour is reachable via `tools/call name=<tool>` on
> `/mcp`. The bridge already migrated; new code should use MCP only.

All routes (except `/health`) require POST + `Content-Type:
application/json`.

## REST routes

### `GET /health`

Liveness + DB stats + active engine kind.

```jsonc
// 200 OK
{
  "ok": true,
  "db": "postgres",   // or "pglite"
  "version": "0.1.0",
  "stats": { "documents": 114, "chunks": 244, "embeddings": 244 }
}
```

### `POST /index`

Index a markdown document.

Body — pick one shape:
```jsonc
{ "path": "/vault/notes/foo.md" }                    // read from disk
// or
{ "sourcePath": "...", "text": "...markdown..." }    // in-memory
```

Returns:
```jsonc
{
  "ok": true,
  "documentId": "doc_<sha>",
  "chunks": 3,
  "embeddings": 3,
  "entities": 7
}
```

### `POST /search`

Hybrid retrieval over the corpus.

Body:
```jsonc
{
  "q": "home assistant zigbee",
  "k": 5                 // optional, 1-100, default 5
}
```

Returns:
```jsonc
{
  "ok": true,
  "hits": [
    {
      "chunkId": "doc_..._c0",
      "documentId": "doc_...",
      "sourcePath": "/vault/...",
      "title": "...",
      "content": "...up to ~4000 chars...",
      "score": 0.0334,
      "intent": "topic"   // factual|topic|howto|personal|exact
    }
  ]
}
```

Source filtering, intent override, and rerank toggles are exposed in
the underlying `hybridSearch()` function but not the HTTP body —
those are programmatic-only for now.

### `POST /backlinks`

Documents that mention a given entity.

Body:
```jsonc
{
  "name": "Home Assistant",
  "type": "wikilink",       // optional, default wikilink (also: tag, date)
  "limit": 50                // optional, 1-1000, default 50
}
```

Returns:
```jsonc
{
  "ok": true,
  "name": "Home Assistant",
  "hits": [
    {
      "documentId": "doc_...",
      "sourcePath": "/vault/...",
      "title": "...",
      "mentionCount": 3,
      "surfaceForm": "Home Assistant"
    }
  ]
}
```

### `POST /friction`

Log an "agent confused" event. The agent invokes this when retrieval
misses, an answer feels wrong, or a tool errors.

Body:
```jsonc
{
  "kind": "search-miss",      // search-miss|wrong-answer|tool-error|low-confidence|other
  "query": "...",              // optional
  "reason": "...",             // optional
  "sourcePath": "...",         // optional
  "extra": { /* arbitrary */ } // optional
}
```

Returns `{ "ok": true }`.

### `GET /friction`

Trend analysis for the last 168 h (one week).

Returns:
```jsonc
{
  "ok": true,
  "byKind": { "search-miss": 12, "tool-error": 3 },
  "topRepeats": [{ "query": "...", "count": 5 }],
  "recent": [/* up to 100 events */]
}
```

## MCP JSON-RPC transport — `POST /mcp`

Standard JSON-RPC 2.0. Single-request or batched (array).

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

Returns the 5 tools — `search`, `index`, `backlinks`, `stats`,
`log_friction` — each with a JSON-Schema draft-7 `inputSchema`.

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

Standard JSON-RPC + one server-defined:

| Code | Meaning |
|---|---|
| -32700 | parse error (malformed JSON) |
| -32600 | invalid request (missing `jsonrpc: "2.0"` or `method`) |
| -32601 | method not found |
| -32603 | internal error |
| -32000 | rate limit exceeded (per-IP token bucket) |

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

The `/opt/memex/bin/memex` shell helper (`deploy/helpers/memex`)
remains available for ad-hoc CLI use:

```bash
docker exec deploy-telegram-bridge-1 /opt/memex/bin/memex health
```

## Auth & exposure

- **Internal traffic** keys into a single "internal" rate-limit
  bucket. The trust boundary is the Docker bridge — only paired
  containers can reach 18790. Internal callers must still present
  `Authorization: Bearer <public-bearer>` for tool dispatch.
- **Public traffic** arrives via Cloudflare Tunnel
  (`https://brain.<your-domain>/mcp`). Cloudflare injects
  `Cf-Connecting-Ip`; the per-IP rate limiter keys on that. Same
  bearer auth; mutating tools are blocked from the public surface
  via `FORBIDDEN_MCP_TOOLS_FROM_PUBLIC` in `mcp/dispatch.ts`
  unless `MEMEX_PUBLIC_WRITE=1`.

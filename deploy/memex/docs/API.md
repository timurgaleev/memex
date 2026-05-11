# memex — API Reference

The memex daemon binds `0.0.0.0:18790` inside its container but is
**reachable only on the Docker `internal` bridge** — only the
openclaw / cloudflared / obsidian-sync containers can connect, and
only openclaw uses it in practice (via Docker DNS as
`http://memex:18790`).

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

## Calling from the openclaw container

The shell helper at `/opt/memex/bin/memex` wraps these for
interactive use:

```bash
docker exec deploy-openclaw-1 /opt/memex/bin/memex health
docker exec deploy-openclaw-1 /opt/memex/bin/memex search "your query"
docker exec deploy-openclaw-1 /opt/memex/bin/memex backlinks "Home Assistant"
```

The agent calls `POST /mcp` directly per the standard MCP plugin
shape — see `deploy/memex/openclaw.plugin.json`.

## Auth & exposure

- No auth on the internal HTTP surface today. The trust boundary is
  the Docker bridge — only paired containers can reach 18790.
- Public MCP HTTPS (a separate Cloudflare Tunnel ingress + bearer
  token middleware) is gated in `TODO.md`. Don't enable without
  designing that first.

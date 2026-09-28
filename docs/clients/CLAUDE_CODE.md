# Connect Claude Code

Claude Code talks to memex over HTTP at `<issuer>/mcp`, where `<issuer>` is
your public origin, for example `https://brain.<domain>`. It can authenticate
two ways:

- **a personal access token (PAT)** in an `Authorization` header — the simplest,
  and the right choice for one person on one machine;
- **OAuth**, with a client you register for that person and a browser sign-in
  from `/mcp` inside Claude Code.

`memex …` below is the CLI on the host:
`docker exec deploy-memex-1 bun run src/cli.ts …` in an SSM session.

## Prerequisites

- memex is deployed and `curl -s <issuer>/health` returns `{"ok":true,...}`.
- A source for the person, so their writes land in their own space:

  ```bash
  memex sources register alice --kind other --path-prefix tenant:alice
  ```

  Skip it for the operator's own machine; the operator writes to `default`.
- Claude Code with `claude mcp add` (any current release).

## Option A: personal access token

1. Mint a token bound to the person's source. It is printed once.

   ```bash
   memex auth create alice-laptop --source alice
   ```

   `--federated-read a,b` adds read-only sources, `--scopes read` makes a
   read-only token (the default is `read,write`). A token minted without
   `--source` lands on `default`, the operator's space.

2. Add the server. `--scope user` makes it available in every project.

   ```bash
   claude mcp add --transport http --scope user memex <issuer>/mcp \
     --header "Authorization: Bearer <PAT>"
   ```

   The token then sits in `~/.claude.json`; keep that file private.

3. Optional: cap the token's daily spend on paid calls.

   ```bash
   memex auth set-budget alice-laptop 2.00
   ```

## Option B: OAuth

1. Pick a free local port for the callback and register a confidential client
   for the person. Claude Code signs in through `http://localhost:<port>/callback`.

   ```bash
   memex auth register-client alice-claude-code \
     --scopes 'read write' --source alice \
     --redirect-uris 'http://localhost:8765/callback'
   ```

   It prints `client_id` and `client_secret` once. memex accepts a registered
   loopback redirect URI on any port, so a client that picks another port at
   run time still matches; scheme, host and path must match exactly
   (`localhost` and `127.0.0.1` are different hosts).

2. Add the server with the pre-registered client. `--client-secret` makes
   Claude Code prompt for the secret (or read `MCP_CLIENT_SECRET`).

   ```bash
   claude mcp add --transport http --scope user \
     --client-id <client_id> --client-secret --callback-port 8765 \
     memex <issuer>/mcp
   ```

3. In Claude Code run `/mcp`, pick `memex` and sign in in the browser.

If the host runs with `MEMEX_OAUTH_REQUIRE_LOGIN=1` (bootstrap sets it on new
installs), `/authorize` sends the browser to `/admin/login` first, which only
the operator can pass. For anyone else, use Option A, or give them an
enrollment-mode client and a code as described in
[CLAUDE_TEAM.md](./CLAUDE_TEAM.md).

## Verify

Ask Claude Code to call the `whoami` tool. It returns `write_source` and
`read_sources`; for Alice they should be `alice` and `["alice"]`.

For a PAT, run the end-to-end check from your machine (in a checkout, under
`deploy/memex`). The credential goes in a file only you can read, holding
`{"token": "<PAT>"}`; write it with an editor so the token stays out of your
shell history:

```bash
chmod 600 ~/.config/memex/alice.json
bun run src/cli.ts auth doctor <issuer> --token-file ~/.config/memex/alice.json --expect-source alice
```

It checks `/health`, both OAuth discovery documents, `initialize`,
`tools/list` and `whoami`, and exits non-zero on any failure.
`--client-file` checks a client-credentials client instead; a browser client
like the one in Option B has no client-credentials grant, so check it with
`whoami`.

## Troubleshooting

| Symptom | First check |
|---|---|
| `401` with `WWW-Authenticate: Bearer error="invalid_token", resource_metadata="…"` | The header reached memex without a valid token: a typo, a revoked token (`memex auth list`), or a PAT pasted without `Bearer `. |
| `WWW-Authenticate: Bearer resource_metadata="…", scope="read write"` and Claude Code offers to sign in | No `Authorization` header was sent. Re-add the server with `--header`, or finish the OAuth sign-in with `/mcp`. |
| Browser shows `redirect_uri is not registered for this client` | The callback differs from the registered one in scheme, host or path. `memex auth set-redirect-uris <client_id> http://localhost:8765/callback` fixes it without rotating the secret. |
| Callback carries `error=unauthorized_client` | The client has no secret and is in `client` mode while `/authorize` auto-approves. Register a confidential client (drop `--token-endpoint-auth-method none`). |
| `invalid_client` from `/token` | Wrong client secret. It cannot be recovered; register a new client. |
| A tool returns `insufficient_scope`, "requires the 'write' scope" | The token is read-only. Mint one with `--scopes read,write`, or re-register the client with `--scopes 'read write'`. |
| `permission_denied`, "is operator-only and not callable by a tenant token" | `stats`, `run_doctor`, `advisor`, `jobs_*`, `list_concepts`, `get_status_snapshot` and a few others answer only the operator. Expected for a scoped token. |
| `budget_exhausted` | The token's daily cap is spent. Raise it with `memex auth set-budget`, or wait for the UTC day to roll. |
| `whoami` shows `write_source: "default"` | The PAT was minted without `--source`. Revoke it (`memex auth revoke <name>`) and mint again with `--source`. |

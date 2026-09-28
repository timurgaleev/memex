# Connect claude.ai (Pro or Max)

On an individual Pro or Max plan each person adds their own custom connector.
memex does not let a client register itself (Dynamic Client Registration is
off), so you register a confidential client for the person and they paste its
ID and secret into the connector's Advanced settings. For a Team or Enterprise
organisation, where only an Owner adds connectors, see
[CLAUDE_TEAM.md](./CLAUDE_TEAM.md).

`memex …` below is the CLI on the host:
`docker exec deploy-memex-1 bun run src/cli.ts …` in an SSM session.
`<issuer>` is your public origin, for example `https://brain.<domain>`.

## Prerequisites

- memex is deployed, `curl -s <issuer>/health` returns `{"ok":true,...}`, and
  `MEMEX_PUBLIC_URL` is set to `<issuer>` so the discovery documents name the
  public host.
- A source for the person:

  ```bash
  memex sources register alice --kind other --path-prefix tenant:alice
  ```

## Steps

1. Register a client for the person, in the default `client` tenant mode. The
   tenant comes from `--source`.

   ```bash
   memex auth register-client claude-alice \
     --scopes 'read write' --source alice \
     --redirect-uris 'https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback'
   ```

   It prints `client_id` and `client_secret` once. Register both callback
   origins: claude.ai and claude.com are different hosts to the allow-list.
   Anthropic's help article does not list the callback; these are the ones
   claude.ai uses today. If a sign-in fails on the redirect, the browser error
   names the URL it sent, and `memex auth set-redirect-uris` changes the list
   without rotating the secret.

2. Optional: cap the person's daily spend on paid calls.

   ```bash
   memex auth set-budget <client_id> 2.00
   ```

3. Hand the person the server URL, the client ID and the secret, privately. The
   secret is their credential: treat it like a password and never reuse one
   client for two people.

4. The person adds the connector (click-path checked against Anthropic's help
   center on 2026-09-28):

   - **Customize → Connectors**, click **+**, then **Add custom connector**.
   - Name it, and set the URL to `<issuer>/mcp`.
   - Open **Advanced settings** and fill **OAuth Client ID** and
     **OAuth Client Secret**.
   - Click **Connect**; the browser goes to memex's `/authorize` and back.

### The login gate

With `MEMEX_OAUTH_REQUIRE_LOGIN=1` (bootstrap writes it on new installs),
`/authorize` first sends the browser to `/admin/login`, which accepts only the
operator's bootstrap token. That is right when the connector is the operator's
own. For anyone else, either turn the flag off for the brain or give the person
an enrollment-mode client and a code ([CLAUDE_TEAM.md](./CLAUDE_TEAM.md) shows
the flow; it works the same on an individual plan).

## Verify

In a chat, ask Claude to call memex's `whoami` tool. `write_source` should be
`alice`, `read_sources` `["alice"]`, and `scopes` `["read","write"]`.

On the host, `memex auth list-clients` shows the client, its `grant_types`
(`authorization_code`, `refresh_token`) and its `source_id`.

## Troubleshooting

| Symptom | First check |
|---|---|
| Connect fails with `redirect_uri is not registered for this client` | The account uses a callback origin you did not register. `memex auth set-redirect-uris <client_id> https://claude.ai/api/mcp/auth_callback https://claude.com/api/mcp/auth_callback`. |
| Connect lands on the admin login page | `MEMEX_OAUTH_REQUIRE_LOGIN=1` is on and the person is not the operator. See [the login gate](#the-login-gate). |
| Connect fails with `invalid_client` | The secret was mistyped or the client was revoked (`memex auth list-clients` no longer shows it). Register a new client. |
| Connect fails with `invalid_target` | claude.ai named a `resource` that is not this server: the connector URL must be `<issuer>/mcp` on the host `MEMEX_PUBLIC_URL` names. |
| Callback carries `error=unauthorized_client` | The client has no `authorization_code` grant, or it is a public client in `client` mode. Register it as above (with `--redirect-uris`, without `--token-endpoint-auth-method none`). |
| Tools fail with `401` and `Bearer error="invalid_token"` after working for weeks | The refresh token expired or was revoked (`memex auth invalidate-tokens`, a rescope). Disconnect and connect again. |
| A tool returns `insufficient_scope` | The client was registered with `--scopes read`. Re-register with `'read write'`. |
| `permission_denied`, "is operator-only and not callable by a tenant token" | Expected for `stats`, `run_doctor`, `get_status_snapshot`, `jobs_*` and similar on a scoped client. |
| `budget_exhausted` | The client's daily cap is spent. Raise it or wait for the UTC day. |

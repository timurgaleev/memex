# Using Memrain as an MCP server in Claude Code

Memrain serves MCP at `POST /mcp`, at `https://brain.<your-domain>/mcp` behind
the Cloudflare Tunnel or the Caddy ingress. The step-by-step guide, with OAuth
and troubleshooting, is [docs/clients/CLAUDE_CODE.md](../../../docs/clients/CLAUDE_CODE.md).
Guides for the other clients sit next to it in
[docs/clients/](../../../docs/clients/).

## The short version

Mint a personal access token bound to the person's source, on the host:

```bash
docker exec deploy-memrain-1 bun run src/cli.ts auth create alice-laptop --source alice
```

The token is printed once. Then, on the person's machine:

```bash
claude mcp add --transport http --scope user memrain https://brain.<your-domain>/mcp \
  --header "Authorization: Bearer <token>"
```

Ask Claude Code to call `whoami`; `write_source` should be `alice`.

## Which credential

| Credential | Tenant | Reaches |
|---|---|---|
| PAT from `auth create <name> --source <src>` | the named source | the tools its scopes cover (`read,write` by default), scoped to its sources |
| OAuth client from `auth register-client` | the client's source, or the person's enrollment | the same, per client |
| Static public bearer (`<prefix>/memrain-public-bearer`) | none | the public read subset only |

The static public bearer is permanent: its rotation timer is disabled on
purpose, and bootstrap does not install it. It carries no tenant, so it cannot
tell two people apart, and it cannot call `query`, `think`, `recall`,
`get_chunks`, `volunteer_context`, the `code_*` and `jobs_*` tools and others
(`FORBIDDEN_MCP_TOOLS_FROM_PUBLIC` in `src/http/public_guard.ts`). With
`MEMRAIN_PUBLIC_WRITE=1` it can also call the constructive writes (`index`,
`page_put`, `page_append`, `add_fact`, `add_timeline_event`, `add_tag`,
`link`); anyone holding it can then write, so prefer PATs.

## Check the connection

`memrain auth doctor` runs the path a client takes, from your machine: `/health`,
both OAuth discovery documents, MCP `initialize`, `tools/list` and `whoami`.
Put the token in a file only you can read, holding `{"token": "..."}`:

```bash
bun run src/cli.ts auth doctor https://brain.<your-domain> \
  --token-file ~/.config/memrain/alice.json --expect-source alice
```

## Local-only alternative: SSM port-forward

To reach the full tool set without any public credential, tunnel to the
container from your workstation:

```bash
AWS_PROFILE=<your-profile> aws ssm start-session \
  --target <your-instance-id> \
  --region <your-region> \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters '{"host":["memrain"],"portNumber":["18790"],"localPortNumber":["18790"]}'
```

While the session runs, point Claude Code at `http://localhost:18790/mcp`. A
request that arrives this way carries no `Cf-Connecting-Ip` header, so Memrain
treats it as an internal peer: every call, read or write, needs
`Authorization: Bearer <MEMRAIN_INTERNAL_TOKEN>`. A personal access token is
accepted on this path only when `auth.selfIssued.enabled: true` is set in
`memrain.yml`; with it off, anything but the internal token gets a 401:

```bash
claude mcp add --transport http --scope user memrain http://localhost:18790/mcp \
  --header "Authorization: Bearer <MEMRAIN_INTERNAL_TOKEN>"
```

Behind an ingress other than a Cloudflare Tunnel, `MEMRAIN_ASSUME_PUBLIC=1`
changes that classification; see
[docs/CONFIGURATION.md](../../../docs/CONFIGURATION.md).

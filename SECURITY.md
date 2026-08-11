# Security Policy

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security problems.

Instead, email the maintainer at the address listed on the
[GitHub profile](https://github.com/<your-github-username>). Include:

- A short description of the issue.
- A minimal reproduction (steps, code snippet, or commit hash).
- Your assessment of the impact.

Expect a first reply within five business days. Coordinated disclosure
once a fix lands is the norm; if you need a faster path, say so in the
first message.

## Scope

This repo describes a self-hostable single-user stack. Anything that
could let an unauthorized actor read or modify another deploy's data —
even when both deploys are running on different AWS accounts — is in
scope. Examples:

- Secret leakage via committed files.
- Bedrock IAM privilege escalation.
- MCP bearer-token bypass on `brain.<domain>`.
- Cross-tenant data exposure in the memex index.
- Cloudflare Tunnel auth bypass.

## Out of scope

- Findings that require maintainer-level AWS console access.
- Findings against Amazon Bedrock, Cloudflare, or any AWS service —
  report those to AWS / Cloudflare.

## Hardening defaults

- All secrets live in AWS Secrets Manager, never in code or terraform
  state.
- The audit gate (`make audit`) blocks pushes that contain
  maintainer-private identifiers.
- The public MCP bearer can rotate daily, but the timer is opt-in —
  install `deploy/systemd/memex-rotate-bearer.*` by hand (bootstrap does
  not), otherwise the token is static.
- `MEMEX_PUBLIC_WRITE` defaults to `0` — a fresh clone cannot accept
  mutating MCP traffic without an explicit opt-in.

## Known accepted risks

These are documented choices, not bugs — report only if you've found a
way to break the assumed envelope.

- A maintainer who deploys with default settings exposes a read-only
  MCP server at `brain.<domain>/mcp`. The bearer token gates access; the
  optional daily rotation timer (`deploy/systemd/memex-rotate-bearer.*`,
  installed by hand) bounds the blast radius of a leaked token. Without
  it the bearer is static until rotated manually.
- Public read tools redact note bodies by default
  (`MEMEX_PUBLIC_READ_BODIES=1` opts in); write tools are filtered from
  discovery and rejected from the public surface, and require
  `MEMEX_INTERNAL_TOKEN` even on the internal path.

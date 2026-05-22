# memex

> Your own AI brain — self-hosted, single-tenant, MCP-native.
> One repo, one EC2, one weekend to deploy.

**memex** is a self-hostable knowledge brain and personal AI assistant.
It indexes your Obsidian vault, your chats, your calendar, your code,
and your inbox into a hybrid vector + keyword + entity-graph index,
then exposes everything to your favourite AI agent over the Model
Context Protocol (MCP).

Built for one user, one cloud account, one stack. No orchestrator, no
multi-tenancy, no SaaS dependency for the brain itself. Your data
stays in your AWS account.

---

## Why memex

- **Your data, your account.** Everything runs inside an AWS account
  you control: a single EC2 host, RDS Postgres, EFS for state,
  Cloudflare Tunnel for ingress. No third-party SaaS sees your notes.
- **Plug-in for your AI agent.** Claude Code, Cursor, Codex — any
  MCP-compatible client connects to `https://brain.<your-domain>/mcp`
  and can search across everything you've ever written.
- **Hybrid retrieval that actually works.** Bedrock Titan embeddings
  for semantic recall, Postgres `tsvector` for keyword precision,
  Reciprocal Rank Fusion to merge them. Claude Haiku 4.5 composes
  grounded answers from the retrieved chunks.
- **Telegram chat surface, day one.** Talk to your brain from your
  phone. No app store, no platform tax.
- **Production-grade from clone-zero.** Terraform module, partial-S3
  backend, CI workflow, secret rotation timer, PII audit gate. Not a
  toy.
- **No telemetry.** No analytics SDKs, no third-party trackers, no
  ping-home. The only outbound traffic is to AWS and Cloudflare on
  your behalf.

---

## What you can do with it on day one

- Ask "what did I decide last week about X?" in Telegram — get the
  exact note back with cited paths.
- Have Claude Code pull live context from your Obsidian vault during
  refactors via the MCP server.
- Schedule a daily briefing: weather + calendar + open inbox items,
  delivered to your phone before you sit at the keyboard.
- Index Gmail and Google Calendar without a third-party broker — the
  recipes run inside your stack.

---

## How it works

```
                       +---------- public ----------+
                       |                            |
                  Telegram bot           https://brain.<domain>/mcp
                       |                            |
                       v                            v
              telegram-bridge                  cloudflared
                       |                            |
       +------- docker-compose internal bridge -----+
       |                       |
     memex <----- MCP -------- (search, recall, graph)
       |                       |
       |               Bedrock Haiku 4.5  (answer synthesis)
       |               Bedrock Titan v2   (embeddings)
       |               Home Assistant + Google Calendar (helpers)
       |
  RDS Postgres + pgvector
       |
      EFS  (container runtime state only — no content)
```

Inside the box:

- **memex** — the knowledge brain. Bun + TypeScript runtime, Postgres
  16 + pgvector, MCP JSON-RPC transport, multi-phase nightly
  maintenance cycle, graph-only code chunkers for TS / Python.
- **telegram-bridge** — the chat handler. A thin Python daemon that
  long-polls Telegram, dispatches slash commands (`/today`,
  `/weather`, `/search`, …) to the `gcal` / `ha` helpers, and
  answers free text with a RAG pipeline that calls memex over MCP
  for retrieval and Bedrock Claude Haiku 4.5 for synthesis.
  Allowlists by chat id; never speaks to anyone else.
- **cloudflared** — public HTTPS ingress without exposing any EC2
  ports. Routes `brain.<domain>/mcp` to the memex MCP server so
  MCP-compatible AI clients (Claude Code, Cursor, Codex, ...) can
  connect from anywhere.

Deep dives: [`ARCHITECTURE.md`](./ARCHITECTURE.md) and the per-subsystem
docs under `deploy/<subsystem>/docs/`.

---

## Quickstart

You need:

- An AWS account (any region)
- Terraform 1.6+, docker compose v2, bash 3.2+
- A domain you control (for Cloudflare Tunnel ingress)

```bash
git clone https://github.com/<your-fork>/memex.git
cd memex

# 1. Interactive bootstrap. Prompts for AWS account, domain, GitHub
#    owner, bucket names, optional alarm email. Writes:
#      .env                          (runtime config)
#      terraform/terraform.tfvars    (gitignored)
#      terraform/backend.hcl         (gitignored)
make init

# 2. PII audit gate — must pass on a clean clone.
make audit

# 3. Plan against your AWS account.
make plan

# 4. Apply when the plan looks right.
make apply
```

After `make apply`, the EC2 boots, `scripts/bootstrap.sh` pulls the
repo into `/opt/<project>`, fetches secrets from AWS Secrets Manager,
and brings up the three containers (`memex`, `telegram-bridge`,
`cloudflared`) via Docker Compose. Cloudflare Tunnel routes
`brain.<domain>/mcp` to the memex MCP server so remote AI clients
can connect.

Full setup walkthrough for the Gmail + Google Calendar recipes:
[`deploy/memex/docs/GMAIL-GCAL-SETUP.md`](./deploy/memex/docs/GMAIL-GCAL-SETUP.md).
Connecting Claude Code to the MCP server:
[`deploy/memex/docs/CLAUDE-CODE.md`](./deploy/memex/docs/CLAUDE-CODE.md).

---

## What's where

| Subsystem | Path | Docs |
|---|---|---|
| **memex** — knowledge brain (search, index, MCP) | `deploy/memex/` | `deploy/memex/docs/` |
| **telegram-bridge** — chat handler (memex MCP + Bedrock RAG) | `deploy/telegram-bridge/` | `deploy/telegram-bridge/README.md` |
| **helpers** — `gcal`, `ha`, `memex` CLIs the bridge shells out to | `deploy/helpers/` | inline shebangs |
| **cloudflared** — public ingress sidecar | `deploy/cloudflared/` | `deploy/cloudflared/docs/` |
| **secrets** — AWS Secrets Manager fetch | `deploy/secrets/` | `deploy/secrets/README.md` |
| **bootstrap.sh** — EC2 first-boot script | `scripts/bootstrap.sh` | inline |
| **terraform** — all AWS infra | `terraform/` | inline |
| **architecture diagram + inventory** | [`ARCHITECTURE.md`](./ARCHITECTURE.md) | — |
| **agent onboarding** | [`llms.txt`](./llms.txt), [`AGENTS.md`](./AGENTS.md) | for AI sessions cloning the repo |
| **deferred work** | [`TODO.md`](./TODO.md) | open roadmap |
| **changelog** | [`CHANGELOG.md`](./CHANGELOG.md) | versioned releases |
| **archive** — work preserved for future re-implementation | `archive/` | per-folder `README.md` |

---

## Contributing

Issues and PRs welcome. Two ground rules:

- Read [`CLAUDE.md`](./CLAUDE.md) before opening a PR — it carries the
  project's non-negotiable rules (no commits without explicit ask, no
  unrequested infrastructure, surgical changes).
- Open an issue first for anything that adds infrastructure or
  touches the deploy story. The project is intentionally single-user
  and the bar for scope additions is high.

A `Feature / enhancement` issue template lives under
`.github/ISSUE_TEMPLATE/`.

---

## Security

Found a vulnerability? Please **don't** open a public issue. See
[`SECURITY.md`](./SECURITY.md) for the private disclosure channel.

---

## License

[MIT](./LICENSE). Fork it, redeploy it, modify it, sell it — do
whatever the MIT license permits.

The project is solo-maintained. No SLA, no support contract, no
promise that the next release won't change the deploy story. If you
need that, fork and pin.

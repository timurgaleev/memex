# memex-stack — Privacy Policy

**Effective:** see git history of this file
**Operator:** `<MAINTAINER>` — `<your-email>`
**Service:** memex-stack — a personal AI assistant deployed for one
user only.

This stack is a single-user system. The operator (above) is the only
authorized user. There are no public sign-ups, no multi-tenant access,
and no marketing list.

## What data the app touches

memex indexes only data the operator points it at inside their own
infrastructure:

| Source | What we read |
|---|---|
| Markdown notes | Notes the operator indexes from under the configured `MEMEX_VAULT_PATHS`. |
| Code corpus | Source files under the configured `MEMEX_CODE_PATHS` (graph-only via tree-sitter). |

There is **no third-party data integration** — no Google, no email, no
calendar, no smart-home, no OAuth to any external provider. The stack
reads only the operator's own files.

## Where the data goes

All processing happens inside the operator's own AWS account in the
configured region:

- **Indexed text excerpts** and their **vector embeddings** are stored
  in **AWS RDS for PostgreSQL** in a private VPC subnet, encrypted at
  rest.
- **AWS Bedrock** is used for embeddings (Amazon Titan Text Embeddings
  v2) and lightweight retrieval helpers — intent classification and
  query expansion (Amazon Nova Lite). memex does **not** synthesize
  answers; that is the MCP client's job. Bedrock requests stay inside
  AWS; Amazon's standard Bedrock data-handling terms apply (no model
  training on customer prompts).

No data leaves AWS. There are no analytics SDKs, no advertising
trackers, no third-party SaaS observability, and no telemetry beyond
CloudWatch logs scoped to the operator's account.

## Who can access the data

Only the operator. Access is gated behind:

- AWS IAM policies scoped to the operator's account.
- A bearer token for the public read API at
  `<memex_subdomain>.<your-domain>`, optionally rotated daily by the
  `memex-rotate-bearer` systemd timer.
- A Cloudflare Tunnel that fronts the EC2 instance — the underlying
  host has no public IP.

## Data retention and deletion

The operator may delete all stored data at any time by truncating the
`documents`, `chunks`, and `embeddings` tables in the RDS PostgreSQL
database, or destroying the database (`make destroy`).

There is no support inbox to email — the operator runs the entire
stack.

## Children's privacy

This stack is not intended for use by anyone under 18. No data about
minors is knowingly collected.

## Changes to this policy

The current text lives at `PRIVACY.md` in the GitHub repository.
Updates are committed there with a new date in the **Effective** field
above.

## Contact

For any inquiry: `<your-email>`.

# memex-stack — Privacy Policy

**Effective:** see git history of this file
**Operator:** `<MAINTAINER>` — `<your-email>`
**Service:** memex-stack — a personal AI assistant deployed for one
user only.

This file is the source-of-truth for the Google OAuth consent screen.
**Each deployer of this stack MUST replace `<MAINTAINER>` and
`<your-email>` with their own contact information BEFORE publishing
the rendered page at `https://<subdomain>.<your-domain>/privacy`** —
Google OAuth review will reject a privacy page that still contains
placeholder values.

## Who is this for?

This stack is a single-user system. The operator (above) is the only
authorized user. There are no public sign-ups, no multi-tenant
access, and no marketing list. If you have arrived here from a
Google OAuth consent screen and you are not the operator, you are
not the intended audience for this app — back out.

## What data the app touches

The operator grants this stack access to specific Google services
via OAuth:

| Source | Scope | What we read |
|---|---|---|
| Gmail | `gmail.readonly` | Subject, sender, recipient, and body of recent messages, on demand. |
| Calendar | `calendar.readonly` | Title, start/end time, location, and attendee list of events in the next ~7 days. |

We do not read any other Google data. We never write to Gmail or
Calendar. We never request offline access beyond a single refresh
token per service.

## Where the data goes

All processing happens inside the operator's own AWS account in the
configured region:

- **OAuth credentials** (`client_id`, `client_secret`, `refresh_token`)
  live in **AWS Secrets Manager**, encrypted at rest with AWS-managed
  KMS.
- **Indexed text excerpts** — subject and body excerpts up to 4 KiB
  per Gmail message; event title, description, and location up to
  4 KiB per Calendar event — are stored in **AWS RDS for PostgreSQL**
  in a private VPC subnet, encrypted at rest.
- **Vector embeddings** of those excerpts (used for semantic search)
  are stored in the same RDS database.
- **AWS Bedrock** is used for two model calls per ingested item:
  Amazon Nova Lite (signal classification) and Amazon Titan Text
  Embeddings v2. Bedrock requests stay inside AWS; Amazon's standard
  Bedrock data-handling terms apply (no model training on customer
  prompts).

No data leaves AWS. There are no analytics SDKs, no advertising
trackers, no third-party SaaS observability, and no telemetry beyond
CloudWatch logs scoped to the operator's account.

## Who can access the data

Only the operator. Access is gated behind:

- AWS IAM policies scoped to the operator's account.
- A bearer token rotated daily for the public read API at
  `<memex_subdomain>.<your-domain>`.
- A Cloudflare Tunnel that fronts the EC2 instance — the underlying
  host has no public IP.

## Data retention and deletion

The operator may delete all stored data at any time:

1. Revoke OAuth grants at https://myaccount.google.com/permissions
   (Gmail and Calendar entries).
2. Delete the secret entries (`<secrets_prefix>/google-calendar`,
   etc.) from AWS Secrets Manager.
3. Truncate the `documents`, `chunks`, `embeddings`, and
   `recipe_state` tables in the RDS PostgreSQL database, or destroy
   the database (`make destroy`).

There is no support inbox to email — the operator runs the entire
stack.

## Children's privacy

This stack is not intended for use by anyone under 18. No data
about minors is knowingly collected.

## Changes to this policy

The current text lives at `PRIVACY.md` in the GitHub repository. The
rendered page at the operator's domain is produced from that file.
Updates are committed there with a new date in the **Effective**
field above.

## Contact

For Google OAuth verification or any other inquiry: `<your-email>`.

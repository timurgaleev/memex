# Deployment — zero to live

A linear self-host guide: from an empty AWS account to a running MCP retrieval
brain your Claude Code (or any MCP client) can query at
`https://<subdomain>.<domain>/mcp`.

The stack is one small EC2 instance running Docker Compose (the `memex`
container + a `cloudflared` sidecar), an RDS Postgres index, an EFS data tree,
and Secrets Manager for credentials. Public ingress is a **Cloudflare Tunnel**,
not an ALB — the instance opens no inbound web ports.

Throughout, replace placeholders: `example.com` (your domain), `<subdomain>`
(default `brain`), `<account-id>`, `<instance-id>`, `<your-profile>`,
`<your-region>` (default `eu-west-1`).

---

## 1. Prerequisites

- **An AWS account** with credentials configured locally (`aws configure` / an
  `~/.aws/config` profile).
- **Bedrock model access enabled in the console** for your region. This is the
  #1 silent-failure trap: without it the very first embed call fails with
  `AccessDenied` and the brain looks broken while everything else is healthy.
  In the Bedrock console → *Model access*, enable at minimum:
  - **Amazon Titan Text Embeddings V2** (embeddings — required for indexing)
  - **Anthropic Claude Haiku** (utility tier — intent/query expansion/synthesis)
  - **Anthropic Claude Sonnet** (only if you plan to turn on any paid slice)

  Model access is per-region — enable it in the same region as `aws_region`.
- **Terraform ≥ 1.6**.
- **A domain** you control, plus a **Cloudflare account** (free tier is fine) —
  the public MCP ingress runs over a Cloudflare Tunnel.
- An **S3 bucket** for terraform state (any region; you'll name it during init).

---

## 2. Clone and initialize

```bash
git clone https://github.com/<your-github-username>/memex.git
cd memex
scripts/init.sh
```

`scripts/init.sh` is interactive. It prompts for your AWS account id, region,
profile, **domain**, subdomain (default `brain`), GitHub owner/repo, secrets
prefix (default `memex`), the tfstate bucket + region, and optional
alarm email / SSH CIDR. It then writes three **gitignored** files atomically:

- `.env` — runtime config for compose + scripts (`MEMEX_HOST` becomes
  `<subdomain>.<domain>`, `MEMEX_PUBLIC_WRITE=0`).
- `terraform/terraform.tfvars` — terraform inputs.
- `terraform/backend.hcl` — the S3 partial-backend config.

Run `make audit` afterward to confirm no identifier leaked into a tracked file.

---

## 3. Provision infrastructure (terraform)

```bash
terraform -chdir=terraform init -backend-config=backend.hcl
terraform -chdir=terraform plan       # review every resource before applying
terraform -chdir=terraform apply
```

This creates the VPC, the EC2 instance (Graviton `t4g.medium` by default), the
EFS filesystem, the RDS Postgres 16 instance (`db.t4g.micro`, private,
encrypted, deletion-protected), the Secrets Manager secrets, IAM roles scoped to
Bedrock + Secrets Manager, and (by default) CloudTrail.

The RDS instance has `deletion_protection = true` and takes a final snapshot —
`terraform destroy` will not silently drop your index.

---

## 4. Fill the one empty secret

Terraform creates most secrets fully populated:

- `<prefix>/memex-postgres-url` — **auto-filled** from the RDS instance
  (username, generated password, endpoint, port, db). No action needed.
- `<prefix>/memex-public-bearer` — **auto-generated** 48-char token.
- `<prefix>/memex-internal-token` — **auto-generated** 48-char token.

Exactly one secret is created as an **empty placeholder** you must fill by hand:

- `<prefix>/cloudflared-tunnel-token` — empty until you create the tunnel
  (step 5). Until it's filled, the `cloudflared` container loops forever trying
  to authenticate and the public ingress never comes up.

Read the auto-generated bearer (you'll need it for the MCP client in step 8):

```bash
aws secretsmanager get-secret-value \
  --secret-id <prefix>/memex-public-bearer \
  --profile <your-profile> --region <your-region> \
  --query SecretString --output text
```

---

## 5. Create the Cloudflare Tunnel

1. In the Cloudflare **Zero Trust** dashboard → **Networks → Tunnels**, create a
   tunnel (connector type: *Cloudflared*).
2. Add a **public hostname** route: `<subdomain>.example.com` →
   `http://memex:18790` (the container name + internal port; cloudflared shares
   the compose network with memex).
3. Copy the tunnel **token** and store it in the placeholder secret:

   ```bash
   aws secretsmanager put-secret-value \
     --secret-id <prefix>/cloudflared-tunnel-token \
     --secret-string '<tunnel-token>' \
     --profile <your-profile> --region <your-region>
   ```

The tunnel runs with `--protocol http2` (see `deploy/docker-compose.yml`) so it
works even when the security group only allows TCP egress on 7844.

---

## 6. First boot

The EC2 `user_data` runs `scripts/bootstrap.sh` on every boot (idempotent). On
the first boot it:

- installs Docker + the pinned Docker Compose v2 plugin (sha256-verified),
- mounts EFS and seeds the canonical data dirs,
- HTTPS-clones the repo into `/opt/memex` (SSH only when
  `use_ssh_deploy_key = true`),
- renders `/opt/memex/.env` from the terraform env contract,
- runs `deploy/secrets/fetch-secrets.sh` to pull secrets into
  `deploy/.secrets/`,
- `docker compose … up -d --build`.

memex runs its DB migrations at container start — no manual migrate step. If you
filled the tunnel token in step 5 before boot, the stack comes up healthy in one
pass; if you filled it after, `docker compose restart cloudflared` on the host
(via SSM) picks it up.

Connect to the host with SSM (no SSH needed):

```bash
aws ssm start-session --target <instance-id> \
  --profile <your-profile> --region <your-region>
```

---

## 7. Index your first content

The container mounts your content read-only at `/memory`
(`MEMEX_VAULT_PATHS`) and the code checkout at `/repo-source`
(`MEMEX_CODE_PATHS`). Drop markdown notes into the EFS `workspace/memory` tree,
then trigger an index from inside the container:

```bash
docker exec deploy-memex-1 memex index
```

The 6-hour maintenance cycle also sweeps new/changed files automatically; a
manual `index` just does it now.

---

## 8. Hook up an MCP client (Claude Code)

Add the server to `~/.claude.json` (global) or a project `.claude.json`:

```jsonc
{
  "mcpServers": {
    "memex": {
      "type": "http",
      "url": "https://<subdomain>.example.com/mcp",
      "headers": {
        "Authorization": "Bearer <token-from-step-4>"
      }
    }
  }
}
```

Or via the CLI:

```bash
claude mcp add --transport http memex https://<subdomain>.example.com/mcp \
  --header "Authorization: Bearer <token-from-step-4>"
```

Restart Claude Code. The read tools appear under `memex.*` (`search`,
`backlinks`, `stats`, `page_{get,list,versions}`, `graph_{neighbors,query}`,
`entity_{facts,timeline,recall}`, `jobs_{list,get,logs}`). Write tools are
filtered from the public surface unless `MEMEX_PUBLIC_WRITE=1`. The bearer
rotates daily — re-fetch (step 4) and update the header when a call starts
returning 401.

---

## 9. Verify

```bash
# Health — expect {"ok":true,...}
curl -s https://<subdomain>.example.com/health

# One search through the public MCP
curl -s https://<subdomain>.example.com/mcp \
  -H "Authorization: Bearer <token-from-step-4>" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"search","arguments":{"query":"hello","limit":3}}}'
```

On the host you can also check container health directly:

```bash
docker inspect deploy-memex-1 --format '{{.State.Health.Status}}'   # healthy
```

---

## 10. Updates

Deploy is via SSM to the live host, not platform CI. In an SSM session on the
instance:

```bash
cd /opt/memex
git fetch origin && git reset --hard origin/main
docker compose --env-file .env -f deploy/docker-compose.yml up -d --build memex
docker inspect deploy-memex-1 --format '{{.State.Health.Status}}'
curl -s http://127.0.0.1:18790/health    # {"ok":true,...}
```

Rebuild only the service(s) that changed. Infrastructure changes go through
`terraform plan` / `apply` against the S3 state — never mutate a
terraform-managed resource with ad-hoc CLI/console calls.

To enable optional features (synthesis, paid Sonnet slices, tenancy flags,
retrieval tuning), see [CONFIGURATION.md](./CONFIGURATION.md) — remember a flag
must be in **both** `.env` and the compose `environment:` allowlist to take
effect.

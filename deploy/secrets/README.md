# deploy/secrets — credential plumbing

This directory holds **the script that fetches secrets at boot**. It
does NOT hold any secrets in tracked content.

## Files

- `fetch-secrets.sh` — runs at container-host boot via
  `scripts/bootstrap.sh`. Reads each `<secrets_prefix>/*` AWS Secrets
  Manager secret and writes it to `deploy/.secrets/` (gitignored) so
  containers can `env_file` or bind-mount the directory.

## Output layout (gitignored, EC2-only)

```
deploy/.secrets/                # dir mode 0711 (non-root descend-only)
├── cloudflared.env           TUNNEL_TOKEN=... + CLOUDFLARE_TUNNEL_TOKEN=...0400
└── memex.env                 MEMEX_POSTGRES_URL=... + MEMEX_PUBLIC_BEARER + config  0400
```

`cloudflared.env` and `memex.env` are consumed via `env_file`. memex
reads `MEMEX_PUBLIC_BEARER` from `memex.env` to validate incoming public
`/mcp` bearers. The directory is `0711` so a non-root container UID can
descend into it without the host exposing the full file list.

Re-fetched on every `bootstrap.sh` run; existing files are overwritten.

## Secrets in AWS Secrets Manager

The default prefix is `<var.secrets_prefix>` (configured in
`terraform.tfvars`; default `memex`).

| Name | Format | Used by |
|---|---|---|
| `<prefix>/cloudflared-tunnel-token` | string | cloudflared |
| `<prefix>/memex-postgres-url` | string (URL) | memex |
| `<prefix>/memex-public-bearer` | string | memex — validates public `/mcp` bearers |
| `<prefix>/github-deploy-key` | OpenSSH private key | `bootstrap.sh` `git clone` (SSH deploy-key mode only) |

When `use_ssh_deploy_key = true`, the deploy key lets the EC2 clone a
private repo over SSH. It's `chmod 600` after fetch and used via
`GIT_SSH_COMMAND="ssh -i $key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"`.
Public-template installs skip this entirely.

## Adding a new secret

1. Create the secret in AWS:
   ```bash
   aws secretsmanager create-secret \
     --name <secrets_prefix>/<name> \
     --secret-string '<value>' \
     --profile <your-profile> --region <your-region>
   ```
2. Add the corresponding `fetch_text` (or specialised) line in
   `fetch-secrets.sh`.
3. Wire the file into the container that consumes it via
   `docker-compose.yml` (`volumes:` for files, `env_file:` for `.env`).
4. Commit + push.
5. SSM into EC2; `git pull && bash deploy/secrets/fetch-secrets.sh
   && docker compose up -d --build <service>`.

Never commit anything from `deploy/.secrets/` itself.

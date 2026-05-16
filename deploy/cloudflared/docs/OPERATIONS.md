# cloudflared — Operations

## Restart

```bash
docker compose restart cloudflared
sleep 10
docker compose logs --tail 30 cloudflared | grep -i 'connection\|registered'
```

Expect 4 `Registered tunnel connection` lines (one per Cloudflare edge
POP). If you see only QUIC retries, the SG egress for TCP/7844 is
broken.

## Rotate the tunnel token

If the Cloudflare tunnel itself is regenerated (Zero Trust dashboard
→ Networks → Tunnels → `<your-tunnel>` → Configure → Refresh):

```bash
# AWS — replace the secret value:
aws secretsmanager put-secret-value \
  --secret-id <secrets_prefix>/cloudflared-tunnel-token \
  --secret-string '<new-token-from-dashboard>' \
  --profile <your-profile> --region <your-region>

# EC2 — re-fetch + restart cloudflared:
cd /opt/<project>
bash deploy/secrets/fetch-secrets.sh
docker compose --env-file .env -f deploy/docker-compose.yml restart cloudflared
```

## Change ingress (e.g. add `brain.<your-domain>` for public MCP)

This is **dashboard-side**, not in this repo:

1. Cloudflare → Zero Trust → Networks → Tunnels → `<your-tunnel>`.
2. Configure → Public Hostnames → Add hostname.
3. Hostname `brain.<your-domain>`, service `http://memex:18790`.
4. No restart needed — cloudflared picks up dashboard changes within
   ~30 s.

When you add an ingress to a NEW container, also expose its port on
the `internal` Docker network in `docker-compose.yml` (most already
do via `expose:`).

## Failure modes

| Symptom | Cause / fix |
|---|---|
| 502 / 530 from `https://<subdomain>.<domain>` | cloudflared is up but openclaw container is down — check `docker compose ps openclaw` |
| Tunnel keeps retrying QUIC, never connects | SG TCP egress on 7844 missing — see `terraform/ec2.tf` |
| `--token ""` log, won't register | env var name mismatch (must be `TUNNEL_TOKEN`, not `CLOUDFLARE_TUNNEL_TOKEN`) — `fetch-secrets.sh` writes both for safety |
| `dial tcp: lookup openclaw on 127.0.0.11` | openclaw container exited; container DNS (Docker) doesn't see it. `docker compose up -d openclaw` |

## Image bumps

```bash
# pin a new tag in docker-compose.yml first, then:
cd /opt/<project>
docker compose --env-file .env -f deploy/docker-compose.yml pull cloudflared
docker compose --env-file .env -f deploy/docker-compose.yml up -d cloudflared
docker compose --env-file .env -f deploy/docker-compose.yml logs --tail 20 cloudflared
```

Check release notes for breaking changes (rare). Always bump
intentionally; never use `:latest` (a re-pull mid-deploy can surprise
you).

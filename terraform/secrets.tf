# All secrets are created as empty placeholders.
# Fill them in AWS Console or CLI after deployment — never in Terraform state.
# Naming pattern: ${var.secrets_prefix}/<name>. Override secrets_prefix in
# terraform.tfvars to namespace per-environment (e.g. "stack-staging").

# Only the Cloudflare Tunnel ingress needs a tunnel token. An
# ingress_mode="caddy" install has no tunnel, and a placeholder secret that
# nothing reads is an invitation to delete it by hand — which is exactly what
# happened on one install, leaving live and state disagreeing.
#
# Upgrade note: the `moved` block below re-addresses the existing (un-counted)
# resource so a cloudflare install plans a no-op state move, not a
# destroy+create of a live token. A caddy install plans a DESTROY of the
# placeholder — expected, but if that secret is already in scheduled-deletion
# limbo, run `aws secretsmanager restore-secret` first or AWS rejects the call.
resource "aws_secretsmanager_secret" "cloudflared_tunnel_token" {
  count = var.ingress_mode == "cloudflare" ? 1 : 0

  name                    = "${var.secrets_prefix}/cloudflared-tunnel-token"
  description             = "Cloudflare Tunnel token for the MCP brain subdomain (brain.<domain>/mcp)"
  recovery_window_in_days = 0
}

moved {
  from = aws_secretsmanager_secret.cloudflared_tunnel_token
  to   = aws_secretsmanager_secret.cloudflared_tunnel_token[0]
}

# Conditional — only when the stack uses the SSH deploy-key flow for a
# private repo. The default install leaves use_ssh_deploy_key=false and
# HTTPS-clones a public repo without auth.
resource "aws_secretsmanager_secret" "github_deploy_key" {
  count = var.use_ssh_deploy_key ? 1 : 0

  name                    = "${var.secrets_prefix}/github-deploy-key"
  description             = "SSH private key (passphrase-less) the EC2 uses to git clone a private repo"
  recovery_window_in_days = 0
}

# Bearer token for the public Cloudflare Tunnel ingress to memex
# (brain.<domain>). Read-side only — /index and /friction are blocked
# from public regardless of bearer; mutating MCP tools are filtered
# server-side. Generated as a random 48-char string at apply time and
# stored as the secret value in one shot.
resource "random_password" "memex_public_bearer" {
  length  = 48
  special = false # URL-safe; carried in Authorization header

  lifecycle {
    # Daily rotation is owned by scripts/rotate-memex-public-bearer.sh
    # via put-secret-value. Terraform must NOT regenerate-on-apply or it
    # clobbers whatever the rotation timer last wrote.
    ignore_changes = [length, special]
  }
}

resource "aws_secretsmanager_secret" "memex_public_bearer" {
  name                    = "${var.secrets_prefix}/memex-public-bearer"
  description             = "Bearer token for the public Cloudflare Tunnel ingress to memex (read-only routes)"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "memex_public_bearer" {
  secret_id     = aws_secretsmanager_secret.memex_public_bearer.id
  secret_string = random_password.memex_public_bearer.result

  lifecycle {
    # Daily rotation owns secret_string after first apply; never let
    # terraform drag the value back to the random_password seed.
    ignore_changes = [secret_string]
  }
}

# memex-internal-token — shared secret authenticating any future peer
# container on the internal docker bridge to memex's MCP write tools.
# Without it, a compromised sibling container could write to the index
# with no auth — the gate keys on `Cf-Connecting-Ip` presence only,
# which is exactly the header those peers never send. See
# `deploy/memex/src/http/public_guard.ts:evaluateInternalAuth`.
resource "random_password" "memex_internal_token" {
  length  = 48
  special = false

  lifecycle {
    ignore_changes = [length, special]
  }
}

resource "aws_secretsmanager_secret" "memex_internal_token" {
  name                    = "${var.secrets_prefix}/memex-internal-token"
  description             = "Shared bearer authenticating peer containers to memex's internal mutating routes"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "memex_internal_token" {
  secret_id     = aws_secretsmanager_secret.memex_internal_token.id
  secret_string = random_password.memex_internal_token.result

  lifecycle {
    ignore_changes = [secret_string]
  }
}

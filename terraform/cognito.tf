# cognito.tf — optional Cognito user pool for the OAuth/JWT bearer path.
#
# The OAuth app-layer shipped in v1.16.0 is DEFAULT-OFF. This terraform is the
# matching infra, also gated: `var.enable_oauth` defaults to false, so a normal
# apply creates NOTHING (count = 0). Flip it on only when you want OAuth.
# Fully additive — no existing resource references these, so toggling it can
# never destroy or replace the EC2/RDS/etc. stack.
#
# When enabled it provisions a Cognito user pool + an app client whose ID token
# is what memex verifies. Wire the three outputs into `auth.oauth` in memex.yml
# (issuer / jwks_uri / audience). For a PRIVATE test, mint a token for your own
# user via `aws cognito-idp admin-initiate-auth` (no hosted UI needed) and set
# `auth.oauth.allowed_subs` to that user's `sub`.

variable "enable_oauth" {
  description = "Provision a Cognito user pool for the optional OAuth/JWT path. Default off — no resources created."
  type        = bool
  default     = false
}

resource "aws_cognito_user_pool" "memex" {
  count = var.enable_oauth ? 1 : 0
  name  = "${var.project_name}-oauth"

  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  password_policy {
    minimum_length    = 12
    require_lowercase = true
    require_uppercase = true
    require_numbers   = true
    require_symbols   = false
  }

  # MFA off for a single-user private test; turn on for any real exposure.
  mfa_configuration = "OFF"

  tags = {
    Project = var.project_name
  }
}

resource "aws_cognito_user_pool_client" "memex" {
  count        = var.enable_oauth ? 1 : 0
  name         = "${var.project_name}-mcp"
  user_pool_id = aws_cognito_user_pool.memex[0].id

  # Public client (no secret) — the ID token carries aud = this client id.
  generate_secret = false

  # ADMIN_USER_PASSWORD_AUTH lets you mint a test token from the AWS CLI
  # (`admin-initiate-auth`) without standing up a hosted login UI.
  explicit_auth_flows = [
    "ALLOW_ADMIN_USER_PASSWORD_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
  ]

  id_token_validity     = 1
  access_token_validity = 1
  token_validity_units {
    id_token     = "hours"
    access_token = "hours"
  }
}

# --- Outputs → memex.yml `auth.oauth` ---------------------------------------

output "cognito_user_pool_id" {
  description = "Cognito user pool id (null when enable_oauth = false)."
  value       = var.enable_oauth ? aws_cognito_user_pool.memex[0].id : null
}

output "cognito_issuer" {
  description = "auth.oauth.issuer — the exact `iss` claim."
  value       = var.enable_oauth ? "https://cognito-idp.${var.aws_region}.amazonaws.com/${aws_cognito_user_pool.memex[0].id}" : null
}

output "cognito_jwks_uri" {
  description = "auth.oauth.jwks_uri."
  value       = var.enable_oauth ? "https://cognito-idp.${var.aws_region}.amazonaws.com/${aws_cognito_user_pool.memex[0].id}/.well-known/jwks.json" : null
}

output "cognito_app_client_id" {
  description = "auth.oauth.audience — the ID token's `aud`."
  value       = var.enable_oauth ? aws_cognito_user_pool_client.memex[0].id : null
}

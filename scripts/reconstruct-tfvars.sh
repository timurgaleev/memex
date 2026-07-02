#!/usr/bin/env bash
# reconstruct-tfvars.sh — rebuild terraform/terraform.tfvars from live AWS state.
#
# The tfvars file is gitignored (holds the maintainer's real domain + alarm
# email) and was lost. Every value here is either a repo-stable default or is
# read back from the LIVE infrastructure so the reconstructed file matches the
# applied state exactly — a `terraform plan` after this should show 0 changes.
#
# TWO values live only in the applied state, not in any tracked file:
#   - domain      → /etc/stack-env STACK_DOMAIN on the EC2 host (written at boot)
#   - alarm_email → the SNS email subscription endpoint
# Defaulting either to "" is DESTRUCTIVE: alarm_email="" drops the SNS topic +
# subscription (count = var.alarm_email != "" ? 1 : 0). This script reads the
# real values so that never happens.
#
# Prereq: an active SSO session — `aws sso login --profile timzu-bedrock`.
# Usage:  scripts/reconstruct-tfvars.sh
set -euo pipefail

PROFILE="${AWS_PROFILE:-timzu-bedrock}"
REGION="${AWS_REGION:-eu-west-1}"
PROJECT="${MEMEX_PROJECT:-memex}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$REPO_ROOT/terraform/terraform.tfvars"

echo "[reconstruct] profile=$PROFILE region=$REGION project=$PROJECT"

# Fail fast if SSO is stale (every read below would otherwise error one by one).
if ! aws sts get-caller-identity --profile "$PROFILE" --region "$REGION" >/dev/null 2>&1; then
  echo "[reconstruct] ERROR: SSO session invalid. Run: aws sso login --profile $PROFILE" >&2
  exit 1
fi

# Discover the live instance by tag (no hardcoded instance id — audit-safe).
INSTANCE_ID="$(aws ec2 describe-instances --profile "$PROFILE" --region "$REGION" \
  --filters "Name=tag:Project,Values=$PROJECT" "Name=instance-state-name,Values=running" \
  --query 'Reservations[0].Instances[0].InstanceId' --output text 2>/dev/null || true)"
if [ -z "$INSTANCE_ID" ] || [ "$INSTANCE_ID" = "None" ]; then
  echo "[reconstruct] ERROR: no running instance tagged Project=$PROJECT found." >&2
  exit 1
fi
echo "[reconstruct] instance: <found by tag>"

# github_owner + repo_url from the git remote (no hardcoded owner — audit-safe).
ORIGIN="$(git -C "$REPO_ROOT" config --get remote.origin.url 2>/dev/null || true)"
# Normalise the SSH (git@github.com:) or HTTPS (https://github.com/) remote
# down to the "<owner>/<repo>" pair, dropping any trailing .git suffix.
OWNER_REPO="$(printf '%s\n' "$ORIGIN" | sed -E 's#^git@github\.com:##; s#^https://github\.com/##; s#\.git$##')"
GH_OWNER="$(printf '%s\n' "$OWNER_REPO" | cut -d/ -f1)"
GH_REPO="$(printf '%s\n' "$OWNER_REPO" | cut -d/ -f2)"
if [ -z "$GH_OWNER" ] || [ -z "$GH_REPO" ]; then
  echo "[reconstruct] ERROR: could not derive github owner/repo from remote.origin.url ($ORIGIN)." >&2
  exit 1
fi
REPO_URL="https://github.com/$GH_OWNER/$GH_REPO.git"

# 1) alarm_email — the live SNS email subscription endpoint (empty if none).
ALARM_EMAIL="$(aws sns list-subscriptions --profile "$PROFILE" --region "$REGION" \
  --query "Subscriptions[?Protocol=='email'].Endpoint | [0]" --output text 2>/dev/null || true)"
[ "$ALARM_EMAIL" = "None" ] && ALARM_EMAIL=""
echo "[reconstruct] alarm_email: $([ -n "$ALARM_EMAIL" ] && echo '<found>' || echo '<none>')"

# 2) domain — STACK_DOMAIN from the host's /etc/stack-env (persisted at boot),
#    read over SSM. memex_subdomain likewise; default 'brain' if absent.
PARAMS="$(mktemp)"
cat > "$PARAMS" <<'JSON'
{"commands":["grep -E '^STACK_DOMAIN=|^STACK_MEMEX_SUBDOMAIN=' /etc/stack-env 2>/dev/null || true"]}
JSON
CMD_ID="$(aws ssm send-command --profile "$PROFILE" --region "$REGION" \
  --document-name AWS-RunShellScript --instance-ids "$INSTANCE_ID" \
  --parameters "file://$PARAMS" --query 'Command.CommandId' --output text)"
rm -f "$PARAMS"
# Wait for the command to finish.
for _ in $(seq 1 20); do
  ST="$(aws ssm get-command-invocation --profile "$PROFILE" --region "$REGION" \
    --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" --query 'Status' --output text 2>/dev/null || echo Pending)"
  case "$ST" in Success|Failed|Cancelled|TimedOut) break;; esac
  sleep 3
done
STACK_ENV="$(aws ssm get-command-invocation --profile "$PROFILE" --region "$REGION" \
  --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" --query 'StandardOutputContent' --output text 2>/dev/null || true)"
DOMAIN="$(printf '%s\n' "$STACK_ENV" | sed -n 's/^STACK_DOMAIN=//p' | head -1 | tr -d '[:space:]')"
SUBDOMAIN="$(printf '%s\n' "$STACK_ENV" | sed -n 's/^STACK_MEMEX_SUBDOMAIN=//p' | head -1 | tr -d '[:space:]')"
[ -z "$SUBDOMAIN" ] && SUBDOMAIN="brain"

if [ -z "$DOMAIN" ]; then
  echo "[reconstruct] ERROR: could not read STACK_DOMAIN from the host. Not writing tfvars" >&2
  echo "               (set it by hand in $OUT, or check /etc/stack-env on $INSTANCE_ID)." >&2
  exit 1
fi
echo "[reconstruct] domain: <found> subdomain: $SUBDOMAIN"

# 3) Write the complete, apply-ready tfvars (gitignored).
cat > "$OUT" <<EOF
# terraform.tfvars — GITIGNORED. Reconstructed by scripts/reconstruct-tfvars.sh
# from live state on $(date -u +%Y-%m-%dT%H:%M:%SZ). Real values (domain,
# alarm_email) are read back from the applied infrastructure so a subsequent
# \`terraform plan\` shows 0 changes. Never commit this file.

aws_region     = "$REGION"
aws_profile    = "$PROFILE"
tfstate_region = "eu-central-1"

project_name   = "$PROJECT"
repo_name      = "$GH_REPO"
github_owner   = "$GH_OWNER"
secrets_prefix = "memex"

domain          = "$DOMAIN"
memex_subdomain = "$SUBDOMAIN"

repo_url = "$REPO_URL"

# Read back from the live SNS email subscription — do NOT blank this or the
# plan will DESTROY the SNS topic + subscription.
alarm_email = "$ALARM_EMAIL"

# Matches the live instance (t4g.medium, arm64). enable_cloudtrail defaults true
# (a live audit bucket exists). Everything else picks up variables.tf defaults.
instance_type = "t4g.medium"
EOF
chmod 0600 "$OUT"
echo "[reconstruct] wrote $OUT"
echo "[reconstruct] NEXT: cd terraform && terraform plan -var-file=terraform.tfvars"
echo "               A correct reconstruction shows 'No changes' (0 add/change/destroy)."
echo "               If plan wants to DESTROY the SNS subscription, alarm_email is wrong — fix it."

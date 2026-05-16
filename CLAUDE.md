# CLAUDE.md — Rules for AI agents working in this repo

This file is auto-loaded by Claude Code (and other AI coding agents that
honor the convention). It defines the safety and scope rules every agent
must follow when editing this codebase.

## What you are allowed to do
- Read files and understand the codebase.
- Edit config, scripts, and docs when explicitly asked.
- Run `terraform plan` and `make audit` to show what would change.
- Run AWS CLI read-only commands (`describe`, `list`, `get`).
- Commit and push ONLY when explicitly asked.

## What you are NOT allowed to do without explicit confirmation

### Destructive infrastructure changes
- NEVER run `terraform apply` without showing the plan first AND getting
  explicit "yes, apply".
- NEVER destroy or replace running EC2 instances without explicit
  confirmation.
- NEVER change availability zones, instance types, or subnet
  configurations without warning.
- If a terraform plan shows ANY resource being destroyed or replaced — STOP and ask first.

### File and git operations
- NEVER run `git reset --hard` or any destructive git command.
- NEVER commit files that were not explicitly included in the request.
- NEVER stage and commit deleted files unless explicitly asked to remove them.
- Disk files and git files are DIFFERENT — do not confuse them.

### Scope of work
- Do ONLY what was asked. If asked to fix a config file, fix that file
  only.
- Do NOT remove integrations, features, or code that was not mentioned.
- Do NOT "clean up" things that look unused — ask first.
- Do NOT add, remove, or modify terraform resources beyond what was asked.
- Do NOT add monitoring, alarms, notifications, health checks, dashboards,
  or any new AWS infrastructure that the user did not explicitly request,
  even if it would "improve reliability" or "catch the next failure".
  Discuss the idea in plain text first, agree on the approach, and only
  then build.

## Key principle

**Ask before acting on anything irreversible.** The cost of one
confirmation message is zero. The cost of a destroyed EC2 instance or
lost disk data is high.

## Project context
- The single EC2 instance is a running service — treat it like production.
- Disk state on the instance ≠ git state — they are separate.
- Terraform changes can destroy live infrastructure — always plan first,
  apply second.

## Conventions

### AWS model selection
- The chat-side model picker is hardcoded in `scripts/post-onboard.sh`:
  Nova 2 Lite (primary) with Nova Pro/Lite/Micro fallbacks. The
  `var.bedrock_model_id` terraform variable surfaces the configured
  default in `terraform output bedrock_model` but does NOT yet drive
  post-onboard — keep them aligned manually until they're wired through.
- The default is Amazon Nova 2 Lite — credit-eligible, multi-turn-safe.
- Anthropic models (Claude family) are NOT credit-eligible — they cost
  real money. Adding one is an explicit code change in
  `scripts/post-onboard.sh` AND the IAM policy in `terraform/iam.tf`.

### Secret naming
- Every secret is prefixed by `var.secrets_prefix` (default: `memex`,
  override via `scripts/init.sh` for a new install).
- The pattern is `<prefix>/<name>` — e.g. `memex/telegram-bot-token`.

### Audit gate
- `make audit` reads `scripts/lib/pii-patterns.txt` and fails on any
  maintainer-private identifier (account IDs, domains, emails, instance
  IDs) found in a tracked file. The CI workflow runs this on every push.

## Repo-specific operational notes

Anything maintainer-specific (live instance IDs, account-specific incident
notes, AWS account-specific lessons) lives in `OPERATIONS_NOTES.md`, which
is `.gitignored` and never leaves the maintainer's machine. New operational
findings — especially incident retros — go there, not here.

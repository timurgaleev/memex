# Contributing

Solo-maintained project — contributions land slowly. PRs welcome anyway.

## Development setup

Prerequisites:
- Bash 3.2+ (macOS default works)
- Docker Compose v2
- Terraform 1.6+
- `aws` CLI (for AWS Secrets Manager / Bedrock / S3)
- An AWS account with admin-equivalent permissions (you'll create
  resources, not just read them)

Local-only checks need no AWS account:

```bash
git clone https://github.com/<your-fork>/memex.git
cd memex

make test    # bash unit tests (init.sh + audit.sh)
make audit   # PII gate
make lint    # shellcheck if installed
```

## Coding conventions

### Bash

- `#!/usr/bin/env bash` for new scripts.
- `set -euo pipefail` at the top of every script.
- POSIX `[ ... ]` and `[[ ... ]]` are both fine; pick one per file.
- Long-flag form (`--foo`) preferred for readability.
- Atomic writes for state files: `mktemp` → write → `mv -f`.

### Terraform

- Match existing patterns. `var.project_name`, `var.secrets_prefix`,
  conditional `count = var.X != "" ? 1 : 0` — copy, don't invent.
- `lifecycle.ignore_changes = [ami, user_data]` on every EC2 resource —
  protects against accidental replacement.
- Backend stays partial (`backend "s3" {}`) — concrete values go in
  `terraform/backend.hcl` from `make init`.

### Docs

- ASCII diagrams beat Mermaid for source-of-truth files. They render
  in every terminal and never fall behind the code.
- Update `ARCHITECTURE.md` and `CHANGELOG.md` in the same commit as the
  behavior change, not later.
- The `make audit` gate refuses commits with maintainer-private
  identifiers (see `scripts/lib/pii-patterns.txt` for the regex set).
  Local-only matches go in `scripts/lib/pii-patterns.local.txt`
  (gitignored, auto-loaded by the audit script).
- The companion `make scrub-audit` runs a broader pre-publication
  sweep — categorised report, fails on HIGH-severity hits.

## Test policy

- Every new bash script gets a `tests/<name>.test.sh` with at least
  happy-path + one edge case + one error path.
- Terraform changes: `terraform fmt -check`, `terraform validate`, and
  reviewed `terraform plan` output.
- Container changes: `docker compose --env-file .env -f
  deploy/docker-compose.yml config` MUST parse without error.

## Commit conventions

```
<type>: <short summary>

<body, optional>
```

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`.

Examples:
- `feat(memex): add code chunkers for TS / Python`
- `fix(bootstrap): retry git clone on transient DNS failure`
- `docs(architecture): document EFS layout`

## Pull request flow

1. Branch from `main`. Naming: `feature/<short>`, `fix/<short>`, etc.
2. Run `make audit && make scrub-audit && make test && terraform -chdir=terraform validate`.
3. Open the PR using the template — describe what changed and why,
   include a `Test plan` checklist.
4. Wait for the maintainer review. No SLA, but no PR is rejected
   without an explanation.

## Required workflow for AI agents

If you are an AI coding agent working in this repo, two steps are
mandatory for **every** change — not just features:

1. **Run the matching review skill/agent** before declaring work done.
   Pick the reviewer by what changed (full table in `CLAUDE.md` →
   "Self-review after each implementation"): e.g. `security-engineer`
   for secrets/auth, `code-reviewer` for logic, `devops-automator` for
   CI/docker/terraform, `technical-writer` for docs. Act on every
   CRITICAL / HIGH finding.
2. **Follow the ship workflow** in `CLAUDE.md` —
   **test → push → deploy → verify**. A change is not shipped until the
   live EC2 runs it and the `/health` + MCP smoke checks pass.

Human contributors run the local gate in step 2 of the PR flow above;
the maintainer runs the agent review on incoming PRs.

## Release process

Releases follow SemVer + Keep a Changelog and ship only after the
change is live and verified:

1. Roll the `[Unreleased]` changelog entries into a dated
   `## [X.Y.Z] — <date>` section, leaving an empty `[Unreleased]`.
2. `git tag vX.Y.Z && git push origin vX.Y.Z` — the tag must point at a
   CI-green commit that is already deployed to the EC2.
3. `gh release create vX.Y.Z --title vX.Y.Z --notes "<changelog
   section>"`.

`package.json` versions are intentionally decoupled from the release
tag and are not bumped here.

## Things that will NOT be accepted

- Changes that add unrequested monitoring, dashboards, alarms, or
  notifications (see `CLAUDE.md`).
- Changes that hardcode maintainer-private values (the audit gate
  catches these mechanically).
- Refactors of code that isn't changing — match existing style instead.
- Force-pushes to `main`.

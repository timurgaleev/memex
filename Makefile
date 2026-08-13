# Makefile — orchestration for memex
#
# Designed to be the OSS entry point: clone → make init → make plan →
# make deploy. Internal targets (audit, test) are dependencies of the
# public-facing ones.
#
# Quick reference:
#   make init      interactive bootstrap (writes .env, tfvars, backend.hcl)
#   make audit     fail if any PII pattern matches a tracked file
#   make test      run bash unit tests in tests/
#   make plan      terraform init + plan (depends on audit)
#   make apply     terraform apply (depends on audit + plan)
#   make deploy    rebuild and restart the docker-compose stack (depends on audit)
#   make destroy   terraform destroy (NO automatic safeguards — answer carefully)
#   make help      show this list

.PHONY: help init audit scrub-audit typecheck lint-ts test plan apply deploy destroy lint

# Default target — print help.
help:
	@awk 'BEGIN {FS = ":.*##"} /^[a-zA-Z_-]+:.*##/ {printf "  %-12s %s\n", $$1, $$2}' $(MAKEFILE_LIST)
	@echo ""
	@echo "Common flow: make init  →  make audit  →  make plan  →  make apply  →  make deploy"

init: ## Interactive bootstrap — writes .env, terraform.tfvars, backend.hcl
	@bash scripts/init.sh $(ARGS)

audit: ## Fail if any PII pattern matches a git-tracked file
	@bash scripts/audit.sh

scrub-audit: ## Broader pre-publication audit — categorised report, fails on HIGH hits
	@bash scripts/scrub-audit.sh

typecheck: ## Typecheck the shipping TypeScript (src/); tests/ backlog via `bun run typecheck:all`
	@cd deploy/memex && bun run typecheck

lint-ts: ## Lint the daemon TypeScript (correctness rules only; eslint.config.js says what is off and why)
	@cd deploy/memex && bun run lint

test: ## Run bash unit tests under tests/*.test.sh + the search_path guard
	@bash scripts/check-search-path.sh
	@status=0; \
	for f in tests/*.test.sh; do \
	  [ -e "$$f" ] || { echo "(no bash tests found)"; break; }; \
	  echo "=== $$f ==="; \
	  bash "$$f" || status=$$?; \
	done; \
	exit $$status

lint: ## Static check of bash scripts (shellcheck if available)
	@if command -v shellcheck >/dev/null 2>&1; then \
	  shellcheck scripts/*.sh tests/*.test.sh deploy/memex/scripts/*.sh 2>/dev/null || true; \
	else \
	  echo "shellcheck not installed — skipping"; \
	fi

plan: audit ## Terraform plan (gated by audit)
	@cd terraform && \
	  test -f backend.hcl || { echo "[plan] terraform/backend.hcl missing — run 'make init' first" >&2; exit 1; } && \
	  test -f terraform.tfvars || { echo "[plan] terraform/terraform.tfvars missing — run 'make init' first" >&2; exit 1; } && \
	  terraform init -backend-config=backend.hcl -reconfigure && \
	  terraform plan -var-file=terraform.tfvars

apply: audit ## Terraform apply (gated by audit; manual confirmation)
	@cd terraform && terraform apply -var-file=terraform.tfvars

destroy: ## Terraform destroy (NOT gated by audit — confirm before running!)
	@echo "[destroy] This will tear down all infrastructure. Ctrl-C to abort."
	@sleep 5
	@cd terraform && terraform destroy -var-file=terraform.tfvars

deploy: audit ## Rebuild + restart the docker-compose stack on the EC2 host
	@echo "[deploy] running on the configured EC2 — this is meant to be run via SSM"
	@test -f .env || { echo "[deploy] .env missing — run 'make init' or 'scripts/bootstrap.sh' first" >&2; exit 1; }
	@docker compose --env-file .env -f deploy/docker-compose.yml up -d --build

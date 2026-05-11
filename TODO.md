# TODO — memex-stack

Forward-looking work that is intentionally deferred. Items already
shipped live in `CHANGELOG.md`; items rejected as out-of-scope live
under "NOT in scope" in the design docs that introduce them.

---

## Planned removals

- **`obsidian-sync` container** — slated for removal in a future
  release. Vault sync will become user-provided (native Obsidian
  Sync, git-based sync, or any other mechanism that writes into the
  EFS-mounted vault path). When this lands: delete
  `deploy/obsidian-sync/`, drop the service from
  `docker-compose.yml`, remove the related Secrets Manager entry
  (`<secrets_prefix>/obsidian-sync`) from `terraform/secrets.tf`, and
  document the migration path for existing deployers.

---

## OSS scaffold polish

- Multi-arch CI matrix (amd64 + arm64) — currently arm64 only.
- GHCR image publishing for `memex` and `openclaw` containers — today
  the images are built on the EC2 host on every deploy.
- GitHub Pages docs site — `ARCHITECTURE.md` + `deploy/*/docs/` would
  render as a small Docusaurus / mkdocs site.
- Standalone `memex` npm publish — split the brain out of the stack
  if demand for it standalone materializes.

---

## How to add a TODO

Open an issue using the `Feature / enhancement` template. PRs are
welcome but please open the issue first so we can agree on shape.

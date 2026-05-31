# TODO — memex-stack

Forward-looking work that is intentionally deferred. Items already
shipped live in [`CHANGELOG.md`](./CHANGELOG.md); items rejected as
out-of-scope live under "NOT in scope" in the design doc that
introduces them.

---

## Operator post-install steps

Things `make init` + `terraform apply` + `bootstrap.sh` do NOT
automate today. Run these once after the first deploy:

- **Allowlist your Telegram chat id for the bridge.** The
  `telegram-bridge` container refuses messages from any chat not
  listed in `MEMEX_BRIDGE_ALLOWED_CHAT_IDS`. Add a comma-separated
  list of numeric chat ids to `.env` on the host and restart the
  service:
  ```bash
  # find your chat id by sending /start to the bot; the bridge logs
  # "ignoring message from unallowed chat id <N>"
  echo "MEMEX_BRIDGE_ALLOWED_CHAT_IDS=<N>" >> /opt/memex/.env
  docker compose --env-file /opt/memex/.env \
    -f /opt/memex/deploy/docker-compose.yml \
    up -d telegram-bridge
  ```

- **Install host-side systemd timers** for the daily bearer rotation
  and the hourly gcal / gmail polls:
  ```bash
  sudo install -m 644 deploy/systemd/memex-gcal-poll.{service,timer} \
                       deploy/systemd/memex-gmail-poll.{service,timer} \
                       deploy/systemd/memex-rotate-bearer.{service,timer} \
                       /etc/systemd/system/
  sudo install -d /var/log/memex
  sudo systemctl daemon-reload
  sudo systemctl enable --now \
       memex-gcal-poll.timer memex-gmail-poll.timer memex-rotate-bearer.timer
  ```
  Verify with `systemctl list-timers memex-* --all`.

These steps are documented to be folded into `bootstrap.sh` in a
future release.

---

## Operator-only follow-ups (cannot be automated remotely)

- **Re-authorize Gmail OAuth.** Run `scripts/gmail-oauth-bootstrap.sh`
  from your laptop (needs a browser for Google consent). If the
  `memex/gmail-oauth` `refresh_token` returns `invalid_grant: Token
  has been expired or revoked`, this is the path back. After re-auth,
  the systemd `memex-gmail-poll.timer` will fire green.
- **Realign terraform state with renamed `memex-*` addresses.** Local
  `moved.tf` (gitignored historical scaffold) reduces the diff, but
  the plan still wants to *replace* the EFS and EC2 security groups
  in place — that recreates the SGs and risks momentary loss of EFS
  mount + EC2 traffic. Apply ONLY during a planned maintenance window
  and AFTER confirming the SG-replacement is safe in your environment.
  Live config is already functionally correct; this is cosmetics on
  the terraform state.
- **Rotate `memex/memex-postgres-url` (RDS master password).** Out-of-band
  via `aws rds modify-db-instance --master-user-password ... --apply-immediately`,
  then write the new URL to `memex/memex-postgres-url` via
  `secretsmanager put-secret-value`, then SSM the EC2 and run
  `bash /opt/memex/deploy/secrets/fetch-secrets.sh && docker
  compose --env-file .env -f /opt/memex/deploy/docker-compose.yml restart memex`.
  **Gotcha:** the password is interpolated into a URL in the
  `memex/memex-postgres-url` secret. RDS accepts any printable ASCII
  except `/`, `"`, `@`, space, but the postgres URL parser inside
  the memex container additionally requires `?`, `#`, `&`, `:`, `=`,
  `+`, `%` to be percent-encoded. The safe pattern:
  ```bash
  RAW=$(aws secretsmanager get-random-password \
    --password-length 32 \
    --exclude-characters '/"@ $`'"'"'?#&:=+%' \
    --region eu-west-1 --query RandomPassword --output text)
  ```
  (or URL-encode the raw value via
  `python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''),end='')" "$RAW"`
  before assembling the URL).
- **Destroy the orphaned `gateway-token` AWS secret.** The chat-agent
  removal dropped the resource from `terraform/secrets.tf` but the
  live secret persists until `terraform apply` runs. Next plan will
  show `Plan: 0 to add, 0 to change, 1 to destroy`. Roughly $0.40/mo
  to leave orphaned; cosmetic.

---

## Bridge follow-ups

- **Module refactor.** `deploy/telegram-bridge/main.py` is one ~900-line
  file. A future split into `handlers.py` / `memex_client.py` /
  `bedrock_client.py` / `help_text.py` would improve clarity. Tests
  already pass; this is pure organisation.
- **Bearer file owner instead of mode 0444.** The bridge container
  runs as uid 10001 inside `.secrets/` (mode 0711). Switching from
  world-readable file (`0444`) to owner-readable (`0400` + chown to
  10001) would shrink the blast radius if the bridge image is ever
  exploited.

---

## Defence-in-depth hardening (deferred)

- **Jobs DAG: align FK delete behaviour between `jobs.parent_job_id`
  and the `job_children` / `child_done_inbox` tables.** Today
  `parent_job_id REFERENCES jobs(id) ON DELETE SET NULL` keeps the
  child row alive (with NULL parent) when the parent is purged, but
  `job_children` and `child_done_inbox` both `ON DELETE CASCADE` —
  the edge tables vanish while the child's `parent_job_id` column
  goes to NULL. `listChildren()` / `drainDoneInbox()` then see zero
  rows even though the children still exist. We have no
  job-delete endpoint exposed today so this is theoretical, but
  before we add one we either (a) make all three FKs CASCADE
  (purging a parent purges the subtree) or (b) explicitly reject
  deleting a parent that has children. Flagged in the migration
  comment of `019_jobs_dag.sql`.

- **Jobs DAG: inbox-during-cancel race.** `writeChildDoneInbox` runs
  with `engine.query` (its own implicit txn), `cancelJob` runs with
  `engine.transaction`. A child completing concurrently with a
  cascade-cancel BFS sees a non-snapshot view: a freshly inserted
  pending child added after the frontier read is missed by cancel,
  while its `writeChildDoneInbox` lands as an orphan pointing at a
  job whose status is by then `cancelled`. Mitigation today: the
  parent's drain logic should ignore inbox rows whose `parent.status`
  is terminal. Long-term fix: read the frontier with `FOR UPDATE` or
  switch the cancel txn to `SERIALIZABLE` isolation. PGLite supports
  `SERIALIZABLE` so we can prove it locally before shipping to RDS.

- **A.5 ledger: future supervisor must bind pending tool rows to a
  worker.** `subagent_tool_executions` records `status = 'pending'`
  rows BEFORE the tool runs, so a crash-recovery sweep can pick
  them up. The supervisor that lands in a future phase MUST bind
  each pending row to a `supervisor_run_id`/`worker_id` and only
  the originating worker may retry it; cross-worker pending rows
  must be `skipped`, NOT re-executed. Without this, anyone who can
  write a pending row (internal-token-gated today) causes the next
  sweep to invoke the named `tool_name` with their forged `input`
  -- a stored command injection into the agent loop. Flagged in
  the doc comment of `beginToolExecution`.

- **A.5 ledger: enforce internal-token-only when A.6 wires MCP.**
  `subagent_messages.content` carries the raw Bedrock Converse
  payload (system prompts, tool inputs with OAuth/Bearer tokens),
  `subagent_tool_executions.input/output/error` carry arbitrary
  tool payloads, `hot_memory.fact` is the unfiltered observation
  stream keyed by predictable slugs (`people/<name>`). A.6's
  forthcoming `subagent_messages`/`subagent_tool_executions`/
  `hot_list` MCP tools MUST go in the WRITE-tools allowlist
  (`FORBIDDEN_MCP_TOOLS_FROM_PUBLIC`) so the public-bearer never
  reaches them. If a public projection is ever needed it must
  drop `content` / `input` / `output` / `error` at the SQL layer,
  not the serializer, and return `404` uniformly on miss to
  prevent entity-existence enumeration. Documented inline in
  `core/hot_memory.ts` and `core/subagent_ledger.ts` headers.

---

## Revival projects

These are intentionally archived. Pick them up if and when you want
the capability back.

- **Morning briefing.** A host-side composer that calls the helper
  CLIs at `/opt/memex/bin/` directly, synthesises prose via Bedrock
  Haiku, and delivers via the Telegram Bot API, driven by a new
  systemd timer at `*-*-* 07:00:00 Europe/Berlin`. The IAM grants it
  needs already exist; no new infrastructure required.

---

## OSS scaffold polish

- Multi-arch CI matrix (amd64 + arm64) — currently arm64-only because
  the default `var.instance_type` is `t4g.medium`. Track in an issue;
  not a 1.0 blocker.
- GHCR image publishing for `memex` and `telegram-bridge` containers —
  today the images are built on the EC2 host on every deploy. Issue
  first to agree on tag scheme + release cadence.
- GitHub Pages docs site — `ARCHITECTURE.md` + `deploy/*/docs/` would
  render as a small Docusaurus / mkdocs site. Out of scope until
  there's a second deployer.
- Standalone `memex` npm publish — split the brain out of the stack
  if demand for it standalone materializes.

---

## How to add a TODO

Open an issue using the `Feature / enhancement` template. PRs are
welcome but please open the issue first so we can agree on shape.

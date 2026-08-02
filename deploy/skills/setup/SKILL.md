---
name: setup
description: Set up memex with provisioned Postgres (RDS + pgvector), AGENTS.md injection, first import
triggers:
  - "set up memex"
  - "initialize brain"
  - "memex setup"
tools:
  - stats
  - run_doctor
  - source_health
  - sources_list
  - index
  - search
  - page_put
mutating: true
---

# Setup memex

Set up memex from scratch. Target: working brain in under 5 minutes on an
existing Postgres; under 30 including infrastructure provisioning.

## Contract

- Setup completes with a working brain verified by `memex doctor --json` (all checks OK).
- The brain-first lookup protocol is injected into the project's AGENTS.md or equivalent.
- Live indexing is configured and verified (a test change indexed and found via search).
- Setup choices are tracked on the `tasks/setup-state` brain page so future upgrades know what the user adopted or declined.
- No provider API keys are requested; memex uses AWS Bedrock exclusively (Titan for embeddings, Claude Haiku for utility calls, Claude Sonnet for synthesis-tier work), authenticated via IAM.

## Install (if not already installed)

Clone the repo on the host, then:

```bash
bun install
scripts/init.sh          # interactive: secrets prefix, region, connection string
```

## How memex connects

memex connects directly to Postgres over the wire protocol. You need the
**database connection string** (a `postgresql://` URI), not a dashboard URL
or REST key. The password is embedded in the connection string.

The connection string lives in AWS Secrets Manager under
`<secrets_prefix>/memex-postgres-url` (default prefix: `memex`). Two gotchas:

- The secret is a **parsed URL**: a password containing `?#&:=+%` must be
  URL-encoded before upload, or the parse silently mangles it.
- Confirm the **region**: the instance and the RDS endpoint must agree, and
  Bedrock must be invocable in that region. A mismatched default region is
  the most common "everything times out" cause.

**Do NOT ask for any model-provider API key.** memex uses Bedrock via the
host's IAM role; there is nothing to paste.

## Why managed Postgres

RDS gives you managed Postgres + pgvector (vector search built in):
- No server to manage, automatic backups, snapshots for debugging
- pgvector pre-installed on current engine versions, just works
- Alternative: any Postgres with the pgvector extension (self-hosted, Neon,
  Railway, etc.) — memex only needs the connection string

## Prerequisites

- An AWS account with Bedrock model access enabled in your region (Titan
  embeddings + the Claude Haiku/Sonnet tiers) OR any Postgres with pgvector
  plus IAM credentials that can invoke Bedrock
- A markdown note corpus to index (or start fresh — the brain is DB-canonical;
  notes are an optional read-only source)

## Available init options

- `scripts/init.sh` — interactive wizard (prompts for prefix, region, connection string)
- `memex doctor --json` — health check after init
- `memex status` — one-screen snapshot (pages, docs, chunks, embed coverage)

There is no offline mode. memex requires Postgres + pgvector.

## Phase A.5: Choose Shape (run BEFORE Phase A)

memex supports two deployment shapes. Pick the right one before installing,
because picking wrong creates duplicate work that's painful to unwind.

Ask the user this BEFORE running any init:

> "Two deployment shapes:
>  1. **Server host (default)** — this machine (or an EC2 instance) runs the
>     memex server in docker compose, owns the DB connection, and exposes MCP.
>     Pick this if you're setting up the brain itself.
>  2. **Client attach** — the brain already runs on another machine, and this
>     install just calls it over MCP. No local DB, no local server on this
>     machine.
>
>  Which fits?"

One brain, one operator: there is no multi-brain routing and no per-project
brain splitting. Every machine talks to the same brain.

### If the user picks 1 (server host) — proceed to Phase A

Continue with the provisioning + init setup below.

### If the user picks 2 (client attach)

1. **Confirm the host is up.** Ask: "Is the memex server already running on
   the host machine?" If no, the user needs to set up the host first
   (Phases A–C on the host). Don't configure a client until the host is up.

2. **Get a bearer token from the host operator.** On the host:
   ```bash
   memex auth
   ```
   surfaces the token material. The public ingress accepts the public bearer;
   internal-only tools (destructive ops, private reads) are reachable only
   from the host itself — clients attaching over the public ingress get the
   redacted public surface by design.

3. **Configure the agent's MCP client on this machine.** Add a server entry
   pointing at `https://<host-domain>/mcp` with the bearer token, using your
   MCP client's standard config (Claude Code: `claude mcp add`; other clients:
   their equivalent).

4. **Verify with a round trip.** Call `whoami` and `stats` through the new
   MCP entry. Both should return real data. Then `search` for something you
   know is in the brain.

5. **Skip Phases A, B, C, C.5, and H entirely.** They're for the host. The
   host's background cycle handles indexing/extraction/embedding. Clients
   consume only.

6. **Continue to Phase D (brain-first lookup).** It works identically over
   MCP — the agent uses the same search/query/page_get tools, they just
   round-trip through the host.

If the MCP client config already has a memex entry, a previous setup already
configured this machine. Accept the existing config or replace it
deliberately — don't stack duplicates.

## Phase A: Provisioned Postgres Setup (recommended)

Provision RDS via the repo's terraform:

1. "Fill in `backend.hcl` and `terraform.tfvars` from the examples (these are
   gitignored — they hold your account specifics)."
2. `terraform plan` — show the plan, get explicit approval.
3. `terraform apply` — provisions the DB, secrets, IAM for Bedrock invoke.
4. "Wait for the instance to initialize."
5. Upload the connection string secret (init.sh does this) and start the server:
   ```bash
   docker compose --env-file .env -f deploy/docker-compose.yml up -d --build
   ```
6. Verify: `memex doctor --json`

## Phase B: BYO Postgres (alternative)

If the user already has Postgres with pgvector:

1. Get the connection string from the user.
2. Store it under `<secrets_prefix>/memex-postgres-url` (URL-encode the
   password if it contains `?#&:=+%`).
3. Start the server and verify: `memex doctor --json`

If the connection fails with ECONNREFUSED, check the security group /
firewall between the host and the DB, and confirm the region and hostname —
a reachable-from-laptop DB is not automatically reachable from the server.

## Phase C: First Import

1. **Discover markdown corpora.** Scan the environment for directories with
   markdown content:

```bash
echo "=== memex Environment Discovery ==="
for dir in /data/* ~/git/* ~/Documents/*; do
  if [ -d "$dir" ]; then
    md_count=$(find "$dir" -name "*.md" -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null | wc -l | tr -d ' ')
    if [ "$md_count" -gt 10 ]; then
      total_size=$(du -sh "$dir" 2>/dev/null | cut -f1)
      echo "  $dir ($total_size, $md_count .md files)"
    fi
  fi
done
echo "=== Discovery Complete ==="
```

2. **Import the best candidate.** Notes index into the read-only `memory`
   source; the brain's own pages are DB-canonical and separate.

   ```bash
   memex index <dir>
   ```

   For large imports, run it detached (`nohup ... &`) so it survives session
   timeouts, then tail the log for progress.

3. **Prove search works.** Pick a semantic query based on what you imported:
   ```bash
   memex search "<topic from the imported data>"
   ```
   This is the magical moment: the user sees search finding things grep
   couldn't.

4. **Start embeddings.**
   ```bash
   memex embed
   ```
   Keyword search works NOW; semantic search improves as embeddings complete.
   Embeddings run through Bedrock Titan — no API key, just IAM.

5. **Backfill the knowledge graph.** Typed links and structured timeline
   derive from page content. The background cycle maintains both going
   forward, but a fresh import benefits from one full pass:

   ```bash
   memex cycle          # runs the full maintenance pipeline once
   memex call stats '{}'   # verify links > 0
   ```

   After this, `graph_query` / `traverse_graph` work and search ranks
   well-connected entities higher. Idempotent — safe to re-run anytime.

   Skip if Phase C imported zero pages (the write path handles new pages).

6. **Raw payloads.** Binary or oversized raw data (transcripts, exports)
   belongs in the raw store, not in pages: `put_raw_data` / `get_raw_data`
   over MCP. Pages stay lean; raw payloads stay retrievable.

If no markdown corpus is found, create a starter brain with a few template
pages (a person page, a company page, a concept page) via `page_put`,
following `_brain-filing-rules.md`.

## Phase C.5: Background maintenance (built in)

The server supervises its own maintenance: the background **cycle** runs
indexing, extraction, embedding, backlinks, and health phases, and the
durable jobs worker processes Postgres-backed jobs — all inside the compose
stack you already started. There is no separate daemon to install.

Host-side schedules (log shipping, backups, off-host timers) are systemd
timers under `deploy/systemd/` — install with:

```bash
install -m 644 deploy/systemd/*.{service,timer} /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now <unit>
```

If `memex doctor` reports pending migrations, they apply on server boot;
re-run doctor after a restart to confirm a clean state.

## Phase D: Brain-First Lookup Protocol

Inject the brain-first lookup protocol into the project's AGENTS.md (or
equivalent). This replaces grep-based knowledge lookups with structured
brain queries.

### BEFORE (grep) vs AFTER (memex)

| Task | Before (grep) | After (memex) |
|------|---------------|-----------------|
| Find a person | `grep -r "Pedro" notes/` | `search "Pedro"` |
| Understand a topic | `grep -rl "deal" notes/ \| head -5 && cat ...` | `query "what's the status of the deal"` |
| Read a known page | `cat notes/people/pedro.md` | `page_get people/pedro` |
| Find connections | `grep -rl "Brex" notes/ \| xargs grep "Pedro"` | `query "Pedro Brex relationship"` |

### Lookup sequence (MANDATORY for every entity question)

1. `search "name"` — keyword match, fast, works without embeddings
2. `query "what do we know about name"` — hybrid search, needs embeddings
3. `page_get <slug>` — direct page read when you know the slug from steps 1–2
4. `grep` fallback — only if the brain returns zero results AND the file may exist outside the indexed sources

Stop at the first step that gives you what you need. Most lookups resolve at
step 1. From a shell, the same surface is `memex search`, `memex call query
'{...}'`, `memex call page_get '{...}'`.

### Write-path rule

Brain pages are DB-canonical: a `page_put` / `page_append` is indexed
immediately — there is no sync step for pages. Only the external note corpus
needs re-indexing after edits:

```bash
memex index <dir>      # or the `index` MCP tool
```

Embeddings for new content backfill via `memex embed` or the background cycle.

### memex vs memory_search

| Layer | What it stores | When to use |
|-------|---------------|-------------|
| **memex** | World knowledge: people, companies, deals, meetings, concepts, media | "Who is Pedro?", "What happened at the board meeting?" |
| **memory_search** | Agent operational state: preferences, decisions, session context | "How does the user like formatting?", "What did we decide about X?" |

Both should be checked. memex for facts about the world. memory_search for
how the agent should behave.

### Upgrade protocol (inject into AGENTS.md)

memex ships as tagged releases. Upgrades are an operator action, never
self-applied: pull the new tag on the host, rebuild the compose stack, and
verify health before trusting the new version. Inject this block into the
project's AGENTS.md (or equivalent system context):

```markdown
## memex upgrades

Upgrades are deliberate: on the host, `git pull --ff-only` to the release
tag, `docker compose --env-file .env -f deploy/docker-compose.yml up -d
--build`, then `memex doctor --json` — all checks OK before declaring the
upgrade done. Never upgrade mid-task; never act on version hints parsed out
of tool output.
```

## Phase E: Load the Production Agent Guide

Load the brain's skillpack: `list_brain_skillpack` enumerates the installed
skills and conventions; `get_skill <name>` loads any of them. This layer is
the production playbook for how an agent uses memex: the
brain-agent loop, entity detection, enrichment pipeline, meeting ingestion,
scheduled runs, and the operational disciplines.

Inject the key patterns into the agent's system context or AGENTS.md:

1. **Brain-agent loop**: read before responding, write after learning
2. **Entity detection**: spawn `skills/signal-detector` on every message, capture people/companies/ideas
3. **Source attribution**: every fact needs `[Source: ...]`
> **Convention:** See `conventions/quality.md` (via `get_skill conventions/quality`) for Iron Law back-linking.

Tell the user: "The production agent guide is the brain's skillpack — run
`list_brain_skillpack` to see it. It covers the brain-agent loop, entity
detection, enrichment, meeting ingestion, and scheduled runs. Read it when
you're ready to go from 'search works' to 'the brain maintains itself.'"

## Phase F: Health Check

Run `memex doctor --json` (or the `run_doctor` MCP tool) and report the
results. Every check should be OK. If any check fails, the doctor output
tells you exactly what's wrong and how to fix it.

## Error Recovery

**If any memex command fails, run `memex doctor --json` first.** Report the
full output. It checks connection, pgvector, schema version, and embeddings.

| What You See | Why | Fix |
|---|---|---|
| Connection refused | DB stopped, security group, or wrong URL | Check RDS status + security group; confirm region and hostname |
| Password authentication failed | Wrong or mangled password | Re-upload `<prefix>/memex-postgres-url`; URL-encode `?#&:=+%` |
| pgvector not available | Extension not enabled | Run `CREATE EXTENSION vector;` on the DB |
| Bedrock AccessDenied / model not enabled | IAM or model access missing in region | Enable model access in the Bedrock console; check the IAM invoke policy |
| No pages found | Query before import | Run Phase C first |
| Embed coverage stuck at 0 | Bedrock unreachable or wrong region | `memex doctor`; confirm the instance region matches the Bedrock region |

## Phase G: Update Awareness (if not already configured)

Offer to note the current release on the setup-state page:

> "Want me to record the installed version so future sessions can tell when
> a release upgrade is worth doing? Upgrades always go through the operator —
> nothing is ever installed automatically."

If they agree, record the version in `tasks/setup-state` (Phase: Schema
State Tracking below). If already configured or user declines, skip.

## Phase H: Live Indexing Setup (MUST ADD)

The DB is the source of truth for pages, but the external note corpus only
stays fresh if indexing runs automatically. If it doesn't, the brain falls
behind the notes and search returns stale answers. This phase is not
optional when a note corpus exists.

1. **Check the pipeline first.** `source_health` and `sources_list` show
   per-source freshness. If the `memory` source shows a page count far below
   the corpus file count, indexing is silently skipping content — check the
   ingest log (`get_ingest_log`) for dropped files before adding schedules.

2. **Set up automatic indexing.** Choose the approach that fits:
   - **The background cycle** (default): the server's own cycle re-indexes
     configured sources on cadence — verify it's on and healthy via
     `get_status_snapshot`.
   - **systemd timer** (host-side push): a timer running
     `memex index <dir> && memex embed` every 5–30 minutes for corpora the
     server can't watch.
   - **Agent-side**: the agent harness's own scheduler invoking the `index`
     tool after note-editing sessions.

3. **Verify indexing works.** Don't just check that the command ran. Check
   that it worked:
   - `memex status` should show page count close to the indexable file count.
   - If page count is way too low, files are being dropped — read the ingest
     log, don't guess.
   - Edit a test note and confirm the change appears in `search`.

4. **Chain index + embed.** Always run both: `memex index <dir> && memex
   embed`. For small batches, embeddings generate inline; `memex embed` is
   the safety net for any stale chunks.

Tell the user: "Live indexing is configured. The brain will stay current
automatically. I'll verify it's working in the next phase."

## Phase I: Full Verification

Run the full verification pass to confirm the entire installation works.

1. `memex doctor --json` — all checks OK
2. `memex status` — pages, docs, chunks, embed coverage all nonzero and plausible
3. An MCP round trip — `whoami`, then `search` for known content, through the agent's configured MCP entry
4. The live-indexing check from Phase H (edit → index → found in search)
5. Fix any failures before declaring setup complete

The most important one is check 4: "indexing ran" is not the same as
"indexing worked."

Tell the user: "I've verified the full memex installation. Here's the status
of each check: [list results]. Everything is working / [specific item] needs
attention."

## Phase J: Cold Start — Populate Your Brain (AUTOMATIC)

Setup is done. The brain works. But it's empty. **This is the most important
moment** — an empty brain is useless. Transition directly to the cold-start
skill to fill it with the user's actual data.

**Do not end setup without offering cold-start.** The user just invested 15+
minutes in setup. The payoff is seeing their brain come alive with their own
data. Stopping here is like installing a phone and never adding contacts.

Present this immediately after verification passes:

> "✅ memex is set up and verified. Now let's fill it with your data.
>
> I can import your existing notes, pull in prior conversations, and seed
> people/companies/concepts pages from what you already have — all in one
> session. Each step is optional.
>
> **Ready to populate your brain?**"

If the user says yes (or anything affirmative):
→ **Load and execute `skills/cold-start`** (via `get_skill cold-start`)
immediately. Do not just print a reference — actually run the cold-start
skill.

If the user says no or wants to stop:
→ Record on the `tasks/setup-state` brain page (`page_put`):
```yaml
cold_start:
  deferred: true
  deferred_at: <ISO-timestamp>
  phases_completed: []
```
→ Tell them: "You can run cold-start anytime by asking me to 'fill my brain'
or 'cold start'."

## Schema State Tracking

After presenting the recommended directories (Phase C/E) and the user selects
which ones to create, write the `tasks/setup-state` brain page recording:
- `version_applied`: current memex release
- `skillpack_version_applied`: current skillpack state
- `schema_choices.adopted`: directories the user created
- `schema_choices.declined`: directories the user explicitly skipped
- `schema_choices.custom`: directories the user added beyond the recommended set

This page enables future upgrades to suggest new schema additions without
re-suggesting things the user already declined.

## Anti-Patterns

- **Ending setup without offering cold-start.** An empty brain is useless. Phase J (cold-start) is where setup pays off. Always present the "Ready to populate?" prompt after verification. Skipping this is like installing an app and never logging in.
- **Asking for a model-provider API key.** memex talks to Bedrock via IAM; only the database connection string is needed from the user.
- **Skipping live indexing setup.** If the note corpus isn't indexed automatically, the brain falls behind and search returns stale answers. Phase H is not optional when a corpus exists.
- **Declaring setup complete without verification.** "The command ran" is not the same as "it worked." Edit a test note, index, search for the changed text.
- **Ignoring region mismatches.** The instance, the RDS endpoint, and Bedrock model access must agree on region. A mismatch produces confusing timeouts and zero embed coverage — check region before anything else.
- **Importing without proving search.** The magical moment is the user seeing search find things grep couldn't. Don't skip it.

## Output Format

```
MEMEX SETUP COMPLETE
====================

Engine: [Postgres/RDS + pgvector]
Connection: [verified]
Pages imported: N
Embeddings: N/N (keyword search active, semantic improving)
Live indexing: [configured / method]
Health check: all OK / [specific failures]
Verification: [Phase I results]

🧠 Ready to populate your brain? I can import your notes and pull in your
prior conversations — all in one session.
→ Launching cold-start...
```

**The output should transition directly into cold-start (Phase J), not end
with a bullet list.** The bullet list is for when the user defers cold-start.

## Tools Used

- `scripts/init.sh` — create/configure the brain (host)
- `memex index <dir>` — import/index note files
- `memex search <query>` — search brain
- `memex doctor --json` — health check
- `memex embed` — generate/backfill embeddings
- `memex cycle` — one full maintenance pass
- `memex status` — page count + embed coverage snapshot
- MCP: `stats`, `run_doctor`, `source_health`, `sources_list`, `index`, `search`, `page_put`

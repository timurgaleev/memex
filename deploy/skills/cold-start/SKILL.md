---
name: cold-start
version: 1.0.0
description: |
  Day-one data bootstrapping for a new brain. Sequences the highest-leverage
  data sources to go from empty brain to useful brain in one session. Uses the
  agent host's managed connectors for safe credential handling — the agent
  never holds raw API keys. Covers Gmail import, calendar sync, contacts
  seeding, X/Twitter archive, conversation imports, and file archives.
  Use when a user has just finished memex setup and asks "now what?"
triggers:
  - "cold start"
  - "fill my brain"
  - "bootstrap brain"
  - "import my data"
  - "day one"
  - "get started"
  - "what should I import first"
  - "populate brain"
  - "now what?"
tools:
  - search
  - query
  - page_get
  - page_put
  - link
  - add_timeline_event
  - index
  - stats
  - run_doctor
  - sources_status
mutating: true
writes_pages: true
writes_to:
  - people/
  - companies/
  - meetings/
  - daily/
  - media/
  - conversations/
  - sources/
  - tasks/
---

# Cold Start — Day-One Brain Bootstrapping

You have a working brain. Search works. Now what?

An empty brain is a static database. A brain with your email history, calendar,
contacts, conversations, and social media is a **live context membrane** that makes
every future interaction smarter. This skill sequences the highest-leverage data
sources to get you from zero to useful in one session.

## Contract

- Every import phase is gated on user consent (ask-user pattern) before proceeding.
- **Google/social API access goes through the agent host's managed connectors.**
  The agent never holds raw OAuth tokens or API keys. This is a safety requirement,
  not a preference. Host-managed connectors (e.g. the agent harness's Gmail /
  Calendar / Contacts MCP integrations) keep credentials in the harness, scope
  what each tool can do, and put destructive operations behind explicit approval.
  If no managed connector is available, the only safe alternative is offline file
  exports (Google Takeout, Twitter archive download).
- Each phase is independently valuable — the user can stop after any phase and still
  have a useful brain.
- Progress is tracked in a brain page at `tasks/cold-start-state` so interrupted
  sessions can resume.
- Entity detection and cross-linking run on every import, not as a separate pass.

## Prerequisites

- memex installed and reachable (`memex doctor` all green, or `run_doctor` over MCP)
- Agent has MCP access to the brain, and shell access for `memex` CLI commands

## The Priority Stack

Data sources ranked by **information density × ease of import**:

| Priority | Source | Why | Time | Pages Created |
|----------|--------|-----|------|---------------|
| 1 | Existing markdown/notes vault | Highest density — it's already structured | 5 min | 100s-1000s |
| 2 | Google Contacts | Seeds the people/ directory — names, emails, companies | 10 min | 50-500 |
| 3 | Google Calendar (90 days) | Meeting history with attendee context | 15 min | 30-90 |
| 4 | Gmail (recent threads) | Relationship context, active threads, org chart signals | 20 min | 50-200 |
| 5 | Conversations (AI chat exports) | Your thinking, questions, mental models | 15 min | 10-100 |
| 6 | X/Twitter archive | Your public positions, takes, engagement patterns | 20 min | 30-365 |
| 7 | File archives (Dropbox/Drive/local) | Historical documents, old writing, photos | 30+ min | varies |
| 8 | Meeting transcripts (recorder exports) | Deep relationship context from recorded calls | 20 min | 10-50 |

## Phase 0: Credential Safety (Required for API Access)

> **Safety boundary:** An AI agent with raw OAuth tokens to your Gmail, Calendar,
> and Contacts is an uncontrolled attack surface. One prompt injection, one
> malicious tool call, and your entire Google account is exposed. Host-managed
> connectors eliminate this risk class entirely.

Use the agent host's managed connectors — the credential boundary sits between
the model and your APIs. The model never sees your credentials — the harness
injects them at request time, scopes each tool, and gates destructive
operations on your approval.

**What host-managed connectors give you:**
- **Credential vaulting** — the model sees tool results, never real secrets
- **Scoped authorization** — each connector exposes exactly the operations it needs
- **Audit trail** — tool calls are visible in the session transcript
- **Human approval gates** — destructive operations (send email, modify calendar)
  require your explicit approval
- **Multi-service** — Gmail, Calendar, Contacts, Drive from one harness
- **Revocation** — disconnect the integration in one click, no token rotation needed

**Setup (15 min):**
1. In the agent host's settings, connect the Google services you want
   (Gmail, Calendar, Contacts) as MCP integrations.
2. Grant read scopes only — bootstrapping is read-only against Google.
3. Confirm the agent can list (not modify) data from each connected service
   before starting any import phase.

**Critical scoping rule:** grant the connectors broad READ scope for the
bootstrap ("read and search mail, events, contacts") but nothing that writes
back to Google. The brain import needs to see your data, never to change it.

### If the user declines connector access

Do NOT fall back to direct OAuth. Instead, skip Phases 2-4 (Contacts, Calendar,
Gmail) and proceed with offline-only imports:

- **Phase 1** (markdown/notes vault) — works without any API access
- **Phase 5** (conversation exports) — works from downloaded JSON files
- **Phase 6** (X/Twitter) — works from downloaded archive
- **Phase 7** (file archives) — works from local files
- **Phase 8** (meeting transcripts) — works from exported transcripts

Tell the user:
> "No problem. We'll skip the Google imports for now and work with file-based
> sources. You can connect the host's Gmail/Calendar/Contacts integrations
> anytime to unlock those imports safely."

**Do NOT offer direct OAuth as an alternative.** An agent holding raw Google
tokens is a security liability. The skill should not teach agents to store
credentials they shouldn't have.

## Phase 1: Existing Markdown / Notes-Vault Import

**The highest-leverage first import.** If the user already has a notes system, this
is hundreds or thousands of structured pages ready to go.

### Discovery

```bash
echo "=== Markdown Repository Discovery ==="
for dir in ~/data/* ~/git/* ~/Documents/* ~/notes/* ~/obsidian/*; do
  if [ -d "$dir" ]; then
    md_count=$(find "$dir" -name "*.md" -not -path "*/node_modules/*" \
      -not -path "*/.git/*" -not -path "*/.obsidian/*" 2>/dev/null | wc -l | tr -d ' ')
    if [ "$md_count" -gt 5 ]; then
      total_size=$(du -sh "$dir" 2>/dev/null | cut -f1)
      echo "  $dir ($total_size, $md_count .md files)"
    fi
  fi
done
```

### Import

```bash
# Index the vault as the read-only 'memory' note source — wikilinks and
# frontmatter come along; the brain stays DB-canonical.
memex index /path/to/vault

# Verify
memex status
memex call search '{"q":"<topic from the imported data>"}'
```

### Post-import

- Link and timeline derivation run in the brain's background cycle; kick it
  once to front-load: `memex cycle`
- Start embeddings for anything not yet covered: `memex embed`

> **Track progress:**
> ```
> page_put tasks/cold-start-state {"phase_1_complete": true, "pages_imported": N}
> ```

## Phase 2: Google Contacts → People Pages

**Seeds the people/ directory.** Every person in your contacts becomes a brain page
with name, email, phone, company, and notes. This is the foundation that all other
imports build on — when Gmail references "john@acme.com", the brain already knows
who John is.

### Via the host's Contacts connector

Ask the connector for all contacts with names, email addresses, phone
numbers, organizations, and notes (paginate to ~1000 per pull).

### Processing rules

For each contact:
1. **Filter out noise** — skip contacts with no name, no email, or that are clearly
   automated (noreply@, no-reply@, support@, notifications@)
2. **Check brain first** — `search "name"` to avoid duplicates
3. **Create a people/ page** (`page_put`) with:
   - Name, email(s), phone(s), company, title
   - Source attribution: `[Source: Google Contacts, YYYY-MM-DD]`
   - Any notes from the contact as initial context
4. **Link to company** — if the contact has an organization, create/update the
   company page and `link` the person to it

### Quality gate

After importing 5 contacts, pause and show the user a sample page. Ask:
> "Here's what a contact page looks like. Want me to continue with the rest, or
> adjust the format first?"

## Phase 3: Google Calendar (Last 90 Days)

**Meeting history with attendee context.** Calendar events reveal who the user meets
with, how often, and in what context. Combined with contacts, this builds a rich
relationship map.

### Fetch events

Via the host's Calendar connector, query ALL connected calendar accounts:
events from the last 90 days to now, expanded to single events, ordered by
start time.

### Brain structure

Follow the three-tier calendar architecture:
```
daily/calendar/
├── calendar-log              ← compiled truth (patterns, key people)
├── YYYY/
│   ├── YYYY-MM               ← monthly summary
│   └── YYYY-MM-DD            ← daily event log
```

### Entity enrichment

For each event with attendees:
1. Look up each attendee in the brain (they should exist from Phase 2)
2. `add_timeline_event` on their page: met at [event title] on [date]
3. If an attendee has no brain page and appears in 3+ events, create one
4. `link` attendees who appear in the same meeting

## Phase 4: Gmail (Recent Threads)

**Relationship context and active threads.** Email reveals organizational
relationships, ongoing conversations, and communication patterns.

### Strategy: Smart sampling, not bulk import

Don't import every email. Import the **signal**:

1. **Sent mail (last 30 days)** — who the user actively communicates with
2. **Starred/important emails** — user-curated signal
3. **Threads with 3+ replies** — active conversations worth tracking
4. **Emails from people already in the brain** — enrichment, not cold import

### Processing

For each email thread:
1. **Entity detection** — extract people, companies mentioned
2. **Update people pages** — add communication context to the timeline
   (`add_timeline_event`)
3. **Create meeting pages** — if the email is a meeting summary or follow-up
4. **Skip noise** — newsletters, automated notifications, marketing

### Filtering rules

**Auto-skip (never import):**
- noreply@, no-reply@, notifications@, support@, mailer-daemon@
- Unsubscribe-heavy senders (marketing)
- GitHub/Jira/Linear notification emails
- Calendar invites (already captured in Phase 3)

**Always import:**
- Direct emails from people in the brain
- Starred/flagged emails
- Emails the user sent (their words are highest-value signal)

## Phase 5: Conversation Exports (AI Chat History)

**Your thinking, captured.** AI conversation exports reveal what the user
was researching, building, and thinking about. This is original thinking
preserved in dialog form.

### Supported formats

- **ChatGPT:** Settings → Data Controls → Export → `conversations.json`
- **Claude:** Download from claude.ai conversation history
- **Other assistants:** whatever export their settings offer

### Processing

For each conversation:
1. **Assess significance** (1-5 scale):
   - 1 = Pure utility (how-tos, quick lookups) → skip or minimal page
   - 2 = Minor context → 1-paragraph note
   - 3 = Notable (reveals interests, building something) → full page
   - 4 = Important (deep personal processing, strategic thinking) → rich page
   - 5 = Defining (identity work, breakthrough insights) → full treatment
2. **Extract entities** — people, companies, concepts discussed
3. **Capture original thinking** — the user's exact phrasing is the signal.
   Never paraphrase.
4. **File by primary subject** — not in a "conversations/" dump. A conversation
   about a person goes to people/, about a concept goes to concepts/, etc.
   (Consult `skills/brain-taxonomist` for the gate.)

### Quality rule

Only import conversations rated 3+. The brain is for signal, not noise.

## Phase 6: X/Twitter Archive

**Your public positions and engagement patterns.** Twitter reveals what the user
thinks, who they engage with, and what ideas they're developing publicly.

### Data sources

1. **Twitter data export** (Settings → Your Account → Download Archive)
   - Contains all tweets, likes, DMs, bookmarks
2. **Live lookups** (via the agent's web search tooling) — recent tweets and engagement
3. **Bookmarks** — curated signal, high value

### Brain structure

```
media/x/{handle}/
├── x-log                     ← compiled truth (themes, voice, key threads)
├── daily/YYYY-MM-DD          ← daily tweet log
├── monthly/YYYY-MM           ← monthly rollup
└── bookmarks/                ← saved/bookmarked content
```

### Processing

- **Original tweets** → capture with full context, extract entities
- **Quote tweets** → capture the user's commentary + the source tweet
- **Threads** → reconstruct as a single narrative
- **Bookmarks** → high-signal curation, import with tags (`add_tag`)
- **Likes** — low signal, skip unless the user wants them

## Phase 7: File Archives

**Historical documents, old writing, photos with metadata.** This is the long tail —
less structured but potentially very high value (old journals, letters, early writing).

Delegate to the `skills/archive-crawler` skill. It handles:
- Crawling directory structures
- Filtering for high-value content (user's own writing, not installers)
- Text extraction from PDFs, images (OCR), documents
- Entity extraction and brain page creation

> **Safety gate:** Archive crawling can be slow and create many pages. Always start
> with a scan-only pass, and run the long crawl as a durable server-side job
> (`jobs_submit`, monitor with `jobs_get` / `jobs_logs`) rather than blocking the
> session. Show the user the scan manifest before proceeding with full ingestion.

**Supported sources:**
- Local directories (Dropbox sync folder, Google Drive, old hard drives)
- Cloud storage (S3-compatible) via mounted paths
- Email archives (PST, mbox, EML, Google Takeout)
- Data exports (LinkedIn, Facebook, etc.)

## Phase 8: Meeting Transcripts

**Deep relationship context from recorded calls.** If the user has a meeting
recording service (Otter, Fireflies, Read.ai, etc.), import recent
transcripts.

Delegate to the `skills/meeting-ingestion` skill. Key rules:
- Always pull the **complete transcript**, not just the AI summary
- Entity propagation is MANDATORY — every attendee gets a timeline update
- A meeting is NOT fully ingested until all entity pages are updated

## Post-Bootstrap Checklist

After completing available phases:

1. **Verify brain health:**
   ```bash
   memex doctor
   memex status
   ```
   (or `run_doctor` + `stats` + `sources_status` over MCP)

2. **Test retrieval:**
   ```
   query "who do I meet with most often?"
   query "what am I working on?"
   search "<person from contacts>"
   ```

3. **Set up live sync** (if not already):
   - Calendar / email sweeps: host systemd timers driving the connector
     imports (daily, and every 4-8 hours respectively)
   - X: daily ingest
   - Notes vault: periodic `memex index` re-run of the vault path — the
     brain's background cycle handles derivation after each index
   - Watch `sources_status` to confirm each source stays fresh

4. **Track state** in the brain page `tasks/cold-start-state` (via `page_put`):
   ```json
   {
     "started": "2026-01-15T10:00:00Z",
     "credential_gateway": "host-managed-connectors",
     "phases_completed": [1, 2, 3, 4],
     "phases_skipped": [6, 7],
     "total_pages_created": 847,
     "total_entities_linked": 1203,
     "next_phase": 5
   }
   ```

5. **Tell the user what to do next:**
   > "Your brain has N pages across people, calendar, email, and conversations.
   > Live sync is configured for [sources]. From here:
   > - The **signal-detector** captures entities from every conversation
   > - The **briefing** skill can compile daily context
   > - The **executive-assistant** pattern handles email triage
   > - Say 'enrich [person]' to deep-dive any contact"

## Anti-Patterns

- **Giving the agent raw OAuth tokens.** This is the #1 anti-pattern. An agent with
  raw Gmail/Calendar tokens is an uncontrolled attack surface — one prompt injection
  and your entire Google account is exposed. Use the host's managed connectors. If
  the user declines, skip to offline imports. Never offer direct OAuth as a fallback.
- **Bulk importing everything without filtering.** The brain is for signal, not noise.
  Filter out automated senders, marketing emails, utility conversations.
- **Importing without entity cross-linking.** Every import should detect entities and
  update existing brain pages. Isolated imports don't compound.
- **Not gating on user consent.** Every phase should be presented as a choice. The user
  may not want their DMs or therapy conversations imported.
- **Importing everything at significance 1.** Not every conversation is worth a brain
  page. Use the significance scale and skip utility content.
- **Creating people pages for automated senders.** Sentry, GitHub notifications,
  newsletter platforms are not people. Filter by the rules in Phase 4.

## Resume Protocol

If the session is interrupted:

1. `page_get tasks/cold-start-state`
2. Skip completed phases
3. Resume from `next_phase`
4. The user doesn't have to repeat connector setup or re-import completed sources

## Output Format

After each phase:

```
PHASE N COMPLETE: [source name]
================================

Pages created: N
Pages updated: N
Entities linked: N
Time elapsed: N min

Sample pages:
- people/jane-smith (created — 3 emails, 5 meetings)
- companies/acme-corp (updated — 2 new employees linked)

Next: Phase N+1 — [description]. Ready to proceed?
```

## Tools Used

- `search` — check for existing pages before creating
- `query` — hybrid search for entity deduplication
- `page_get` — read existing pages for merge decisions
- `page_put` — create and update brain pages
- `link` — cross-reference entities
- `add_timeline_event` — record events on entity timelines
- `index` (or `memex index`) — pull file-based sources into the brain; the
  background cycle handles derivation after each phase

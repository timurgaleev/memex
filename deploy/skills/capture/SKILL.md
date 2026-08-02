---
name: capture
description: Save any thought or content into the brain via one CLI command. The single human-facing entrypoint that replaces "page_put vs index-then-verify" decisions with one command that just works.
triggers:
  - "capture this"
  - "save this thought"
  - "remember this"
  - "ingest this into my brain"
  - "drop this in the inbox"
  - "save to brain"
tools:
  - page_put
  - search
  - query
writes_pages:
  - "inbox/*"
---

# capture — the single ingestion entrypoint

When the user wants to save a thought, an article snippet, a transcript
fragment, or any text into their brain, run `memex capture`. Don't reach
for a raw `page_put` from the shell — `capture` is the front door and it
handles slugging, frontmatter, and the receipt for you.

## Contract

- **Input:** the content to save (inline arg, `--file PATH`, or `--stdin`).
- **Output:** a page in the brain DB. The brain is DB-canonical — the page
  IS the artifact; there is no companion file on disk. Receipt printed to
  stdout.
- **Side effect:** the page becomes immediately queryable via `query`,
  `search`, or any MCP-bound agent.
- **Idempotency:** same content → same `inbox/YYYY-MM-DD-<hash8>` slug.
  Content-hash dedup catches re-captures.
- **Trust:** all captures via this skill are local-CLI trust. Untrusted
  remote ingestion goes through the public MCP ingress with its own
  redaction and write-allowlist, not this verb.

## When to invoke

- "Capture this thought" / "save this" / "drop this into my brain" / "remember this"
- The user pastes content and asks to keep it
- After a meeting summary, a research note, or any synthesis that should land as a brain page

## What it does

`memex capture` resolves to a `page_put` call against the brain. The page
lands in the DB in one move and is indexed for retrieval. The default slug
is `inbox/YYYY-MM-DD-<hash8>` so captures cluster in a predictable triage
location. From an MCP client (no shell), the equivalent is a direct
`page_put` with an `inbox/` slug and the same frontmatter stamps.

## How to use

```bash
memex capture "the thought I want to remember"
memex capture --file ./notes/today.md
echo "from a pipe" | memex capture --stdin
memex capture "..." --slug daily/2026-05-21
memex capture "..." --type idea --source voice-whisper
memex capture "..." --quiet          # script-friendly: prints just the slug
memex capture "..." --json           # structured output for agents
```

## Defaults

- **Slug:** `inbox/YYYY-MM-DD-<hash8>` (stable for same content; content-hash dedup catches re-captures).
- **Type:** `note` (override with `--type idea` etc.).
- **Frontmatter stamps:** `captured_via: capture-cli`, `captured_at: <ISO>`.
- **Title:** first non-empty line of the body, capped at 80 chars (truncation appends `…`).

## Output Format

Default prints a receipt:

```
captured:
  slug:          inbox/2026-05-21-abcdef12
  status:        created_or_updated
  content_hash:  f3a7b9c0d1e2f3a4…
  captured_at:   2026-05-21T04:15:00.000Z
```

`--quiet` prints only the slug (use for `SLUG=$(memex capture "..." --quiet)`).
`--json` prints structured output for downstream tools.

## Anti-Patterns

- **Don't hand-roll a `memex call page_put` for a quick thought.** That's the
  raw per-page primitive; it doesn't know about default slug generation,
  content-type heuristics, or the receipt block. `capture` is the
  human-facing wrapper.
- **Don't try to bulk-import dozens of files by looping over `memex capture`.**
  That's what `memex index` is for. Capture is for single thoughts, single
  notes, single transcripts.
- **Don't pre-format the content yourself with frontmatter if you don't need to.**
  Capture wraps plain prose in sensible frontmatter (type + title +
  captured_via + captured_at). The body becomes `# Title\n\n<your prose>`.
  Pass `--file PATH` if you already have a fully-formatted markdown file.
- **Don't pass secrets as inline content.** Inline args land in shell
  history. Use `--file` or `--stdin` instead.

## When NOT to use this skill

- Bulk ingestion of many files → `skills/media-ingest/SKILL.md` or `memex index` instead
- Article/link with author + publication metadata → `skills/idea-ingest/SKILL.md` (it knows to build the people page)
- Meeting transcripts → `skills/meeting-ingestion/SKILL.md` (attendee enrichment)

This skill is for the simple "I have a thought, save it" case. Specialized
ingestion paths handle their own slugging + cross-referencing.
